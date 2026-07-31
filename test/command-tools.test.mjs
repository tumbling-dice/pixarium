import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { executeWorkerCommand, formatCommandExecutionResult } from "../dist/command-executor.js";
import { registerCommandTools } from "../dist/pi-command-extension.js";
import { loadWorkerDefinition, normalizeCommandToolName } from "../dist/worker-loader.js";

/**
 * command testごとにfilesystem状態を分離する。
 * @returns 新規一時directory。
 */
async function temporaryDirectory() {
  return mkdtemp(path.join(tmpdir(), "pixarium-command-tools-"));
}

/**
 * worker.yamlだけを必要とするschema test用locationを作る。
 * @param source worker.yamlへ書くYAML。
 * @returns loadWorkerDefinitionへ渡せるlocal location。
 */
async function workerLocationWithYaml(source) {
  const root = await temporaryDirectory();
  const directoryPath = path.join(root, "sample");
  await mkdir(directoryPath);
  const configPath = path.join(directoryPath, "worker.yaml");
  await writeFile(configPath, source);
  return {
    scope: "local",
    directoryName: "sample",
    directoryPath,
    configPath,
  };
}

/** Worker schemaの必須fieldを揃え、commandsだけをcaseごとに差し替えるYAML前半。 */
const WORKER_YAML_PREFIX = `name: sample
description: command test
model: openai/test
thinking: high
systemPrompt: ./SYSTEM.md
skill: ./skill/SKILL.md
tools:
  - read
`;

/**
 * Extension APIの登録面だけを再現し、Workerごとのtool集合を観測する。
 * @returns 登録toolを保持するfake APIと配列。
 */
function commandToolRegistry() {
  const tools = [];
  return {
    tools,
    pi: {
      /** @param tool Extensionが登録する一つのtool定義。 */
      registerTool(tool) {
        tools.push(tool);
      },
    },
  };
}

/**
 * 目的: toolsだけの従来Workerと二種類のcommand定義を同じschemaで読み込めることを保証する。
 * 対象: loadWorkerDefinitionのcommands省略、fixed args、passthrough arguments。
 * 前提: promptとSkill参照の実在検査はvalidateWorker側の責務なので、このtestではschemaだけを読む。
 */
test("worker definitions parse omitted, fixed, and passthrough commands", async () => {
  const withoutCommands = await loadWorkerDefinition(
    await workerLocationWithYaml(WORKER_YAML_PREFIX),
  );
  assert.equal(withoutCommands.commands, undefined);

  const withCommands = await loadWorkerDefinition(
    await workerLocationWithYaml(`${WORKER_YAML_PREFIX}commands:
  - name: unit-test
    executable: ./gradlew
    args: [test]
  - name: git
    executable: git
    arguments: passthrough
`),
  );
  assert.deepEqual(withCommands.commands?.[0]?.args, ["test"]);
  assert.equal(withCommands.commands?.[1]?.arguments, "passthrough");
});

/**
 * 目的: 曖昧または衝突するcommand設定をPi起動前に拒否することを保証する。
 * 対象: arguments/args排他、元名重複、正規化後重複、builtin名衝突、YAML構文error。
 * 前提: 各caseは一つ以上のschema issueを含み、loadWorkerDefinitionがPixariumErrorへ整形する。
 */
test("worker definitions reject invalid command configurations", async () => {
  const invalidSources = [
    `${WORKER_YAML_PREFIX}commands:
  - name: git
    executable: git
    arguments: passthrough
    args: [status]
`,
    `${WORKER_YAML_PREFIX}commands:
  - name: git
    executable: git
  - name: git
    executable: git
`,
    `${WORKER_YAML_PREFIX}commands:
  - name: unit-test
    executable: ./gradlew
  - name: unit_test
    executable: ./gradlew
`,
    `${WORKER_YAML_PREFIX}commands:
  - name: read
    executable: printf
`,
    "name: [unterminated\n",
  ];
  for (const source of invalidSources) {
    await assert.rejects(loadWorkerDefinition(await workerLocationWithYaml(source)));
  }
});

/**
 * 目的: 人間向けcommand名が予測可能なPi tool名へ変換されることを保証する。
 * 対象: normalizeCommandToolNameの小文字化、separator置換、端の除去。
 * 前提: schemaは正規化結果が空になる名前を別途拒否する。
 */
test("command tool names normalize to snake case", () => {
  assert.equal(normalizeCommandToolName("Unit-Test command"), "unit_test_command");
});

/**
 * 目的: passthrough引数をshell解釈せず、そのまま実行fileへ渡すことを保証する。
 * 対象: executeWorkerCommandのargs配列とshell:false相当のprocess境界。
 * 前提: Node自身を実行fileにし、shellなら展開される記号をargvとして出力する。
 */
test("passthrough commands preserve argument boundaries without shell expansion", async () => {
  const projectRoot = await temporaryDirectory();
  const marker = path.join(projectRoot, "must-not-exist");
  const dangerousLiteral = `$(touch ${marker})`;
  const result = await executeWorkerCommand(
    {
      name: "node",
      executable: process.execPath,
      arguments: "passthrough",
    },
    ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", dangerousLiteral],
    { projectRoot },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), [dangerousLiteral]);
  await assert.rejects(readFile(marker));
});

/**
 * 目的: 固定引数、cwd、stdout、stderr、非ゼロ終了codeを一つの構造化結果へ保持することを保証する。
 * 対象: executeWorkerCommandのfixed command実行とformatCommandExecutionResult。
 * 前提: Node fixtureは指定cwdを出力し、stderrを書いてcode 7で終了する。
 */
test("fixed commands capture cwd, output, and nonzero exit codes", async () => {
  const projectRoot = await temporaryDirectory();
  const workingDirectory = path.join(projectRoot, "nested");
  await mkdir(workingDirectory);
  const definition = {
    name: "fixed-check",
    executable: process.execPath,
    args: [
      "-e",
      "process.stdout.write(process.cwd()); process.stderr.write('diagnostic'); process.exitCode = 7",
    ],
    workingDirectory: "nested",
  };
  const result = await executeWorkerCommand(definition, ["ignored"], { projectRoot });
  assert.equal(result.cwd, workingDirectory);
  assert.equal(result.stdout, workingDirectory);
  assert.equal(result.stderr, "diagnostic");
  assert.equal(result.exitCode, 7);
  assert.match(formatCommandExecutionResult(definition, result), /Command tool: fixed-check/);
});

/**
 * 目的: 実行fileを開始できない設定へWorker名、実行file、cwdを含む診断を返すことを保証する。
 * 対象: executeWorkerCommandのspawn error分類。
 * 前提: fixtureの実行file名は一時directory内に存在しない。
 */
test("commands report contextual executable launch errors", async () => {
  const projectRoot = await temporaryDirectory();
  await assert.rejects(
    executeWorkerCommand(
      { name: "missing-command", executable: "./does-not-exist", args: [] },
      [],
      { projectRoot },
    ),
    (error) => {
      assert.match(error.message, /missing-command/);
      assert.match(error.message, /\.\/does-not-exist/);
      assert.match(error.message, new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    },
  );
});

/**
 * 目的: command単位のtimeoutでprocessを停止し、結果へtimeout状態を残すことを保証する。
 * 対象: executeWorkerCommandのtimeout timerとSIGTERM終了。
 * 前提: fixture processの待機時間は設定timeoutより十分長い。
 */
test("commands terminate on timeout", async () => {
  const projectRoot = await temporaryDirectory();
  const result = await executeWorkerCommand(
    {
      name: "slow",
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5000)"],
      timeoutSeconds: 1,
    },
    [],
    { projectRoot },
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGTERM");
});

/**
 * 目的: command出力が設定上限を超えてPi contextへ流入しないことを保証する。
 * 対象: stdout/stderr共通byte budgetとtruncated flag。
 * 前提: ASCII出力だけを使い、byte数と文字数を一致させる。
 */
test("command output is truncated at the configured byte limit", async () => {
  const projectRoot = await temporaryDirectory();
  const result = await executeWorkerCommand(
    {
      name: "verbose",
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(100))"],
      maxOutputBytes: 12,
    },
    [],
    { projectRoot },
  );
  assert.equal(result.stdout, "x".repeat(12));
  assert.equal(result.truncated, true);
});

/**
 * 目的: Extension登録状態が呼出しごとに新規作成され、別Workerのcommandを共有しないことを保証する。
 * 対象: registerCommandToolsのWorker固有tool生成とfixed/passthrough parameter schema。
 * 前提: 各fake APIは独立したPi process相当のregistryを持つ。
 */
test("command tools are isolated per worker registration", () => {
  const workerA = commandToolRegistry();
  const workerB = commandToolRegistry();
  registerCommandTools(workerA.pi, {
    projectRoot: "/project",
    commands: [{ name: "git", executable: "git", arguments: "passthrough" }],
  });
  registerCommandTools(workerB.pi, {
    projectRoot: "/project",
    commands: [{ name: "unit-test", executable: "./gradlew", args: ["test"] }],
  });
  assert.deepEqual(
    workerA.tools.map((tool) => tool.name),
    ["git"],
  );
  assert.deepEqual(
    workerB.tools.map((tool) => tool.name),
    ["unit_test"],
  );
  assert.deepEqual(Object.keys(workerA.tools[0].parameters.properties), ["args"]);
  assert.deepEqual(Object.keys(workerB.tools[0].parameters.properties), []);
  assert.equal(workerA.tools[0].parameters.additionalProperties, false);
  assert.equal(workerB.tools[0].parameters.additionalProperties, false);
});
