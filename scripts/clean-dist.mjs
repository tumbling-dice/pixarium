import { rm } from "node:fs/promises";

/**
 * 現在のsrcに存在しない古いentry pointを公開物へ混入させないため、生成先をbuild前に空にする。
 * @returns {Promise<void>} distの削除が完了したときに解決するPromise。
 */
async function cleanDist() {
  await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
}

await cleanDist();
