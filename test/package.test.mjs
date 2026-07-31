import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/** npm公開設定とbuild成果物をrepository相対で検査するproject root。 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 目的: npmから導入した利用者とCodex Pluginが同じCLIを実行できることを保証する。
 * 対象: package manifestの公開対象、CLI bin、公開可否。
 * 前提: test実行前にbuildが完了し、dist配下へCLI entry scriptが生成されている。
 */
test("npm package exposes the Pixarium CLI entry point", async () => {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

  assert.equal(packageJson.private, undefined);
  assert.deepEqual(packageJson.bin, { pixarium: "./dist/cli.js" });
  assert.deepEqual(packageJson.files, ["dist/", "README.md"]);
  assert.equal(packageJson.publishConfig.access, "public");

  for (const entryPath of Object.values(packageJson.bin)) {
    const absoluteEntryPath = path.join(projectRoot, entryPath);
    const [content, entryStat] = await Promise.all([
      readFile(absoluteEntryPath, "utf8"),
      stat(absoluteEntryPath),
    ]);
    assert.match(content, /^#!\/usr\/bin\/env node\n/);
    assert.equal(entryStat.mode & 0o111, 0o111);
  }
});

/**
 * 目的: 削除済みのMCP server生成物が過去のbuildからnpm公開物へ残らないことを保証する。
 * 対象: build前のdist初期化と、現在のCLIのみから成る生成結果。
 * 前提: test実行前にbuildが完了している。
 */
test("build removes the obsolete MCP server entry point", async () => {
  await assert.rejects(readFile(path.join(projectRoot, "dist/mcp-server.js"), "utf8"), {
    code: "ENOENT",
  });
});
