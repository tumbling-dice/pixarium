import { formatError, PixariumError } from "../errors.js";
import {
  listEffectiveWorkerLocations,
  listWorkerLocations,
  resolveWorkerLocation,
  type WorkerLocation,
  type WorkerScope,
} from "../worker-loader.js";
import { validateWorkerDefinition } from "../worker-validator.js";

/**
 * nameとscopeの指定から、check対象となるlocation集合を解決する。
 * @param repositoryRoot local探索に使えるrepository root。
 * @param name 単一Workerへ限定する任意の名前。
 * @param scope 明示scope。未指定なら実効Worker一覧を使う。
 * @returns validation対象のlocation一覧。
 */
async function selectedLocations(
  repositoryRoot: string | undefined,
  name: string | undefined,
  scope: WorkerScope | undefined,
): Promise<WorkerLocation[]> {
  if (name) {
    return [await resolveWorkerLocation(name, repositoryRoot, scope)];
  }
  return scope
    ? listWorkerLocations(scope, repositoryRoot)
    : listEffectiveWorkerLocations(repositoryRoot);
}

/**
 * 選択されたWorkerをすべて検証し、個別結果と集約終了codeを出力する。
 * @param repositoryRoot local Worker探索に使えるrepository root。
 * @param name 任意の単一Worker名。
 * @param scope 任意の明示scope。
 * @returns 全件成功なら0、一件以上失敗なら1。
 */
export async function checkWorkers(
  repositoryRoot: string | undefined,
  name?: string,
  scope?: WorkerScope,
): Promise<number> {
  const locations = await selectedLocations(repositoryRoot, name, scope);
  if (locations.length === 0) {
    throw new PixariumError("no workers found in the selected scope", "worker");
  }

  // 一件の不正定義で打ち切らず、全Workerの修正箇所を一回で確認できるよう集約する。
  let failures = 0;
  for (const location of locations) {
    try {
      const worker = await validateWorkerDefinition(location);
      process.stdout.write(`${location.directoryName} [${location.scope}, ${worker.kind}]: ok\n`);
    } catch (error) {
      failures += 1;
      process.stderr.write(`${formatError(error)}\n`);
    }
  }
  return failures > 0 ? 1 : 0;
}
