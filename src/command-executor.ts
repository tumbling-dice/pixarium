import { spawn } from "node:child_process";
import path from "node:path";
import { PixariumError } from "./errors.js";
import type { WorkerCommandDefinition } from "./worker-loader.js";

/** command定義で省略されたtimeoutへ適用する秒数。 */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 300;
/** stdoutとstderrを合わせてPiへ返せる既定最大byte数。 */
export const DEFAULT_COMMAND_MAX_OUTPUT_BYTES = 200_000;

/** Worker commandの完了状態と、上限適用済み出力を保持する結果。 */
export interface CommandExecutionResult {
  /** worker.yamlの元名と実行fileを対応付けるcommand名。 */
  command: string;
  /** shell解釈を介さずprocessへ渡した引数列。 */
  args: string[];
  /** project rootとworkingDirectoryから解決した絶対作業directory。 */
  cwd: string;
  /** 正常にprocessを開始できた場合の終了code。signal終了ではnull。 */
  exitCode: number | null;
  /** signal終了時のsignal名。通常終了ではnull。 */
  signal: NodeJS.Signals | null;
  /** 上限内で保持した標準出力の先頭部分。 */
  stdout: string;
  /** 上限内で保持した標準エラー出力の先頭部分。 */
  stderr: string;
  /** 設定timeoutを超えてPixariumが停止した場合はtrue。 */
  timedOut: boolean;
  /** stdoutとstderrの合計が上限を超えた場合はtrue。 */
  truncated: boolean;
}

/** command実行時にExtensionから渡すproject境界と任意の中止signal。 */
export interface ExecuteCommandOptions {
  /** workingDirectoryの基準となるGit repository root。 */
  projectRoot: string;
  /** Pi tool呼出しが中止された場合にchild processへ伝えるsignal。 */
  signal?: AbortSignal;
}

/**
 * passthroughまたは固定commandを、shell展開なしのchild processとして実行する。
 * @param definition 検証済みWorker command定義。
 * @param requestedArgs passthrough toolが受け取った引数。固定commandでは無視する。
 * @param options project rootと任意の中止signal。
 * @returns timeoutと出力上限を反映したprocess結果。
 */
export async function executeWorkerCommand(
  definition: WorkerCommandDefinition,
  requestedArgs: string[],
  options: ExecuteCommandOptions,
): Promise<CommandExecutionResult> {
  const args =
    definition.arguments === "passthrough" ? [...requestedArgs] : [...(definition.args ?? [])];
  const cwd = path.resolve(options.projectRoot, definition.workingDirectory ?? ".");
  const maxOutputBytes = definition.maxOutputBytes ?? DEFAULT_COMMAND_MAX_OUTPUT_BYTES;
  const timeoutMilliseconds =
    (definition.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS) * 1_000;

  return await new Promise<CommandExecutionResult>((resolvePromise, rejectPromise) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const child = spawn(definition.executable, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    /**
     * 出力streamの順序を保ちながら、両stream共通のbyte上限へ先頭から格納する。
     * @param target chunkを受け取った標準stream。
     * @param chunk child processから届いたbyte列。
     */
    const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const remaining = Math.max(0, maxOutputBytes - capturedBytes);
      const accepted = chunk.subarray(0, remaining);
      if (target === "stdout") stdout = Buffer.concat([stdout, accepted]);
      else stderr = Buffer.concat([stderr, accepted]);
      capturedBytes += accepted.length;
      if (accepted.length < chunk.length) truncated = true;
    };

    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));

    /** child processへ終了を要求し、応答しない場合の強制停止を予約する。 */
    const stopForAbort = (): void => {
      if (settled) return;
      child.kill("SIGTERM");
      // 終了signalを処理するcommandでもtool呼出しが永久待機しないよう、短い猶予後に強制停止する。
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        forceKillTimer.unref();
      }
    };
    options.signal?.addEventListener("abort", stopForAbort, { once: true });
    if (options.signal?.aborted) stopForAbort();

    // timeoutはtoolごとに閉じ、Worker全体の入力待ちへ依存させない。
    const timeout = setTimeout(() => {
      timedOut = true;
      stopForAbort();
    }, timeoutMilliseconds);
    timeout.unref();

    child.once("error", (error) => {
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", stopForAbort);
      rejectPromise(
        new PixariumError(
          `worker command "${definition.name}" could not start ${definition.executable} in ${cwd}: ${error.message}`,
          "worker",
        ),
      );
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", stopForAbort);
      resolvePromise({
        command: definition.name,
        args,
        cwd,
        exitCode,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        truncated,
      });
    });
  });
}

/**
 * 構造化結果を、commandの失敗理由と出力境界がモデルにも読めるtextへ変換する。
 * @param definition 元名と実行fileを含むcommand定義。
 * @param result process実行結果。
 * @returns Pi tool resultへ入れる複数行text。
 */
export function formatCommandExecutionResult(
  definition: WorkerCommandDefinition,
  result: CommandExecutionResult,
): string {
  const lines = [
    `Command tool: ${definition.name}`,
    `Executable: ${definition.executable}`,
    `Arguments: ${JSON.stringify(result.args)}`,
    `Working directory: ${result.cwd}`,
    `Exit code: ${result.exitCode ?? "null"}`,
    `Signal: ${result.signal ?? "none"}`,
    `Timed out: ${result.timedOut ? "yes" : "no"}`,
    `Output truncated: ${result.truncated ? "yes" : "no"}`,
    "",
    "STDOUT:",
    result.stdout || "(empty)",
    "",
    "STDERR:",
    result.stderr || "(empty)",
  ];
  return lines.join("\n");
}
