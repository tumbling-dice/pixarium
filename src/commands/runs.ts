import { listActiveRuns } from "../run-observer.js";

/**
 * run開始日時を、一覧で比較しやすい固定幅の経過時間へ変換する。
 * @param startedAt ISO 8601形式のrun開始日時。
 * @returns `HH:MM:SS`形式の経過時間。時計ずれによる負値は0に丸める。
 */
function formatElapsed(startedAt: string): string {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

/**
 * 現在生存しているrunを機械可読または人間向け形式でstdoutへ出力する。
 * @param json trueならActiveRun配列をJSONとして出力する。
 */
export async function listRuns(json: boolean): Promise<void> {
  const runs = await listActiveRuns();
  if (json) {
    process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
    return;
  }
  if (runs.length === 0) {
    process.stdout.write("No active runs.\n");
    return;
  }
  process.stdout.write("RUN ID    WORKER  SCOPE  ELAPSED\n");
  for (const run of runs) {
    process.stdout.write(
      `${run.id.slice(0, 8)}  ${run.worker}  ${run.scope}  ${formatElapsed(run.startedAt)}\n`,
    );
  }
}
