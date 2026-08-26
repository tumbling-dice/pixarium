import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { resolvePackageCli } from "../dist/package-cli.js";

/**
 * 目的: npmが依存をPixarium package外のnode_modulesへ配置してもCLIを解決できることを保証する。
 * 対象: packageの公開entrypointを基準にしたPi CLI path解決。
 * 前提: resolverはglobal installで平坦化されたpackageのdist/index.js URLを返す。
 */
test("resolves a package CLI from the package entry point instead of the Pixarium directory", async () => {
  const globalRoot = await mkdtemp(path.join(tmpdir(), "pixarium-global-layout-"));
  const packageDist = path.join(globalRoot, "node_modules", "@earendil-works", "pi-ai", "dist");
  await mkdir(packageDist, { recursive: true });
  const entryPoint = path.join(packageDist, "index.js");
  const cli = path.join(packageDist, "cli.js");
  await Promise.all([writeFile(entryPoint, ""), writeFile(cli, "")]);

  const resolved = resolvePackageCli("@earendil-works/pi-ai", (specifier) => {
    assert.equal(specifier, "@earendil-works/pi-ai");
    return pathToFileURL(entryPoint).href;
  });

  assert.equal(resolved, cli);
});
