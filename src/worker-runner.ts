import { PixariumError } from "./errors.js";
import { runPi } from "./pi-runner.js";
import { requireGitRepositoryRoot } from "./repository.js";
import { resolveWorkerLocation, type WorkerScope } from "./worker-loader.js";
import { validateWorker } from "./worker-validator.js";

/** CLIからWorkerを実行するときのrepository、選択条件、入出力option。 */
export interface ExecuteWorkerOptions {
  /** Workerを実行する対象Git repositoryのroot path。 */
  repositoryRoot: string;
  /** 解決して実行するWorker名。 */
  name: string;
  /** fallbackを許さずlocalまたはglobalへ限定する任意scope。 */
  scope?: WorkerScope;
  /** Workerへ渡す空白以外を含む依頼本文。 */
  task: string;
  /** Worker設定を上書きする正の秒数。nullは明示的な無制限。 */
  timeoutSeconds?: number | null;
  /** 実行中のsteering JSON lineを受け取る任意stream。 */
  controlInput?: NodeJS.ReadableStream;
  /** steeringの受理・拒否など、回答本文に混ぜない診断の出力先。 */
  onDiagnostic?: (message: string) => void;
}

/** interface層がPi内部型へ依存せず、回答と解決済みWorker identityを受け取る結果。 */
export interface ExecuteWorkerResult {
  /** Pi event streamから確定したWorkerの最終assistant回答。 */
  answer: string;
  /** worker.yaml検証後の正式なWorker名。 */
  worker: string;
  /** local優先規則または明示指定によって実際に選ばれたscope。 */
  scope: WorkerScope;
}

/**
 * repositoryとWorkerを検証してから共有Pi実行層を呼び出す。
 * @param options repository root、Worker選択、task、実行制御option。
 * @returns 最終回答と実際に解決したWorker identity。
 */
export async function executeWorker(options: ExecuteWorkerOptions): Promise<ExecuteWorkerResult> {
  // taskの取得方法に関係なく、Worker解決前の同じ境界で空白だけの入力を拒否する。
  const task = options.task.trim();
  if (!task) {
    throw new PixariumError("task is empty", "configuration");
  }
  // Worker解決より先にrepositoryを正規化し、symlink経由のscope誤判定を避ける。
  const repositoryRoot = await requireGitRepositoryRoot(options.repositoryRoot);
  const location = await resolveWorkerLocation(options.name, repositoryRoot, options.scope);
  const worker = await validateWorker(location);
  const answer = await runPi(worker, task, repositoryRoot, {
    ...(options.timeoutSeconds !== undefined ? { timeoutSeconds: options.timeoutSeconds } : {}),
    ...(options.controlInput ? { controlInput: options.controlInput } : {}),
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
  });
  return { answer, worker: worker.config.name, scope: worker.location.scope };
}
