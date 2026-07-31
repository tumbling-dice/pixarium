import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PixariumError } from "./errors.js";

/** callback形式のexecFileをawait可能にし、Git root解決のerror境界を一箇所に保つ関数。 */
const execFileAsync = promisify(execFile);

/**
 * candidateがparent自身またはその子孫かをpath区切り単位で判定する。
 * @param parent 保護対象となる親path。
 * @param candidate 内包関係を調べるpath。
 * @returns candidateがparentの範囲内ならtrue。
 */
function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 未作成の末尾要素を許容しつつ、存在する最寄りの祖先までsymlinkを解決する。
 * @param target 正規化するdirectory path。
 * @returns 将来作成される末尾を含む正規pathと、実在する祖先。
 */
async function resolveWithExistingAncestor(
  target: string,
): Promise<{ resolved: string; existingAncestor: string }> {
  let candidate = path.resolve(target);
  const missingParts: string[] = [];
  while (true) {
    try {
      const existingAncestor = await realpath(candidate);
      return {
        resolved: path.resolve(existingAncestor, ...missingParts.reverse()),
        existingAncestor,
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw new PixariumError(
          `cannot resolve credential directory ${target}: ${error instanceof Error ? error.message : String(error)}`,
          "configuration",
        );
      }
      // 存在する祖先に達するまで末尾を退避し、symlink外への見かけ上のpathを見逃さない。
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw new PixariumError(`cannot resolve credential directory ${target}`, "configuration");
      }
      missingParts.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Pi credential directoryがPixarium homeや対象repository内にないことを保証する。
 * @param target PI_CODING_AGENT_DIRとして使用予定のpath。
 * @param protectedRoots credential保存を禁止するdirectory群。
 * @returns symlinkと未作成要素を正規化した安全なdirectory path。
 */
export async function requireCredentialDirectoryOutsideProtectedRoots(
  target: string,
  protectedRoots: string[],
): Promise<string> {
  const { resolved } = await resolveWithExistingAncestor(target);
  for (const protectedRoot of protectedRoots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = (await resolveWithExistingAncestor(protectedRoot)).resolved;
    } catch (error) {
      throw new PixariumError(
        `cannot resolve protected directory ${protectedRoot}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "configuration",
      );
    }
    if (isInside(canonicalRoot, resolved)) {
      throw new PixariumError(
        `refusing to store Pi credentials inside protected directory ${canonicalRoot}: ${resolved}`,
        "configuration",
      );
    }
  }
  return resolved;
}

/**
 * 指定directoryを含むGit repository rootを取得する。
 * @param cwd Git探索を開始するdirectory。
 * @returns Gitが報告したrepository root。
 */
export async function findGitRoot(cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    });
    const root = stdout.trim();
    if (!root) {
      throw new Error("git returned an empty repository root");
    }
    return root;
  } catch (error) {
    const detail =
      error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "git executable was not found"
        : "current directory is not inside a Git repository";
    throw new PixariumError(detail, "configuration");
  }
}

/**
 * Git repository外を正常な「未検出」として扱い、任意のlocal contextを探索する。
 * @param cwd Git探索を開始するdirectory。
 * @returns repository root。Gitが利用不能またはrepository外ならundefined。
 */
export async function findGitRootIfPresent(cwd = process.cwd()): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 実行対象がGit repository内の任意pathではなくrepository rootそのものか検証する。
 * @param candidate callerが対象repository rootとして指定したpath。
 * @returns symlinkを解決したGit repository root。
 */
export async function requireGitRepositoryRoot(candidate: string): Promise<string> {
  let requestedRoot: string;
  try {
    requestedRoot = await realpath(candidate);
  } catch (error) {
    throw new PixariumError(
      `repository root cannot be resolved: ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
      "configuration",
    );
  }
  const gitRoot = await realpath(await findGitRoot(requestedRoot));
  if (requestedRoot !== gitRoot) {
    throw new PixariumError(
      `repositoryRoot must identify the Git repository root: ${candidate}`,
      "configuration",
    );
  }
  return gitRoot;
}
