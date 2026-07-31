import { runPiListModels } from "../pi-runner.js";

/** bundled Piが利用可能として報告するmodel一覧をそのまま端末へ中継する。 */
export async function listPiModels(): Promise<void> {
  await runPiListModels();
}
