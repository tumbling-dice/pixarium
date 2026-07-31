import { PixariumError } from "../errors.js";
import type { WorkerScope } from "../worker-loader.js";
import { executeWorker } from "../worker-runner.js";

/**
 * pipeされた標準入力を最後まで読み、task文字列として返す。
 * @returns TTYなら空文字、pipe入力なら受信した全文。
 */
async function readStandardInput(): Promise<string> {
  if (process.stdin.isTTY) return "";
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
  }
  return value;
}

/**
 * CLIのtask入力とstream出力を共有Worker実行層へ接続する。
 * @param repositoryRoot CLIが解決した対象Git repository root。
 * @param name 実行するWorker名。
 * @param suppliedTask --taskで明示されたtask。省略時はstdinから読む。
 * @param scope 明示されたWorker scope。省略時はlocal優先で解決する。
 */
export async function runWorker(
  repositoryRoot: string,
  name: string,
  suppliedTask?: string,
  scope?: WorkerScope,
): Promise<void> {
  // --taskをstdinより優先し、CLI利用者が意図せず二つのtaskを混ぜないようにする。
  const task = (suppliedTask ?? (await readStandardInput())).trim();
  if (!task) {
    throw new PixariumError(
      'task is empty; pass --task "..." or pipe a task on standard input',
      "configuration",
    );
  }
  const result = await executeWorker({
    repositoryRoot,
    name,
    task,
    ...(scope ? { scope } : {}),
    // --task使用時のstdinは実行中のsteering専用となるため、task解決後も接続を維持する。
    controlInput: process.stdin,
    onDiagnostic: (message) => process.stderr.write(message),
  });
  process.stdout.write(result.answer.endsWith("\n") ? result.answer : `${result.answer}\n`);
}
