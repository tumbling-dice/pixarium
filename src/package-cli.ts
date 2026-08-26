import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** ESM package名を公開entrypoint URLへ変換するNode互換resolver。 */
export type PackageResolver = (specifier: string) => string;

/**
 * Pixariumの依存グラフから、Pi packageが同梱するCLI scriptを解決する。
 * npmはglobal installの依存をpackage内または上位node_modulesへ配置できるため、
 * 配置場所ではなくESM package resolutionを基準にする。
 * @param packageName CLIを提供する直接依存package名。
 * @param resolvePackage packageの公開entrypointを返すresolver。
 * @returns packageの公開entrypointと同じdist directoryにあるCLI scriptの絶対path。
 */
export function resolvePackageCli(
  packageName: string,
  resolvePackage: PackageResolver = (specifier) => import.meta.resolve(specifier),
): string {
  const packageEntryPoint = fileURLToPath(resolvePackage(packageName));
  return join(dirname(packageEntryPoint), "cli.js");
}
