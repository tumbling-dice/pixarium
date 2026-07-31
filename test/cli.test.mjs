import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

/** callback形式のexecFileをtest fixtureからawait可能にする関数。 */
const execFileAsync = promisify(execFile);
/** build済みCLIとfixtureをrepository相対で解決するためのproject root。 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** child processとして検証するbuild済みPixarium CLIのpath。 */
const cli = path.join(projectRoot, "dist", "cli.js");
/** 実LLM APIを呼ばずPiのRPCと終了状態を再現するfixture path。 */
const fakePi = path.join(projectRoot, "test", "fake-pi.mjs");

/**
 * test状態を相互分離する一時directoryを作る。
 * @param prefix directoryの用途を識別する短い名前。
 * @returns 作成した一時directory path。
 */
async function temporaryDirectory(prefix) {
  return mkdtemp(path.join(tmpdir(), `pixarium-${prefix}-`));
}

/**
 * local Worker commandの前提となる空のGit repositoryを作る。
 * @param prefix 一時directoryの用途名。
 * @returns `git init`済みのrepository root。
 */
async function gitRepository(prefix = "repo") {
  const directory = await temporaryDirectory(prefix);
  await execFileAsync("git", ["init", "-q"], { cwd: directory });
  return directory;
}

/**
 * CLIを隔離したHOMEとcapture file付きで実行し、終了結果を収集する。
 * @param cwd CLI processの作業directory。
 * @param args CLIへ渡すcommand line引数。
 * @param options stdin、追加環境変数、test側timeout。
 * @returns exit codeとstdout/stderr全文。
 */
async function runCli(cwd, args, options = {}) {
  const captureDirectory = await temporaryDirectory("capture");
  const stdoutPath = path.join(captureDirectory, "stdout");
  const stderrPath = path.join(captureDirectory, "stderr");
  const stdinPath = path.join(captureDirectory, "stdin");
  if (options.input !== undefined) {
    await writeFile(stdinPath, options.input);
  }
  const [stdoutFile, stderrFile] = await Promise.all([
    open(stdoutPath, "w"),
    open(stderrPath, "w"),
  ]);
  const stdinFile = options.input !== undefined ? await open(stdinPath, "r") : undefined;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, HOME: captureDirectory, ...options.env },
      stdio: [stdinFile?.fd ?? "ignore", stdoutFile.fd, stderrFile.fd],
    });
    let timedOut = false;
    // 実装側timeoutが壊れた場合もtest suite自体が停止し続けないよう外側から上限を置く。
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeout ?? 10_000);
    child.once("close", async (code) => {
      clearTimeout(timer);
      await Promise.all([stdoutFile.close(), stderrFile.close(), stdinFile?.close()]);
      const [stdout, stderr] = await Promise.all([
        readFile(stdoutPath, "utf8"),
        readFile(stderrPath, "utf8"),
      ]);
      resolve({ code: timedOut ? -1 : (code ?? 1), stdout, stderr });
    });
  });
}

/**
 * attach/runsとの並行動作を検証するため、CLIを終了待ちせず起動する。
 * @param cwd CLI processの作業directory。
 * @param args CLIへ渡すcommand line引数。
 * @param options child processへ追加する環境変数。
 * @returns child processと、終了後のcapture結果を返すPromise。
 */
async function spawnRunningCli(cwd, args, options = {}) {
  const captureDirectory = await temporaryDirectory("running-capture");
  const stdoutPath = path.join(captureDirectory, "stdout");
  const stderrPath = path.join(captureDirectory, "stderr");
  const [stdoutFile, stderrFile] = await Promise.all([
    open(stdoutPath, "w"),
    open(stderrPath, "w"),
  ]);
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
  });
  const completion = new Promise((resolve) => {
    child.once("close", async (code) => {
      await Promise.all([stdoutFile.close(), stderrFile.close()]);
      const [stdout, stderr] = await Promise.all([
        readFile(stdoutPath, "utf8"),
        readFile(stderrPath, "utf8"),
      ]);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
  return { child, completion };
}

/**
 * 非同期に登録されるrunがruns commandから観測可能になるまで待つ。
 * @param cwd runs commandを実行するrepository root。
 * @param home run processと共有するHOME。
 * @returns 最初に観測したactive run。
 */
async function waitForActiveRun(cwd, home) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await runCli(cwd, ["runs", "--json"], { env: { HOME: home } });
    if (result.code === 0 && JSON.parse(result.stdout).length > 0) {
      return JSON.parse(result.stdout)[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("active run did not appear");
}

/**
 * contextFilesを省略するfixtureと明示するfixtureで同じYAML形式を共有する。
 * @param mode Workerへ設定するcontext file mode。undefinedはfield省略を表す。
 * @returns 指定時だけ末尾改行を含むworker.yamlの一行。
 */
function contextFilesYaml(mode) {
  return mode === undefined ? "" : `contextFiles: ${mode}\n`;
}

/**
 * test用Worker定義を、個別caseで上書き可能なYAMLとして生成する。
 * @param name worker.yamlへ記載するWorker名。
 * @param overrides default設定を置換するfield群。
 * @returns worker.yamlの内容。
 */
function workerYaml(name, overrides = {}) {
  const values = {
    name,
    description: `Description for ${name}`,
    model: "openai/test-model",
    thinking: "high",
    systemPrompt: "./SYSTEM.md",
    skill: "./skill/SKILL.md",
    tools: ["read", "grep", "find", "ls"],
    contextFiles: undefined,
    timeoutSeconds: 300,
    ...overrides,
  };
  return `name: ${values.name}
description: ${values.description}
model: ${values.model}
thinking: ${values.thinking}
systemPrompt: ${values.systemPrompt}
skill: ${values.skill}
tools:
${values.tools.map((tool) => `  - ${tool}`).join("\n")}
${contextFilesYaml(values.contextFiles)}timeoutSeconds: ${values.timeoutSeconds}
`;
}

/**
 * fake Piの記録から初期prompt command本文を取り出す。
 * @param invocation fake Piが永続化した起動記録。
 * @returns prompt commandが持つmessage。存在しなければundefined。
 */
function rpcPrompt(invocation) {
  return invocation.commands.find((command) => command.type === "prompt")?.message;
}

/**
 * local Workerの設定、system prompt、Skillをrepositoryへ作る。
 * @param repository Workerを置くGit repository root。
 * @param name Worker directoryと既定設定に使う名前。
 * @param overrides 不正caseや継承caseを作るための上書き値。
 * @returns 作成したWorker directory path。
 */
async function createWorker(repository, name, overrides = {}) {
  const directory = path.join(repository, ".pixarium", "workers", name);
  await mkdir(path.join(directory, "skill"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(directory, "worker.yaml"),
      overrides.rawYaml ?? workerYaml(name, overrides),
    ),
    writeFile(
      path.join(directory, "SYSTEM.md"),
      overrides.systemPromptContent ?? `System prompt for ${name}\n`,
    ),
    writeFile(
      path.join(directory, "skill", "SKILL.md"),
      overrides.skillContent ??
        `---
name: ${name}-skill
description: Skill for ${name}.
---

# Steps

1. Inspect the repository.
`,
    ),
  ]);
  return directory;
}

/**
 * 継承test用のglobal base一式を隔離HOMEへ作る。
 * @param home global Worker rootを決めるtest用HOME。
 * @param name base Worker名。
 * @param overrides timeoutやfile内容の上書き値。
 * @returns 作成したbase directory path。
 */
async function createGlobalBase(home, name, overrides = {}) {
  const directory = path.join(home, ".pixarium", "workers", name);
  await mkdir(path.join(directory, "skill"), { recursive: true });
  const rawYaml =
    overrides.rawYaml ??
    `name: ${name}
kind: base
description: Shared base for ${name}
model: openai/base-model
thinking: high
systemPrompt: ./SYSTEM.md
skill: ./skill/SKILL.md
tools:
  - read
  - grep
  - find
  - ls
${contextFilesYaml(overrides.contextFiles)}timeoutSeconds: ${overrides.timeoutSeconds ?? 240}
`;
  await Promise.all([
    writeFile(path.join(directory, "worker.yaml"), rawYaml),
    writeFile(
      path.join(directory, "SYSTEM.md"),
      overrides.systemPromptContent ?? `Global system prompt for ${name}\n`,
    ),
    writeFile(
      path.join(directory, "skill", "SKILL.md"),
      overrides.skillContent ??
        `---
name: ${name}-base-skill
description: Shared workflow for ${name}.
---

# Shared steps

1. Apply the global workflow.
`,
    ),
  ]);
  return directory;
}

/**
 * scope優先順位test用の単体global Workerを隔離HOMEへ作る。
 * @param home global Worker rootを決めるtest用HOME。
 * @param name global Worker名。
 * @param overrides Worker設定やfile内容の上書き値。
 * @returns 作成したWorker directory path。
 */
async function createGlobalWorker(home, name, overrides = {}) {
  const directory = path.join(home, ".pixarium", "workers", name);
  await mkdir(path.join(directory, "skill"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(directory, "worker.yaml"),
      overrides.rawYaml ?? workerYaml(name, overrides),
    ),
    writeFile(
      path.join(directory, "SYSTEM.md"),
      overrides.systemPromptContent ?? `Global system prompt for ${name}\n`,
    ),
    writeFile(
      path.join(directory, "skill", "SKILL.md"),
      overrides.skillContent ??
        `---
name: ${name}-global-skill
description: Global Skill for ${name}.
---

# Global steps

1. Apply the global worker.
`,
    ),
  ]);
  return directory;
}

await chmod(fakePi, 0o755);

/**
 * 目的: initが検証可能な雛形を作り、既存Workerを上書きしないことを保証する。
 * 対象: `pixarium init`のlocal Worker作成と重複作成時の保護。
 * 前提: 空のGit repositoryにreviewer Workerがまだ存在しない。
 */
test("init creates a valid worker template without overwriting it", async () => {
  const repository = await gitRepository("init");
  const first = await runCli(repository, ["init", "reviewer"]);
  assert.equal(first.code, 0, first.stderr);
  const worker = path.join(repository, ".pixarium", "workers", "reviewer");
  assert.match(await readFile(path.join(worker, "worker.yaml"), "utf8"), /name: reviewer/);
  assert.match(await readFile(path.join(worker, "worker.yaml"), "utf8"), /contextFiles: disabled/);
  assert.match(await readFile(path.join(worker, "SYSTEM.md"), "utf8"), /# reviewer worker/);
  assert.match(
    await readFile(path.join(worker, "skill", "SKILL.md"), "utf8"),
    /name: reviewer-task/,
  );
  assert.equal((await runCli(repository, ["check", "reviewer"])).code, 0);

  await writeFile(path.join(worker, "SYSTEM.md"), "keep me\n");
  const second = await runCli(repository, ["init", "reviewer"]);
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /already exists/);
  assert.equal(await readFile(path.join(worker, "SYSTEM.md"), "utf8"), "keep me\n");
});

/**
 * 目的: path脱出を含む不正名とrepository外のlocal作成を拒否することを保証する。
 * 対象: initのWorker名検証とGit root検出。
 * 前提: 一方はGit repository内、もう一方はGit管理外の一時directoryで実行する。
 */
test("init rejects invalid names and non-Git directories", async () => {
  const repository = await gitRepository("invalid-name");
  const invalid = await runCli(repository, ["init", "../Reviewer"]);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /invalid worker name/);

  const outside = await temporaryDirectory("not-git");
  const result = await runCli(outside, ["init", "reviewer"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not inside a Git repository/);
});

/**
 * 目的: global baseをrepository外で作成し、check/listから参照できることを保証する。
 * 対象: `init --global --base`とglobal scopeのcheck/list出力。
 * 前提: 隔離HOMEを使用し、実行directoryはGit repositoryではない。
 */
test("init creates and checks a global base outside a Git repository", async () => {
  const outside = await temporaryDirectory("global-init");
  const home = await temporaryDirectory("global-home");
  const created = await runCli(outside, ["init", "--global", "--base", "evidence-reviewer"], {
    env: { HOME: home },
  });
  assert.equal(created.code, 0, created.stderr);
  const base = path.join(home, ".pixarium", "workers", "evidence-reviewer");
  assert.match(await readFile(path.join(base, "worker.yaml"), "utf8"), /kind: base/);
  assert.match(await readFile(path.join(base, "skill", "SKILL.md"), "utf8"), /shared workflow/i);

  const checked = await runCli(outside, ["check", "--global", "evidence-reviewer"], {
    env: { HOME: home },
  });
  assert.equal(checked.code, 0, checked.stderr);
  assert.equal(checked.stdout, "evidence-reviewer [global, base]: ok\n");

  const listed = await runCli(outside, ["list", "--global", "--json"], {
    env: { HOME: home },
  });
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout)[0], {
    name: "evidence-reviewer",
    kind: "base",
    scope: "global",
    description: "このbase Workerが提供する共通方針を記述する",
    model: "openai/model-name",
    thinking: "high",
    tools: ["read", "grep", "find", "ls"],
    contextFiles: "disabled",
  });
});

/**
 * 目的: authがrepositoryを要求せず、同梱認証CLIへ正しいOAuth引数を渡すことを保証する。
 * 対象: `pixarium auth`のPi認証process起動とstderr案内。
 * 前提: fake Piを認証CLIとして指定し、安全なcredential directoryを使用する。
 */
test("auth launches bundled Pi OAuth without requiring a Git repository", async () => {
  const outside = await temporaryDirectory("auth");
  const record = path.join(outside, "pi-record.json");
  const agentDirectory = path.join(outside, "pi-agent");
  const result = await runCli(outside, ["auth"], {
    env: {
      PIXARIUM_PI_AI_BIN: fakePi,
      PI_CODING_AGENT_DIR: agentDirectory,
      FAKE_PI_RECORD: record,
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /OpenAI Codex OAuth/);
  const invocation = JSON.parse(await readFile(record, "utf8"));
  assert.equal(invocation.cwd, agentDirectory);
  assert.deepEqual(invocation.args, ["login", "openai-codex"]);
});

/**
 * 目的: 認証CLIの非ゼロ終了をPixariumの失敗として報告することを保証する。
 * 対象: auth commandのPi終了code伝播。
 * 前提: fake Piが終了code 4を返す。
 */
test("auth reports a non-zero Pi exit", async () => {
  const outside = await temporaryDirectory("auth-exit");
  const result = await runCli(outside, ["auth"], {
    env: {
      PIXARIUM_PI_AI_BIN: fakePi,
      PI_CODING_AGENT_DIR: path.join(outside, "pi-agent"),
      FAKE_PI_EXIT_CODE: "4",
    },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /OAuth login exited with code 4/);
});

/**
 * 目的: Pixarium repository内へPi credentialを保存できないことを保証する。
 * 対象: auth commandのcredential directory保護検査。
 * 前提: PI_CODING_AGENT_DIRがproject root配下を指す。
 */
test("auth refuses to store credentials inside the Pixarium repository", async () => {
  const outside = await temporaryDirectory("auth-in-repository");
  const result = await runCli(outside, ["auth"], {
    env: {
      PIXARIUM_PI_AI_BIN: fakePi,
      PI_CODING_AGENT_DIR: path.join(projectRoot, ".pi", "agent"),
    },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /refusing to store Pi credentials inside protected directory/);
});

/**
 * 目的: modelsがrepository外でもPiのmodel一覧をstdoutへ透過することを保証する。
 * 対象: `pixarium models`の起動directory、引数、標準出力。
 * 前提: fake Piが固定model名を返し、呼出記録を保存する。
 */
test("models runs the bundled Pi model listing outside a Git repository", async () => {
  const outside = await temporaryDirectory("models");
  const record = path.join(outside, "pi-record.json");
  const result = await runCli(outside, ["models"], {
    env: {
      PIXARIUM_PI_BIN: fakePi,
      PI_CODING_AGENT_DIR: path.join(outside, "pi-agent"),
      FAKE_PI_RECORD: record,
      FAKE_PI_STDOUT: "openai/test-model\n",
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "openai/test-model\n");
  const invocation = JSON.parse(await readFile(record, "utf8"));
  assert.equal(invocation.cwd, outside);
  assert.deepEqual(invocation.args, ["--list-models"]);
});

/**
 * 目的: node_modulesのbin linkなしでも同梱packageのPi CLIを直接起動できることを保証する。
 * 対象: models commandのbundled Pi path解決。
 * 前提: PIXARIUM_PI_BIN overrideを空にし、install済みpackageを使用する。
 */
test("models starts the bundled Pi package without a node_modules bin link", async () => {
  const outside = await temporaryDirectory("models-package-cli");
  const result = await runCli(outside, ["models"], {
    env: {
      PIXARIUM_PI_BIN: "",
      PI_CODING_AGENT_DIR: path.join(outside, "pi-agent"),
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /No models available/);
});

/**
 * 目的: model一覧processの非ゼロ終了をCLI終了codeと診断へ反映することを保証する。
 * 対象: models commandのPi失敗処理。
 * 前提: fake Piが終了code 5を返す。
 */
test("models propagates a non-zero Pi exit", async () => {
  const outside = await temporaryDirectory("models-exit");
  const result = await runCli(outside, ["models"], {
    env: {
      PIXARIUM_PI_BIN: fakePi,
      PI_CODING_AGENT_DIR: path.join(outside, "pi-agent"),
      FAKE_PI_EXIT_CODE: "5",
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /model listing exited with code 5/);
});

/**
 * 目的: 複数Workerを人間向けとJSONの両形式で安定して列挙できることを保証する。
 * 対象: list commandの表示field、contextFiles既定値、名前順、`--json`切替。
 * 前提: contextFiles省略とdiscover指定を含む二つのvalid local Workerが存在する。
 */
test("list displays multiple workers and supports JSON", async () => {
  const repository = await gitRepository("list");
  await Promise.all([
    createWorker(repository, "reviewer"),
    createWorker(repository, "investigator", {
      thinking: "medium",
      tools: ["read", "find"],
      contextFiles: "discover",
    }),
  ]);
  const human = await runCli(repository, ["list"]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /reviewer[\s\S]*model: openai\/test-model/);
  assert.match(human.stdout, /investigator[\s\S]*context files: discover/);

  const json = await runCli(repository, ["list", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(
    JSON.parse(json.stdout).map((worker) => worker.name),
    ["investigator", "reviewer"],
  );
  assert.equal(
    JSON.parse(json.stdout).find((worker) => worker.name === "reviewer").contextFiles,
    "disabled",
  );
});

/**
 * 目的: Worker未登録と不正Workerを、成功空一覧と分類済み失敗として区別することを保証する。
 * 対象: list commandの空scope処理とvalidation診断。
 * 前提: 同じrepositoryを空状態、その後invalid thinking設定の状態で検査する。
 */
test("list clearly reports no workers and invalid workers", async () => {
  const empty = await gitRepository("empty-list");
  const none = await runCli(empty, ["list"]);
  assert.equal(none.code, 0);
  assert.match(none.stdout, /No workers found/);

  await createWorker(empty, "broken", { thinking: "extreme" });
  const broken = await runCli(empty, ["list"]);
  assert.notEqual(broken.code, 0);
  assert.match(broken.stderr, /worker\.yaml/);
  assert.match(broken.stderr, /thinking/);
});

/**
 * 目的: effective一覧では同名localがglobalを隠し、明示global実行はglobalを選ぶことを保証する。
 * 対象: Worker scopeの優先順位と`run --global`の明示解決。
 * 前提: local/globalに同名reviewer、globalだけにinvestigatorが存在する。
 */
test("effective lookup uses local workers before standalone global workers", async () => {
  const repository = await gitRepository("scope-priority");
  const home = await temporaryDirectory("scope-priority-home");
  await Promise.all([
    createGlobalWorker(home, "reviewer", { description: "Global reviewer" }),
    createGlobalWorker(home, "investigator", { description: "Global investigator" }),
    createWorker(repository, "reviewer", { description: "Local reviewer" }),
  ]);

  const listed = await runCli(repository, ["list", "--json"], { env: { HOME: home } });
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(
    JSON.parse(listed.stdout).map(({ name, scope, description }) => ({
      name,
      scope,
      description,
    })),
    [
      { name: "investigator", scope: "global", description: "Global investigator" },
      { name: "reviewer", scope: "local", description: "Local reviewer" },
    ],
  );

  const record = path.join(repository, "pi-record.json");
  const globalRun = await runCli(repository, ["run", "--global", "reviewer", "--task", "Review"], {
    env: {
      HOME: home,
      PIXARIUM_PI_BIN: fakePi,
      FAKE_PI_RECORD: record,
    },
  });
  assert.equal(globalRun.code, 0, globalRun.stderr);
  const invocation = JSON.parse(await readFile(record, "utf8"));
  assert.match(rpcPrompt(invocation), /^\/skill:reviewer-global-skill/);
});

/**
 * 目的: 必須fileと設定が揃うlocal Workerをcheckが成功として報告することを保証する。
 * 対象: check commandの代表的な成功経路とstdout形式。
 * 前提: default fixtureで作成したvalid reviewer Workerが存在する。
 */
test("check accepts a valid worker", async () => {
  const repository = await gitRepository("check-valid");
  await createWorker(repository, "reviewer");
  const result = await runCli(repository, ["check", "reviewer"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "reviewer [local, worker]: ok\n");
});

/**
 * 目的: timeout fieldの省略と明示nullを同じ無制限として解決することを保証する。
 * 対象: Worker schema defaultとlist JSONの実効timeout表現。
 * 前提: timeout省略Workerとnull指定Workerを同じrepositoryへ作る。
 */
test("omitted and null timeout values resolve to unlimited", async () => {
  const repository = await gitRepository("unlimited-timeout");
  await createWorker(repository, "omitted", {
    rawYaml: `name: omitted
description: No timeout field
model: openai/test-model
thinking: high
systemPrompt: ./SYSTEM.md
skill: ./skill/SKILL.md
tools:
  - read
`,
  });
  await createWorker(repository, "explicit", { timeoutSeconds: null });

  const result = await runCli(repository, ["list", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const workers = JSON.parse(result.stdout);
  assert.equal(workers.find((worker) => worker.name === "omitted").timeoutSeconds, null);
  assert.equal(workers.find((worker) => worker.name === "explicit").timeoutSeconds, null);
});

/**
 * 目的: localの明示nullがbaseの有限timeoutを上書きすることを保証する。
 * 対象: 継承時のnullable timeout優先規則。
 * 前提: timeout 30秒のglobal baseをlocal Workerが継承し、local側でnullを指定する。
 */
test("local null timeout overrides an inherited finite timeout", async () => {
  const repository = await gitRepository("unlimited-inherited-timeout");
  const home = await temporaryDirectory("unlimited-inherited-timeout-home");
  await createGlobalBase(home, "finite-base", { timeoutSeconds: 30 });
  await createWorker(repository, "reviewer", {
    rawYaml: `name: reviewer
description: Override the base timeout
extends: global:finite-base
systemPrompt: ./SYSTEM.md
skill: ./skill/SKILL.md
timeoutSeconds: null
`,
  });

  const result = await runCli(repository, ["list", "--json"], { env: { HOME: home } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].timeoutSeconds, null);
});

/** checkが拒否すべきWorker定義の対象条件、fixture作成処理、期待診断を対応付けるcase集合。 */
const invalidCases = [
  {
    label: "missing required field",
    setup: async (repository) =>
      createWorker(repository, "reviewer", {
        rawYaml: workerYaml("reviewer").replace(/^model:.*\n/m, ""),
      }),
    expected: /model/,
  },
  {
    label: "invalid thinking level",
    setup: async (repository) => createWorker(repository, "reviewer", { thinking: "extreme" }),
    expected: /thinking/,
  },
  {
    label: "invalid tool",
    setup: async (repository) =>
      createWorker(repository, "reviewer", { tools: ["read", "network"] }),
    expected: /tools\.1/,
  },
  {
    label: "missing referenced file",
    setup: async (repository) =>
      createWorker(repository, "reviewer", { systemPrompt: "./missing.md" }),
    expected: /does not exist/,
  },
  {
    label: "path outside worker directory",
    setup: async (repository) => {
      await createWorker(repository, "reviewer", {
        systemPrompt: "../outside.md",
      });
      await writeFile(path.join(repository, ".pixarium", "workers", "outside.md"), "outside\n");
    },
    expected: /outside worker directory/,
  },
  {
    label: "missing Skill frontmatter",
    setup: async (repository) =>
      createWorker(repository, "reviewer", {
        skillContent: "# No frontmatter\n",
      }),
    expected: /frontmatter is missing/,
  },
  {
    label: "missing Skill frontmatter description",
    setup: async (repository) =>
      createWorker(repository, "reviewer", {
        skillContent: "---\nname: review\n---\n\n# Review\n",
      }),
    expected: /requires a non-empty description/,
  },
  {
    label: "directory and worker names differ",
    setup: async (repository) =>
      createWorker(repository, "reviewer", {
        rawYaml: workerYaml("other"),
      }),
    expected: /does not match directory/,
  },
  {
    label: "invalid timeout",
    setup: async (repository) => createWorker(repository, "reviewer", { timeoutSeconds: 0 }),
    expected: /timeoutSeconds/,
  },
  {
    label: "invalid context file mode",
    setup: async (repository) =>
      createWorker(repository, "reviewer", { contextFiles: "sometimes" }),
    expected: /contextFiles/,
  },
];

for (const invalidCase of invalidCases) {
  /**
   * 目的: 各不正定義をcheckが成功扱いせず、原因fieldを含むWorker errorとして返すことを保証する。
   * 対象: Worker schema、参照file安全性、Skill frontmatter、名前整合性の各validation境界。
   * 前提: invalidCasesのsetupがreviewer Workerへ一つの対象不整合を作る。
   */
  test(`check rejects ${invalidCase.label}`, async () => {
    const repository = await gitRepository("check-invalid");
    await invalidCase.setup(repository);
    const result = await runCli(repository, ["check", "reviewer"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Worker definition error/);
    assert.match(result.stderr, invalidCase.expected);
  });
}

/**
 * 目的: runが検証済みWorker設定とtaskだけを固定Pi引数/RPCへ渡すことを保証する。
 * 対象: run commandのcwd、既定context無効化、model、thinking、tools、prompt、Skill、最終出力。
 * 前提: contextFilesを省略したlocal Workerと、呼出内容を記録するfake Piを使用する。
 */
test("run passes the fixed worker configuration and task to Pi", async () => {
  const repository = await gitRepository("run");
  const workerDirectory = await createWorker(repository, "reviewer", {
    model: "openai/fixed-model",
    thinking: "xhigh",
    tools: ["read", "grep", "ls"],
    systemPromptContent: "Only report verified findings.\n",
  });
  const record = path.join(repository, "pi-record.json");
  const result = await runCli(repository, ["run", "reviewer", "--task", "Review current changes"], {
    env: {
      PIXARIUM_PI_BIN: fakePi,
      FAKE_PI_RECORD: record,
      FAKE_PI_STDOUT: "worker answer\n",
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "worker answer\n");

  const invocation = JSON.parse(await readFile(record, "utf8"));
  assert.equal(invocation.cwd, repository);
  assert.deepEqual(invocation.args.slice(0, 6), [
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-approve",
  ]);
  const valueAfter = (flag) => invocation.args[invocation.args.indexOf(flag) + 1];
  assert.equal(valueAfter("--model"), "openai/fixed-model");
  assert.equal(valueAfter("--thinking"), "xhigh");
  assert.equal(valueAfter("--tools"), "read,grep,ls");
  assert.match(
    valueAfter("--system-prompt"),
    /Pixarium common system prompt[\s\S]*meaningful group of tool calls[\s\S]*Only report verified findings/,
  );
  assert.equal(valueAfter("--skill"), path.join(workerDirectory, "skill", "SKILL.md"));
  assert.equal(valueAfter("--mode"), "rpc");
  assert.equal(invocation.args.filter((arg) => arg === "--skill").length, 1);
  assert.equal(rpcPrompt(invocation), "/skill:reviewer-skill\n\nReview current changes");
});

/**
 * 目的: command付きWorkerだけが共通Extensionと専用tool allowlistをPi child processへ受け取ることを保証する。
 * 対象: run commandの--extension、--tools、Worker固有環境設定、bash非暗黙追加。
 * 前提: fake PiはExtensionを実行せず、起動引数と子process専用設定だけを記録する。
 */
test("run grants only configured command tools to the Pi process", async () => {
  const repository = await gitRepository("run-command-tools");
  await createWorker(repository, "test-fixer", {
    rawYaml: `${workerYaml("test-fixer", { tools: ["read", "grep"] })}commands:
  - name: git
    description: Inspect the Git repository
    executable: git
    arguments: passthrough
  - name: unit-test
    executable: ./gradlew
    args:
      - test
    workingDirectory: .
    timeoutSeconds: 30
    maxOutputBytes: 4096
`,
  });
  const record = path.join(repository, "pi-record.json");
  const result = await runCli(repository, ["run", "test-fixer", "--task", "Fix the tests"], {
    env: {
      PIXARIUM_PI_BIN: fakePi,
      FAKE_PI_RECORD: record,
    },
  });
  assert.equal(result.code, 0, result.stderr);

  const invocation = JSON.parse(await readFile(record, "utf8"));
  const valueAfter = (flag) => invocation.args[invocation.args.indexOf(flag) + 1];
  assert.equal(valueAfter("--tools"), "read,grep,git,unit_test");
  assert.equal(invocation.args.includes("--no-extensions"), true);
  assert.equal(path.basename(valueAfter("--extension")), "pi-command-extension.js");
  const commandConfig = JSON.parse(invocation.commandToolsConfig);
  assert.equal(commandConfig.projectRoot, repository);
  assert.deepEqual(
    commandConfig.commands.map((command) => command.name),
    ["git", "unit-test"],
  );
  assert.equal(valueAfter("--tools").split(",").includes("bash"), false);
});

/**
 * 目的: contextFiles discoverを選んだWorkerだけがPiのcontext file探索を有効にすることを保証する。
 * 対象: worker.yamlのcontextFilesとPi起動時の--no-context-files分岐。
 * 前提: discoverを明示したlocal Workerと、起動引数を記録するfake Piを使用する。
 */
test("run enables Pi context discovery only when configured", async () => {
  const repository = await gitRepository("run-context-files");
  await createWorker(repository, "reviewer", { contextFiles: "discover" });
  const record = path.join(repository, "pi-record.json");
  const result = await runCli(repository, ["run", "reviewer", "--task", "Review"], {
    env: {
      PIXARIUM_PI_BIN: fakePi,
      FAKE_PI_RECORD: record,
    },
  });
  assert.equal(result.code, 0, result.stderr);

  const invocation = JSON.parse(await readFile(record, "utf8"));
  assert.equal(invocation.args.includes("--no-context-files"), false);
});

/**
 * 目的: Piの途中eventをCLI回答へ混ぜず、最終assistant textだけをstdoutへ出すことを保証する。
 * 対象: run commandのstdout/stderr分離。
 * 前提: fake Piがtool eventと最終回答をRPC streamへ送る。
 */
test("run keeps Pi progress out of Codex output", async () => {
  const repository = await gitRepository("run-progress");
  await createWorker(repository, "reviewer", { timeoutSeconds: null });
  const result = await runCli(repository, ["run", "reviewer", "--task", "Review"], {
    env: {
      PIXARIUM_PI_BIN: fakePi,
      FAKE_PI_STDOUT: "final answer",
      FAKE_PI_TOOL: "read",
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "final answer\n");
  assert.equal(result.stderr, "");
});

/**
 * 目的: 実行中runの公開metadataとattach traceを確認し、終了後registryが消えることを保証する。
 * 対象: runs、attach、heartbeat registry、reasoning/tool/run_end描画、cleanup。
 * 前提: fake Piを遅延実行し、別CLI processからactive runへ接続する。
 */
test("runs lists active workers and attach follows the temporary trace", async () => {
  const repository = await gitRepository("run-attach");
  const home = await temporaryDirectory("run-attach-home");
  await createWorker(repository, "reviewer", { timeoutSeconds: null });
  const running = await spawnRunningCli(repository, ["run", "reviewer", "--task", "Review"], {
    env: {
      HOME: home,
      PIXARIUM_PI_BIN: fakePi,
      FAKE_PI_DELAY_MS: "1000",
      FAKE_PI_STDOUT: "final answer",
      FAKE_PI_THINKING: "Inspect the configured scope.",
      FAKE_PI_TOOL: "read",
      FAKE_PI_TOOL_PATH: "src/example.ts",
    },
  });
  const active = await waitForActiveRun(repository, home);
  assert.equal(active.worker, "reviewer");
  assert.equal(active.scope, "local");
  assert.equal("endpoint" in active, false);
  const registryEntry = JSON.parse(
    await readFile(
      path.join(
        tmpdir(),
        `pixarium-${process.getuid?.() ?? "user"}`,
        "runs",
        active.id,
        "metadata.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(registryEntry).sort(), [
    "heartbeatAt",
    "id",
    "pid",
    "scope",
    "startedAt",
    "version",
    "worker",
  ]);
  assert.doesNotMatch(JSON.stringify(registryEntry), /Review|Inspect the configured scope/);

  const attached = await runCli(repository, ["attach", active.id.slice(0, 8)], {
    env: { HOME: home },
    timeout: 5_000,
  });
  const completed = await running.completion;

  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(completed.stdout, "final answer\n");
  assert.equal(attached.code, 0, attached.stderr);
  assert.match(attached.stdout, /Attached to reviewer/);
  assert.match(attached.stdout, /\[task\] Review/);
  assert.match(attached.stdout, /\[reasoning\] Inspect the configured scope\./);
  assert.match(attached.stdout, /\[tool:start\] read path="src\/example\.ts"/);
  assert.match(attached.stdout, /\[tool:end\] read succeeded/);
  assert.match(attached.stdout, /\[run\] completed/);

  const noRuns = await runCli(repository, ["runs"], { env: { HOME: home } });
  assert.equal(noRuns.code, 0, noRuns.stderr);
  assert.equal(noRuns.stdout, "No active runs.\n");
});

/**
 * 目的: attachがbash command、成功code、boundedな先頭二行だけを表示することを保証する。
 * 対象: bash tool traceのdetail、exit code、output preview制限。
 * 前提: fake Piが三行出力を持つ成功bash eventを送る。
 */
test("attach shows a bash command, exit code, and two output lines", async () => {
  const repository = await gitRepository("run-attach-bash");
  const home = await temporaryDirectory("run-attach-bash-home");
  await createWorker(repository, "reviewer", { timeoutSeconds: null });
  const running = await spawnRunningCli(repository, ["run", "reviewer", "--task", "Review"], {
    env: {
      HOME: home,
      PIXARIUM_PI_BIN: fakePi,
      FAKE_PI_DELAY_MS: "1000",
      FAKE_PI_TOOL: "bash",
      FAKE_PI_TOOL_COMMAND: "git status --short",
      FAKE_PI_TOOL_OUTPUT: "first line\nsecond line\nthird line",
    },
  });
  const active = await waitForActiveRun(repository, home);

  const attached = await runCli(repository, ["attach", active.id.slice(0, 8)], {
    env: { HOME: home },
    timeout: 5_000,
  });
  const completed = await running.completion;

  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(attached.code, 0, attached.stderr);
  assert.match(attached.stdout, /\[tool:start\] bash command="git status --short"/);
  assert.match(attached.stdout, /\[tool:end\] bash succeeded exit=0/);
  assert.match(attached.stdout, /\[tool:output\] first line/);
  assert.match(attached.stdout, /\[tool:output\] second line/);
  assert.doesNotMatch(attached.stdout, /third line/);
});

/**
 * 目的: attachが失敗bashの非ゼロ終了codeと出力previewを保持することを保証する。
 * 対象: bash tool error traceのparseと描画。
 * 前提: fake Piが終了code 7を含む失敗tool resultを送る。
 */
test("attach shows a non-zero bash exit code", async () => {
  const repository = await gitRepository("run-attach-bash-failure");
  const home = await temporaryDirectory("run-attach-bash-failure-home");
  await createWorker(repository, "reviewer", { timeoutSeconds: null });
  const running = await spawnRunningCli(repository, ["run", "reviewer", "--task", "Review"], {
    env: {
      HOME: home,
      PIXARIUM_PI_BIN: fakePi,
      FAKE_PI_DELAY_MS: "2000",
      FAKE_PI_TOOL: "bash",
      FAKE_PI_TOOL_COMMAND: "git diff --check",
      FAKE_PI_TOOL_ERROR: "1",
      FAKE_PI_TOOL_EXIT_CODE: "7",
      FAKE_PI_TOOL_OUTPUT: "invalid whitespace",
    },
  });
  const active = await waitForActiveRun(repository, home);

  const attached = await runCli(repository, ["attach", active.id.slice(0, 8)], {
    env: { HOME: home },
    timeout: 5_000,
  });
  const completed = await running.completion;

  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(attached.code, 0, attached.stderr);
  assert.match(attached.stdout, /\[tool:end\] bash failed exit=7/);
  assert.match(attached.stdout, /\[tool:output\] invalid whitespace/);
});

/**
 * 目的: boundedなstdin JSON commandを実行中Workerへのsteeringとして受理することを保証する。
 * 対象: run commandのcontrol input、Pi steer RPC、diagnostic出力。
 * 前提: taskは`--task`で指定し、stdinには一件のvalid steer commandを渡す。
 */
test("run accepts a bounded steering message over stdin", async () => {
  const repository = await gitRepository("run-steering");
  const steeringRecord = path.join(repository, "steering.txt");
  await createWorker(repository, "reviewer", { timeoutSeconds: null });
  const result = await runCli(repository, ["run", "reviewer", "--task", "Review"], {
    input: `${JSON.stringify({ type: "steer", message: "Also inspect the migration." })}\n`,
    env: {
      PIXARIUM_PI_BIN: fakePi,
      FAKE_PI_DELAY_MS: "200",
      FAKE_PI_STEERING_RECORD: steeringRecord,
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /\[pixarium\] steering accepted/);
  assert.equal(await readFile(steeringRecord, "utf8"), "Also inspect the migration.");
});

/**
 * 目的: global baseとlocal Workerの設定、prompt、Skillを一般から具体の順に合成することを保証する。
 * 対象: extends解決、field override、contextFiles継承、system prompt/Skill layer順、Pi引数。
 * 前提: context探索を有効にしたglobal baseをrepository内local Workerがextend modeで継承する。
 */
test("run composes a global base with a local worker", async () => {
  const repository = await gitRepository("run-inherited");
  const home = await temporaryDirectory("run-inherited-home");
  const baseDirectory = await createGlobalBase(home, "review-base", {
    systemPromptContent: "Require evidence for every finding.\n",
    contextFiles: "discover",
  });
  const localDirectory = await createWorker(repository, "api-reviewer", {
    rawYaml: `name: api-reviewer
description: Review API changes for this project
extends: global:review-base
systemPrompt: ./SYSTEM.md
skill: ./skill/SKILL.md
skillMode: extend
tools:
  - read
  - bash
`,
    systemPromptContent: "Use this project's API compatibility rules.\n",
    skillContent: `---
name: api-review
description: Review this project's API changes.
---

# API review

1. Run the API compatibility checks.
`,
  });
  const record = path.join(repository, "pi-record.json");
  const result = await runCli(
    repository,
    ["run", "api-reviewer", "--task", "Review the API change"],
    {
      env: {
        HOME: home,
        PIXARIUM_PI_BIN: fakePi,
        FAKE_PI_RECORD: record,
      },
    },
  );
  assert.equal(result.code, 0, result.stderr);

  const invocation = JSON.parse(await readFile(record, "utf8"));
  const valueAfter = (flag) => invocation.args[invocation.args.indexOf(flag) + 1];
  assert.equal(valueAfter("--model"), "openai/base-model");
  assert.equal(valueAfter("--thinking"), "high");
  assert.equal(valueAfter("--tools"), "read,bash");
  assert.equal(invocation.args.includes("--no-context-files"), false);
  assert.equal(invocation.args.includes("--skill"), false);
  assert.match(
    valueAfter("--system-prompt"),
    /general to specific[\s\S]*Require evidence[\s\S]*API compatibility rules/,
  );

  const prompt = rpcPrompt(invocation);
  assert.match(prompt, /Skill layers are ordered from general to specific/);
  assert.ok(prompt.indexOf(path.join(baseDirectory, "skill")) < prompt.indexOf(localDirectory));
  assert.match(prompt, /Apply the global workflow[\s\S]*Run the API compatibility checks/);
  assert.match(prompt, /Review the API change$/);
});

/**
 * 目的: skillMode replaceがbase Skillを除外し、local SkillだけをPiへ渡すことを保証する。
 * 対象: 継承時のSkill置換規則と単一Skill起動形式。
 * 前提: global baseを継承するlocal Workerがlocal Skillとreplaceを指定する。
 */
test("skillMode replace excludes the inherited Skill", async () => {
  const repository = await gitRepository("run-replaced-skill");
  const home = await temporaryDirectory("run-replaced-skill-home");
  await createGlobalBase(home, "review-base");
  const localDirectory = await createWorker(repository, "reviewer", {
    rawYaml: `name: reviewer
description: Local reviewer
extends: global:review-base
skill: ./skill/SKILL.md
skillMode: replace
`,
  });
  const record = path.join(repository, "pi-record.json");
  const result = await runCli(repository, ["run", "reviewer", "--task", "Review"], {
    env: {
      HOME: home,
      PIXARIUM_PI_BIN: fakePi,
      FAKE_PI_RECORD: record,
    },
  });
  assert.equal(result.code, 0, result.stderr);

  const invocation = JSON.parse(await readFile(record, "utf8"));
  const valueAfter = (flag) => invocation.args[invocation.args.indexOf(flag) + 1];
  assert.equal(valueAfter("--skill"), path.join(localDirectory, "skill", "SKILL.md"));
  assert.equal(invocation.args.filter((arg) => arg === "--skill").length, 1);
  assert.equal(rpcPrompt(invocation), "/skill:reviewer-skill\n\nReview");
});

/**
 * 目的: baseとlocalを個別には読めても、継承後にcommandがbuiltin toolを上書きする構成を拒否することを保証する。
 * 対象: validateWorkerDefinitionの実効tool名衝突検査。
 * 前提: baseは`read` commandを持ち、local Workerはbuiltin `read`を配列全体として指定する。
 */
test("check rejects tool name collisions introduced by inheritance", async () => {
  const repository = await gitRepository("inherited-command-collision");
  const home = await temporaryDirectory("inherited-command-collision-home");
  await createGlobalBase(home, "command-base", {
    rawYaml: `name: command-base
kind: base
description: Base with a command
model: openai/base-model
thinking: high
systemPrompt: ./SYSTEM.md
skill: ./skill/SKILL.md
commands:
  - name: read
    executable: printf
`,
  });
  await createWorker(repository, "reviewer", {
    rawYaml: `name: reviewer
description: Local reviewer
extends: global:command-base
tools:
  - read
`,
  });
  const result = await runCli(repository, ["check", "reviewer"], { env: { HOME: home } });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /command "read" duplicates effective Pi tool name "read"/);
});

/**
 * 目的: 存在しない継承元とbaseでないglobal Workerをextends対象として拒否することを保証する。
 * 対象: Worker継承先の存在検査とkind検査。
 * 前提: missing target caseとstandalone global Worker target caseを順に作る。
 */
test("check rejects missing and non-base inheritance targets", async () => {
  const repository = await gitRepository("invalid-inheritance");
  const home = await temporaryDirectory("invalid-inheritance-home");
  await createWorker(repository, "missing-base", {
    rawYaml: `name: missing-base
description: Missing base
extends: global:not-installed
skill: ./skill/SKILL.md
`,
  });
  const missing = await runCli(repository, ["check", "missing-base"], {
    env: { HOME: home },
  });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /not-installed[\s\S]*worker\.yaml/);

  const globalDirectory = path.join(home, ".pixarium", "workers", "standalone");
  await mkdir(path.join(globalDirectory, "skill"), { recursive: true });
  await Promise.all([
    writeFile(path.join(globalDirectory, "worker.yaml"), workerYaml("standalone")),
    writeFile(path.join(globalDirectory, "SYSTEM.md"), "Global standalone\n"),
    writeFile(
      path.join(globalDirectory, "skill", "SKILL.md"),
      `---
name: standalone-skill
description: Standalone global worker.
---

# Standalone
`,
    ),
  ]);
  await createWorker(repository, "wrong-target", {
    rawYaml: `name: wrong-target
description: Wrong target
extends: global:standalone
skill: ./skill/SKILL.md
`,
  });
  const wrongKind = await runCli(repository, ["check", "wrong-target"], {
    env: { HOME: home },
  });
  assert.notEqual(wrongKind.code, 0);
  assert.match(wrongKind.stderr, /is not a base worker/);
});

/**
 * 目的: `--task`省略時にstdin全文をtrimしてWorker taskへ使うことを保証する。
 * 対象: run commandの標準入力task経路とPi prompt。
 * 前提: stdinがpipeとして空でないtaskを一行渡す。
 */
test("run reads a task from standard input", async () => {
  const repository = await gitRepository("stdin");
  await createWorker(repository, "investigator");
  const record = path.join(repository, "pi-record.json");
  const result = await runCli(repository, ["run", "investigator"], {
    input: "Trace the authentication path\n",
    env: { PIXARIUM_PI_BIN: fakePi, FAKE_PI_RECORD: record },
  });
  assert.equal(result.code, 0, result.stderr);
  const invocation = JSON.parse(await readFile(record, "utf8"));
  assert.equal(rpcPrompt(invocation), "/skill:investigator-skill\n\nTrace the authentication path");
});

/**
 * 目的: 空白しかないstdin taskをPi起動前に構成errorとして拒否することを保証する。
 * 対象: run commandのtask必須検証。
 * 前提: `--task`を省略し、stdinへ改行だけを渡す。
 */
test("run rejects an empty task", async () => {
  const repository = await gitRepository("empty-task");
  await createWorker(repository, "reviewer");
  const result = await runCli(repository, ["run", "reviewer"], { input: "\n" });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /task is empty/);
});

/**
 * 目的: 対象repository配下へPi credentialを保存できないことを保証する。
 * 対象: run commandのrepository root保護検査。
 * 前提: PI_CODING_AGENT_DIRが実行対象repository内を指す。
 */
test("run refuses a credential directory inside the target repository", async () => {
  const repository = await gitRepository("run-credentials");
  await createWorker(repository, "reviewer");
  const result = await runCli(repository, ["run", "reviewer", "--task", "task"], {
    env: {
      PIXARIUM_PI_BIN: fakePi,
      PI_CODING_AGENT_DIR: path.join(repository, ".pi", "agent"),
    },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /refusing to store Pi credentials inside protected directory/);
});

/**
 * 目的: global Worker領域を含むPixarium home配下へcredentialを保存できないことを保証する。
 * 対象: run commandのPixarium home保護検査。
 * 前提: PI_CODING_AGENT_DIRが隔離HOMEの`.pixarium`配下を指す。
 */
test("run refuses a credential directory inside the global Worker directory", async () => {
  const repository = await gitRepository("global-credentials");
  const home = await temporaryDirectory("global-credentials-home");
  await createWorker(repository, "reviewer");
  const result = await runCli(repository, ["run", "reviewer", "--task", "task"], {
    env: {
      HOME: home,
      PIXARIUM_PI_BIN: fakePi,
      PI_CODING_AGENT_DIR: path.join(home, ".pixarium", "credentials"),
    },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /refusing to store Pi credentials inside protected directory/);
});

/**
 * 目的: Piの一般・認証・model失敗を終了codeとstderr patternから正しく分類することを保証する。
 * 対象: run commandのPi failure分類と公開診断。
 * 前提: fake Piが同じ非ゼロcodeでstderrだけを三種類に変える。
 */
test("run propagates Pi failure and classifies authentication/model errors", async () => {
  const repository = await gitRepository("exit");
  await createWorker(repository, "reviewer");
  const common = { PIXARIUM_PI_BIN: fakePi, FAKE_PI_EXIT_CODE: "7" };

  const generic = await runCli(repository, ["run", "reviewer", "--task", "task"], {
    env: common,
  });
  assert.equal(generic.code, 1);
  assert.match(generic.stderr, /Pi exited with code 7/);

  const auth = await runCli(repository, ["run", "reviewer", "--task", "task"], {
    env: { ...common, FAKE_PI_STDERR: "API key missing\n" },
  });
  assert.match(auth.stderr, /Pi authentication error/);

  const model = await runCli(repository, ["run", "reviewer", "--task", "task"], {
    env: { ...common, FAKE_PI_STDERR: "Unknown model selected\n" },
  });
  assert.match(model.stderr, /Pi model error/);
});

/**
 * 目的: Worker設定timeout超過時にPiを停止し、外側test timeoutより前に診断を返すことを保証する。
 * 対象: run commandのtimeout timer、process停止、timeout分類。
 * 前提: Worker timeoutは1秒、fake Piの完了遅延は5秒にする。
 */
test("run terminates Pi when the worker timeout expires", async () => {
  const repository = await gitRepository("timeout");
  await createWorker(repository, "reviewer", { timeoutSeconds: 1 });
  const started = Date.now();
  const result = await runCli(repository, ["run", "reviewer", "--task", "wait"], {
    env: {
      PIXARIUM_PI_BIN: fakePi,
      FAKE_PI_DELAY_MS: "5000",
    },
    timeout: 5_000,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Pi timeout/);
  assert.ok(Date.now() - started < 4_000);
});
