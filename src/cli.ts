#!/usr/bin/env node
import { parseArgs } from "node:util";
import { attachRun } from "./commands/attach.js";
import { authenticatePi } from "./commands/auth.js";
import { checkWorkers } from "./commands/check.js";
import { initWorker } from "./commands/init.js";
import { listWorkers, type ListScope } from "./commands/list.js";
import { listPiModels } from "./commands/models.js";
import { runWorker } from "./commands/run.js";
import { listRuns } from "./commands/runs.js";
import { formatError, PixariumError } from "./errors.js";
import { findGitRoot, findGitRootIfPresent } from "./repository.js";
import type { WorkerScope } from "./worker-loader.js";

/** CLIが受理するcommandと引数の組み合わせを示す、全診断共通のusage。 */
const USAGE = `Usage:
  pixarium auth
  pixarium models
  pixarium init [--local | --global] [--base | --extends "global:<name>"] <worker-name>
  pixarium list [--local | --global] [--json]
  pixarium check [--local | --global] [worker-name]
  pixarium run [--local | --global] <worker-name> [--task "<task>"]
  pixarium runs [--json]
  pixarium attach <run-id>
`;

/** scopeを扱う各commandで同じ排他規則を適用するためのparseArgs定義。 */
const scopeOptions = {
  local: { type: "boolean" as const, default: false },
  global: { type: "boolean" as const, default: false },
};

/**
 * worker名またはrun IDを一つだけ要求するcommandの位置引数を検証する。
 * @param command usage errorへ含めるcommand名。
 * @param positionals parseArgsが返した位置引数。
 * @returns 唯一の空でない位置引数。
 */
function requireOnePosition(command: string, positionals: string[]): string {
  if (positionals.length !== 1 || !positionals[0]) {
    throw new PixariumError(
      `${command} requires exactly one worker name\n${USAGE}`,
      "configuration",
    );
  }
  return positionals[0];
}

/**
 * `--local`と`--global`を排他的なWorker scopeへ正規化する。
 * @param values parseArgsが返したscope flag。
 * @returns 明示されたscope。どちらもなければ自動解決を示すundefined。
 */
function selectedScope(values: { local?: boolean; global?: boolean }): WorkerScope | undefined {
  if (values.local && values.global) {
    throw new PixariumError("--local and --global cannot be used together", "configuration");
  }
  if (values.local) return "local";
  if (values.global) return "global";
  return undefined;
}

/**
 * process引数をcommandへdispatchし、成功時の終了codeを返す。
 * @returns command固有の終了code。構成errorは例外として最外層へ渡す。
 */
async function main(): Promise<number> {
  const command = process.argv[2];
  const rest = process.argv.slice(3);
  // command集合を先に閉じることで、後段のswitchを到達可能な入力だけに限定する。
  if (
    !command ||
    !["auth", "models", "init", "list", "check", "run", "runs", "attach"].includes(command)
  ) {
    throw new PixariumError(`unknown or missing command\n${USAGE}`, "configuration");
  }
  if (command === "auth") {
    const parsed = parseArgs({ args: rest, allowPositionals: true });
    if (parsed.positionals.length > 0) {
      throw new PixariumError(`auth takes no arguments\n${USAGE}`, "configuration");
    }
    await authenticatePi();
    return 0;
  }
  if (command === "models") {
    const parsed = parseArgs({ args: rest, allowPositionals: true });
    if (parsed.positionals.length > 0) {
      throw new PixariumError(`models takes no arguments\n${USAGE}`, "configuration");
    }
    await listPiModels();
    return 0;
  }
  if (command === "runs") {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { json: { type: "boolean", default: false } },
    });
    if (parsed.positionals.length > 0) {
      throw new PixariumError(`runs takes no run ID\n${USAGE}`, "configuration");
    }
    await listRuns(parsed.values.json);
    return 0;
  }
  if (command === "attach") {
    const parsed = parseArgs({ args: rest, allowPositionals: true });
    await attachRun(requireOnePosition(command, parsed.positionals));
    return 0;
  }

  // 引数構造が異なるWorker commandだけをswitch内で個別にparseする。
  switch (command) {
    case "init": {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          ...scopeOptions,
          base: { type: "boolean", default: false },
          extends: { type: "string" },
        },
      });
      const requestedScope = selectedScope(parsed.values);
      const scope = requestedScope ?? "local";
      const repositoryRoot = scope === "local" ? await findGitRoot() : undefined;
      await initWorker(repositoryRoot, requireOnePosition(command, parsed.positionals), {
        scope,
        base: parsed.values.base,
        extendsWorker: parsed.values.extends,
      });
      return 0;
    }
    case "list": {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          ...scopeOptions,
          json: { type: "boolean", default: false },
        },
      });
      if (parsed.positionals.length > 0) {
        throw new PixariumError(`list takes no worker name\n${USAGE}`, "configuration");
      }
      const requestedScope = selectedScope(parsed.values);
      const repositoryRoot = requestedScope === "global" ? undefined : await findGitRootIfPresent();
      if (requestedScope === "local" && !repositoryRoot) {
        throw new PixariumError("local workers require a Git repository", "configuration");
      }
      const scope: ListScope = requestedScope ?? "effective";
      return listWorkers(repositoryRoot, parsed.values.json, scope);
    }
    case "check": {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: scopeOptions,
      });
      if (parsed.positionals.length > 1) {
        throw new PixariumError(`check accepts at most one worker name\n${USAGE}`, "configuration");
      }
      const requestedScope = selectedScope(parsed.values);
      const repositoryRoot = requestedScope === "global" ? undefined : await findGitRootIfPresent();
      if (requestedScope === "local" && !repositoryRoot) {
        throw new PixariumError("local workers require a Git repository", "configuration");
      }
      return checkWorkers(repositoryRoot, parsed.positionals[0], requestedScope);
    }
    case "run": {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          ...scopeOptions,
          task: { type: "string" },
        },
      });
      const requestedScope = selectedScope(parsed.values);
      const repositoryRoot = await findGitRoot();
      await runWorker(
        repositoryRoot,
        requireOnePosition(command, parsed.positionals),
        parsed.values.task,
        requestedScope,
      );
      return 0;
    }
  }
  return 1;
}

/**
 * Node.jsのbuffered write完了を待ち、短命なCLI processで末尾出力が欠けるのを防ぐ。
 * @param stream 完了を待つstdoutまたはstderr。
 * @returns 空writeのcallbackが呼ばれた時点で解決するPromise。
 */
function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.write("", () => resolve()));
}

try {
  const exitCode = await main();
  await Promise.all([flush(process.stdout), flush(process.stderr)]);
  process.exitCode = exitCode;
} catch (error) {
  // node:util由来のTypeErrorも利用者の入力誤りなので、unexpected errorへ分類しない。
  const reportedError =
    error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")
      ? new PixariumError(error.message, "configuration")
      : error;
  await new Promise<void>((resolve) =>
    process.stderr.write(`${formatError(reportedError)}\n`, () => resolve()),
  );
  process.exitCode = 1;
}
