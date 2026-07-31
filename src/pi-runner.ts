import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { PixariumError } from "./errors.js";
import { COMMAND_TOOLS_CONFIG_ENV } from "./pi-command-extension.js";
import { createPiRpcTransport } from "./pi-rpc-transport.js";
import { requireCredentialDirectoryOutsideProtectedRoots } from "./repository.js";
import { startRunObserver, type RunObserver } from "./run-observer.js";
import { normalizeCommandToolName, pixariumHome } from "./worker-loader.js";
import type { ValidatedSkill, ValidatedWorker } from "./worker-validator.js";

/** CLIからPi processを制御するときのtimeoutとsteering入出力。 */
export interface RunPiOptions {
  /** Worker設定を上書きする正の秒数。nullは明示的な無制限。 */
  timeoutSeconds?: number | null;
  /** 改行区切りsteering commandを実行中に受け取る任意stream。 */
  controlInput?: NodeJS.ReadableStream;
  /** steeringの受理・拒否を回答本文と分離して通知する任意callback。 */
  onDiagnostic?: (message: string) => void;
}

/** 同梱JavaScript CLIとテスト用実行fileを同じspawn処理で扱う起動情報。 */
interface PiInvocation {
  /** spawnへ直接渡す実行file。通常は現在のNode.js executable。 */
  command: string;
  /** 実際のCLI scriptなど、commandより前に必要な固定引数。 */
  prefixArgs: string[];
  /** 起動失敗の診断へ表示する、利用者が確認可能な実体path。 */
  displayPath: string;
}

/** @returns node_modulesと配布entrypointを解決するPixarium npm package root。 */
function packageRootPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * bundled Piへ明示的に読み込ませる共通command Extensionを解決する。
 * @returns Extensionのbuild済み絶対path。
 */
function commandToolsExtensionPath(): string {
  return join(packageRootPath(), "dist", "pi-command-extension.js");
}

/**
 * bundled Pi CLIの起動commandを解決する。
 * @returns Node.js経由の同梱CLI、またはテスト専用overrideの起動情報。
 */
function bundledPiInvocation(): PiInvocation {
  if (process.env.PIXARIUM_PI_BIN) {
    const command = resolve(process.env.PIXARIUM_PI_BIN);
    return { command, prefixArgs: [], displayPath: command };
  }
  const packageRoot = packageRootPath();
  const cliPath = join(
    packageRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
  return { command: process.execPath, prefixArgs: [cliPath], displayPath: cliPath };
}

/**
 * bundled pi-ai認証CLIの起動commandを解決する。
 * @returns Node.js経由の同梱CLI、またはテスト専用overrideの起動情報。
 */
function bundledPiAiInvocation(): PiInvocation {
  if (process.env.PIXARIUM_PI_AI_BIN) {
    const command = resolve(process.env.PIXARIUM_PI_AI_BIN);
    return { command, prefixArgs: [], displayPath: command };
  }
  const packageRoot = packageRootPath();
  const cliPath = join(packageRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "cli.js");
  return { command: process.execPath, prefixArgs: [cliPath], displayPath: cliPath };
}

/**
 * Piのstderrをcredential内容を引用せず、利用者が対処可能な失敗分類へ変換する。
 * @param stderr 長さを制限して保持したPiの診断末尾。
 * @param exitCode Pi processの終了code。
 * @returns 認証、model、一般実行のいずれかに分類したerror。
 */
function classifyPiFailure(stderr: string, exitCode: number): PixariumError {
  if (/(authentication|unauthorized|api[ _-]?key|log in|login)/i.test(stderr)) {
    return new PixariumError(
      `Pi reported an authentication failure (exit code ${exitCode})`,
      "pi-authentication",
    );
  }
  if (
    /(unknown|invalid|unsupported|not found).{0,40}model|model.{0,40}(unknown|invalid|unsupported|not found)/is.test(
      stderr,
    )
  ) {
    return new PixariumError(`Pi reported a model failure (exit code ${exitCode})`, "pi-model");
  }
  return new PixariumError(`Pi exited with code ${exitCode}`, "pi-exit");
}

/**
 * credential directoryを取得し、Pixarium homeと対象repository群の外側であると検証する。
 * @param repositoryRoots credential保存を禁止するrepository/package root群。
 * @returns symlink解決済みの安全なPi agent directory。
 */
async function safePiAgentDirectory(repositoryRoots: string[]): Promise<string> {
  return requireCredentialDirectoryOutsideProtectedRoots(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    [pixariumHome(), ...repositoryRoots],
  );
}

/**
 * 継承されたSkillを、参照基準とscopeが明示されたprompt blockへ変換する。
 * @param skill 検証済みSkill。
 * @returns 複数Skillを安全に連結できるXML風block。
 */
function formatSkillBlock(skill: ValidatedSkill): string {
  return (
    `<skill name="${skill.name}" location="${skill.path}" scope="${skill.scope}">\n` +
    `References are relative to ${skill.baseDirectory}.\n\n` +
    `${skill.body}\n` +
    `</skill>`
  );
}

/**
 * WorkerのSkill構成とtaskをPiへ渡す単一promptへ合成する。
 * @param worker 継承解決済みWorker。
 * @param task 利用者から受け取った依頼本文。
 * @returns 単一SkillならPiのskill呼出し、複数なら優先規則付き本文。
 */
function workerPrompt(worker: ValidatedWorker, task: string): string {
  if (worker.skills.length === 1) {
    return `/skill:${worker.skills[0]?.name}\n\n${task}`;
  }
  const skillBlocks = worker.skills.map(formatSkillBlock).join("\n\n");
  return (
    "The following Skill layers are ordered from general to specific. " +
    "When they conflict, the later local layer applies.\n\n" +
    `${skillBlocks}\n\n${task}`
  );
}

/** credentialを含み得るstderrを無制限にmemory保持しないための末尾上限。 */
const STDERR_TAIL_LIMIT = 64 * 1024;
/** 改行のないsteering入力でmemoryを消費し続けないための上限。 */
const CONTROL_INPUT_LIMIT = 64 * 1024;
/** attach表示へ含めるbash出力の最大行数。 */
const TOOL_OUTPUT_PREVIEW_LINES = 2;
/** 一つのbash preview行が端末とtraceを占有できる最大文字数。 */
const TOOL_OUTPUT_PREVIEW_LINE_LIMIT = 240;

/** @param value Pi event由来の値。 @returns 通常objectとしてfield参照できればtrue。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param value Pi event由来の値。 @returns 配列ならtrue。 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Pi RPCの一行をobject eventとしてparseする。
 * @param line 改行を除去済みのJSON line。
 * @returns key参照可能なevent object。
 */
function parsePiEvent(line: string): Record<string, unknown> {
  const event: unknown = JSON.parse(line);
  if (!isRecord(event)) {
    throw new Error("event is not an object");
  }
  return event;
}

/**
 * assistant messageのtext partだけを順序通り連結する。
 * @param message Pi event内の未検証message。
 * @returns assistant text。対象外のmessageならundefined。
 */
function assistantText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  if (message.role !== "assistant" || !isUnknownArray(message.content)) {
    return undefined;
  }
  const text = message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
  return text;
}

/**
 * message履歴を末尾から探索し、最後のassistant回答を得る。
 * @param messages Pi event内の未検証message履歴。
 * @returns 最新assistant text。存在しなければundefined。
 */
function finalAssistantText(messages: unknown): string | undefined {
  if (!isUnknownArray(messages)) return undefined;
  return messages
    .toReversed()
    .map(assistantText)
    .find((text) => text !== undefined);
}

/** @param value 未検証event field。 @returns stringならその値、それ以外はundefined。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** @param value 未検証event field。 @returns numberならその値、それ以外はundefined。 */
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * traceへ保存する文字列から端末制御sequenceとCRを除く。
 * @param value Pi tool由来の文字列。
 * @returns attach表示を制御できないplain text。
 */
function safeTraceText(value: string): string {
  return stripVTControlCharacters(value).replaceAll("\r", "");
}

/**
 * tool引数から認証値や本文を避け、操作対象を識別できるfieldだけを抽出する。
 * @param toolName Piが報告したtool名。
 * @param args 未検証のtool引数。
 * @returns trace表示用の限定された詳細。
 */
function toolDetail(
  toolName: string | undefined,
  args: unknown,
  commandToolNames: ReadonlySet<string>,
): string | undefined {
  if (!isRecord(args)) return undefined;
  if (toolName === "bash") {
    const command = stringValue(args.command);
    return command ? `command=${JSON.stringify(safeTraceText(command))}` : undefined;
  }
  if (toolName && commandToolNames.has(toolName) && Array.isArray(args.args)) {
    return `args=${JSON.stringify(args.args)}`;
  }
  const parts: string[] = [];
  for (const key of ["path", "glob", "offset", "limit"]) {
    const value = args[key];
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * Pi tool resultのtext partだけをpreview生成用に連結する。
 * @param result 未検証のtool result。
 * @returns text出力。期待形状でなければundefined。
 */
function toolResultText(result: unknown): string | undefined {
  if (!isRecord(result) || !isUnknownArray(result.content)) return undefined;
  return result.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

/**
 * bash toolの成否と定型出力から終了codeを復元する。
 * @param isError Piが報告したtool error flag。
 * @param output bash toolのtext出力。
 * @returns 成功なら0、parse可能な失敗code、またはundefined。
 */
function bashExitCode(isError: boolean, output: string | undefined): number | undefined {
  if (!isError) return 0;
  const match = output?.match(/(?:^|\n)Command exited with code (-?\d+)(?:\n|$)/);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * bash出力を制御文字なしのbounded previewへ変換する。
 * @param output bash toolのtext出力。
 * @returns attach traceへ保存できる先頭行群。
 */
function bashOutputPreview(output: string | undefined): string[] {
  if (!output) return [];
  return safeTraceText(output)
    .split("\n")
    .slice(0, TOOL_OUTPUT_PREVIEW_LINES)
    .map((line) =>
      line.length > TOOL_OUTPUT_PREVIEW_LINE_LIMIT
        ? `${line.slice(0, TOOL_OUTPUT_PREVIEW_LINE_LIMIT)}…`
        : line,
    );
}

/**
 * command toolの構造化詳細からstdoutとstderrの先頭行をtraceへ抽出する。
 * @param details Extensionが返した未検証CommandExecutionResult。
 * @returns attachへ保存できる制御文字なしの短い出力。
 */
function commandOutputPreview(details: Record<string, unknown> | undefined): string[] {
  if (!details) return [];
  const lines: string[] = [];
  for (const [label, value] of [
    ["stdout", details.stdout],
    ["stderr", details.stderr],
  ] as const) {
    if (typeof value !== "string" || value === "") continue;
    for (const line of safeTraceText(value).split("\n")) {
      if (lines.length >= TOOL_OUTPUT_PREVIEW_LINES) return lines;
      const bounded =
        line.length > TOOL_OUTPUT_PREVIEW_LINE_LIMIT
          ? `${line.slice(0, TOOL_OUTPUT_PREVIEW_LINE_LIMIT)}…`
          : line;
      lines.push(`${label}: ${bounded}`);
    }
  }
  return lines;
}

/**
 * Pi固有eventを、versionに依存しにくいPixarium trace eventへ射影する。
 * @param observer traceの公開先。
 * @param event parse済みPi RPC event。
 */
function publishPiTrace(
  observer: RunObserver,
  event: Record<string, unknown>,
  commandToolNames: ReadonlySet<string>,
): void {
  switch (event.type) {
    case "message_update": {
      if (!isRecord(event.assistantMessageEvent)) break;
      const delta = stringValue(event.assistantMessageEvent.delta);
      if (!delta) break;
      if (event.assistantMessageEvent.type === "thinking_delta") {
        observer.publish({ type: "reasoning_delta", delta });
      } else if (event.assistantMessageEvent.type === "text_delta") {
        observer.publish({ type: "text_delta", delta });
      }
      break;
    }
    case "tool_execution_start": {
      const toolName = stringValue(event.toolName);
      observer.publish({
        type: "tool_start",
        toolName: toolName ?? "tool",
        detail: toolDetail(toolName, event.args, commandToolNames),
      });
      break;
    }
    case "tool_execution_end": {
      const toolName = stringValue(event.toolName) ?? "tool";
      const output = toolName === "bash" ? toolResultText(event.result) : undefined;
      const details =
        isRecord(event.result) && isRecord(event.result.details) ? event.result.details : undefined;
      const commandExitCode = commandToolNames.has(toolName)
        ? numberValue(details?.exitCode)
        : undefined;
      const commandTimedOut = commandToolNames.has(toolName) && details?.timedOut === true;
      observer.publish({
        type: "tool_end",
        toolName,
        isError:
          event.isError === true ||
          commandTimedOut ||
          (commandExitCode !== undefined && commandExitCode !== 0),
        exitCode:
          toolName === "bash" ? bashExitCode(event.isError === true, output) : commandExitCode,
        outputPreview:
          toolName === "bash"
            ? bashOutputPreview(output)
            : commandToolNames.has(toolName)
              ? commandOutputPreview(details)
              : undefined,
      });
      break;
    }
    case "compaction_start":
      observer.publish({ type: "compaction_start", reason: stringValue(event.reason) });
      break;
    case "compaction_end":
      observer.publish({ type: "compaction_end" });
      break;
    case "auto_retry_start":
      observer.publish({
        type: "retry",
        attempt: numberValue(event.attempt),
        maxAttempts: numberValue(event.maxAttempts),
      });
      break;
    case "queue_update":
      observer.publish({
        type: "steering",
        state: "queue updated",
        queued: isUnknownArray(event.steering) ? event.steering.length : undefined,
      });
      break;
  }
}

/**
 * stderr末尾だけを保持し、長時間processのmemory使用量を固定する。
 * @param current 現在保持しているstderr末尾。
 * @param chunk 新しく受信した文字列。
 * @returns 上限以内に切り詰めた最新末尾。
 */
function appendStderrTail(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= STDERR_TAIL_LIMIT ? combined : combined.slice(-STDERR_TAIL_LIMIT);
}

/** bundled pi-aiを対話端末へ接続し、OpenAI Codex OAuth loginを実行する。 */
export async function runPiAuthentication(): Promise<void> {
  const piAi = bundledPiAiInvocation();
  const agentDirectory = await safePiAgentDirectory([packageRootPath()]);
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  const args = [...piAi.prefixArgs, "login", "openai-codex"];

  process.stderr.write("Starting OpenAI Codex OAuth with bundled Pi authentication tools.\n");

  await new Promise<void>((resolvePromise, rejectPromise) => {
    // 認証CLIが作る未知のfileも所有者以外から読めないよう、spawn時だけumaskを厳しくする。
    const previousUmask = process.umask(0o077);
    let child;
    try {
      child = spawn(piAi.command, args, {
        cwd: agentDirectory,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
        stdio: "inherit",
      });
    } finally {
      process.umask(previousUmask);
    }

    child.once("error", (error) => {
      rejectPromise(
        new PixariumError(`could not start ${piAi.displayPath}: ${error.message}`, "pi-launch"),
      );
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(
          new PixariumError(
            `Pi OAuth login exited with code ${code ?? 1}${signal ? ` (${signal})` : ""}`,
            "pi-exit",
          ),
        );
      }
    });
  });
}

/** bundled Piのmodel一覧commandをstdio透過で実行する。 */
export async function runPiListModels(): Promise<void> {
  const pi = bundledPiInvocation();
  const agentDirectory = await safePiAgentDirectory([packageRootPath()]);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(pi.command, [...pi.prefixArgs, "--list-models"], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
      stdio: "inherit",
    });

    child.once("error", (error) => {
      rejectPromise(
        new PixariumError(`could not start ${pi.displayPath}: ${error.message}`, "pi-launch"),
      );
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(
          new PixariumError(
            `Pi model listing exited with code ${code ?? 1}${signal ? ` (${signal})` : ""}`,
            "pi-exit",
          ),
        );
      }
    });
  });
}

/**
 * 検証済みWorkerをbundled Piで実行する。
 * @param worker 実効設定まで検証済みのWorker。
 * @param task Workerへ渡す空でない依頼。
 * @param repositoryRoot Piの作業ディレクトリにするGit repository root。
 * @param options CLIが指定するtimeoutとsteering入出力。
 * @returns Workerが最後に返したassistant text。
 */
export async function runPi(
  worker: ValidatedWorker,
  task: string,
  repositoryRoot: string,
  options: RunPiOptions = {},
): Promise<string> {
  const agentDirectory = await safePiAgentDirectory([packageRootPath(), repositoryRoot]);
  const prompt = workerPrompt(worker, task);
  const skillArgs = worker.skills.length === 1 ? ["--skill", worker.skills[0]?.path ?? ""] : [];
  const commandToolNames = new Set(
    worker.config.commands.map((command) => normalizeCommandToolName(command.name)),
  );
  const extensionArgs =
    worker.config.commands.length > 0 ? ["--extension", commandToolsExtensionPath()] : [];
  const enabledTools = [...worker.config.tools, ...commandToolNames];
  const args = [
    "--no-session",
    "--no-extensions",
    ...extensionArgs,
    "--no-skills",
    "--no-prompt-templates",
    // context discoveryはrepository由来のprompt入力なので、Workerが明示的に許可した場合だけ有効にする。
    ...(worker.config.contextFiles === "disabled" ? ["--no-context-files"] : []),
    "--no-approve",
    "--model",
    worker.config.model,
    "--thinking",
    worker.config.thinking,
    "--tools",
    enabledTools.join(","),
    "--system-prompt",
    worker.systemPrompt,
    ...skillArgs,
    "--mode",
    "rpc",
  ];

  const pi = bundledPiInvocation();
  const observer = await startRunObserver(worker, task);
  try {
    // Windows以外ではfile-backed transportを使い、別processのattachとPi出力を共有可能にする。
    const rpcTransport =
      process.platform === "win32" ? undefined : await createPiRpcTransport(observer.directory);
    return await new Promise<string>((resolvePromise, rejectPromise) => {
      // Piの論理完了とOS process終了は別eventなので、両者を分けて競合を処理する。
      let completed = false;
      let promiseSettled = false;
      let timedOut = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let shutdownTimer: NodeJS.Timeout | undefined;
      let stdoutBuffer = "";
      let stderr = "";
      let finalAnswer: string | undefined;
      let eventParseError: Error | undefined;
      let rpcError: PixariumError | undefined;
      let controlBuffer = "";
      let steeringSequence = 0;
      let promptAccepted = false;
      // 初期promptより先にsteeringが適用されないよう、accept応答までは順序付きで保留する。
      const steeringBacklog: string[] = [];
      const pendingSteering = new Set<string>();
      const child = spawn(pi.command, [...pi.prefixArgs, ...args], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDirectory,
          ...(worker.config.commands.length > 0
            ? {
                [COMMAND_TOOLS_CONFIG_ENV]: JSON.stringify({
                  projectRoot: repositoryRoot,
                  commands: worker.config.commands,
                }),
              }
            : {}),
        },
        stdio: rpcTransport?.stdio ?? ["pipe", "pipe", "pipe"],
      });
      child.stdin?.on("error", (error) => {
        if ("code" in error && error.code === "EPIPE") return;
        rpcError = new PixariumError(`could not write to Pi RPC: ${error.message}`, "pi-launch");
      });
      child.once("spawn", () => {
        rpcTransport?.start(handleStdout, handleStderr);
        sendRpc({ id: "pixarium-initial", type: "prompt", message: prompt });
      });

      /** @param command 改行区切りJSONとしてPiへ送るRPC command。 */
      const sendRpc = (command: Record<string, unknown>): void => {
        const line = `${JSON.stringify(command)}\n`;
        if (rpcTransport) rpcTransport.write(line);
        else child.stdin?.write(line);
      };
      /**
       * RPC入力を閉じて正常終了を促し、応答しないPiだけを遅延SIGTERMする。
       * immediate killを避けるのは、最終eventとfile outputのflushを完了させるためである。
       */
      const requestShutdown = (): void => {
        if (rpcTransport) rpcTransport.closeInput();
        else if (child.stdin && !child.stdin.destroyed) child.stdin.end();
        if (!shutdownTimer) {
          shutdownTimer = setTimeout(() => child.kill("SIGTERM"), 1_000);
          shutdownTimer.unref();
        }
      };
      /** @param message 実行中agentへ追加するsteering本文。 */
      const sendSteering = (message: string): void => {
        const id = `pixarium-steer-${++steeringSequence}`;
        pendingSteering.add(id);
        sendRpc({ id, type: "steer", message });
      };

      /**
       * Pi RPC event一件を状態へ反映し、完了またはprotocol error時にshutdownを始める。
       * @param line 改行を除去済みのJSON event line。
       */
      const handleEventLine = (line: string): void => {
        if (!line || eventParseError) return;
        try {
          const event = parsePiEvent(line);
          publishPiTrace(observer, event, commandToolNames);
          const answerFromMessages = finalAssistantText(event.messages);
          if (answerFromMessages !== undefined) finalAnswer = answerFromMessages;
          if (event.type === "message_end") {
            const answer = assistantText(event.message);
            if (answer !== undefined) finalAnswer = answer;
          }
          if (event.type === "response") {
            const id = stringValue(event.id);
            if (id === "pixarium-initial" && event.success !== true) {
              rpcError = new PixariumError("Pi rejected the initial prompt", "pi-exit");
              requestShutdown();
            } else if (id === "pixarium-initial") {
              promptAccepted = true;
              for (const message of steeringBacklog.splice(0)) sendSteering(message);
            } else if (id && pendingSteering.delete(id)) {
              const accepted = event.success === true;
              observer.publish({
                type: "steering",
                state: accepted ? "accepted" : "rejected",
              });
              options.onDiagnostic?.(`[pixarium] steering ${accepted ? "accepted" : "rejected"}\n`);
            }
          }
          // final answerの存在だけではtool実行中か判別できないため、agent_settledを論理完了とする。
          if (event.type === "agent_settled" && !completed) {
            completed = true;
            observer.publish({ type: "run_end", state: "completed" });
            requestShutdown();
          }
        } catch (error) {
          eventParseError = error instanceof Error ? error : new Error(String(error));
          requestShutdown();
        }
      };

      /** @param chunk Pi stdoutから届いた任意境界のbyte列。 */
      const handleStdout = (chunk: Buffer): void => {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) handleEventLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      };
      /** @param chunk Pi stderrから届いた診断byte列。 */
      const handleStderr = (chunk: Buffer): void => {
        stderr = appendStderrTail(stderr, chunk.toString("utf8"));
      };
      child.stdout?.on("data", handleStdout);
      child.stderr?.on("data", handleStderr);

      /**
       * CLI control input一行を限定的なsteer commandとして検証する。
       * @param line 標準入力から切り出した一行。
       */
      const handleControlLine = (line: string): void => {
        if (!line.trim()) return;
        let command: unknown;
        try {
          command = JSON.parse(line);
        } catch {
          options.onDiagnostic?.("[pixarium] steering rejected: invalid JSON\n");
          return;
        }
        if (
          !isRecord(command) ||
          command.type !== "steer" ||
          typeof command.message !== "string" ||
          command.message.trim() === ""
        ) {
          options.onDiagnostic?.("[pixarium] steering rejected: expected a non-empty message\n");
          return;
        }
        if (completed) {
          options.onDiagnostic?.("[pixarium] steering rejected: worker is no longer running\n");
        } else if (promptAccepted) {
          sendSteering(command.message);
        } else {
          steeringBacklog.push(command.message);
        }
      };
      /** @param chunk control inputから届いた任意境界のdata。 */
      const onControlData = (chunk: Buffer | string): void => {
        controlBuffer += chunk.toString();
        if (Buffer.byteLength(controlBuffer) > CONTROL_INPUT_LIMIT) {
          controlBuffer = "";
          options.onDiagnostic?.("[pixarium] steering rejected: input exceeded limit\n");
          return;
        }
        const lines = controlBuffer.split("\n");
        controlBuffer = lines.pop() ?? "";
        for (const line of lines) {
          handleControlLine(line.endsWith("\r") ? line.slice(0, -1) : line);
        }
      };
      options.controlInput?.on("data", onControlData);
      options.controlInput?.resume();
      /** listenerだけを外し、共有stdin自体はcloseせず呼び出し元へ返す。 */
      const stopControlInput = (): void => {
        options.controlInput?.off("data", onControlData);
        options.controlInput?.pause();
      };

      const configuredTimeout =
        options.timeoutSeconds === undefined
          ? worker.config.timeoutSeconds
          : options.timeoutSeconds;
      // nullは明示的な無制限なのでtimerを作らず、undefinedの未設定とは合成前に区別する。
      const timeout =
        configuredTimeout === null
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              observer.publish({ type: "run_end", state: "timed out" });
              // cleanupの機会を与えた後、応答しないprocessだけをSIGKILLしてPromiseを確実に終える。
              child.kill("SIGTERM");
              forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
              forceKillTimer.unref();
            }, configuredTimeout * 1_000);
      timeout?.unref();

      child.once("error", async (error) => {
        if (promiseSettled) return;
        promiseSettled = true;
        stopControlInput();
        if (timeout) clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (shutdownTimer) clearTimeout(shutdownTimer);
        await rpcTransport?.stop();
        rejectPromise(
          new PixariumError(`could not start ${pi.displayPath}: ${error.message}`, "pi-launch"),
        );
      });

      child.once("close", async (code, signal) => {
        if (promiseSettled) return;
        promiseSettled = true;
        stopControlInput();
        if (timeout) clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (shutdownTimer) clearTimeout(shutdownTimer);
        await rpcTransport?.stop();
        handleEventLine(stdoutBuffer.endsWith("\r") ? stdoutBuffer.slice(0, -1) : stdoutBuffer);
        // timeoutは停止によって生じるexit codeより先に、利用者が対処できる原因として報告する。
        if (timedOut) {
          rejectPromise(
            new PixariumError(
              `worker "${worker.config.name}" exceeded ${configuredTimeout} seconds`,
              "timeout",
            ),
          );
        } else if (rpcError) {
          rejectPromise(rpcError);
        } else if (code !== 0 && !completed) {
          rejectPromise(classifyPiFailure(stderr, code ?? (signal ? 1 : 1)));
        } else if (eventParseError) {
          rejectPromise(
            new PixariumError(
              `could not parse Pi event stream: ${eventParseError.message}`,
              "pi-exit",
            ),
          );
        } else if (!completed || finalAnswer === undefined) {
          rejectPromise(new PixariumError("Pi event stream contained no final answer", "pi-exit"));
        } else {
          resolvePromise(finalAnswer);
        }
      });
    });
  } finally {
    await observer.close();
  }
}
