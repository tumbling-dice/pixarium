import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PixariumError } from "../errors.js";
import { assertWorkerName, workerLocation, type WorkerScope } from "../worker-loader.js";

/** 新規Workerの配置scope、種別、継承関係を指定する作成option。 */
export interface InitWorkerOptions {
  /** Workerを対象repository内へ置くか、ユーザー共通領域へ置くか。 */
  scope: WorkerScope;
  /** 実行用Workerではなく、global継承元のbaseとして作成する場合はtrue。 */
  base: boolean;
  /** local Workerが継承する`global:<name>`形式のbase identity。 */
  extendsWorker?: string | undefined;
}

/**
 * 選択したWorker種別に必要なworker.yaml雛形を生成する。
 * @param name 新規Worker名。
 * @param options scope、base、継承の作成option。
 * @returns 利用者が具体値へ編集するYAML文字列。
 */
function workerYaml(name: string, options: InitWorkerOptions): string {
  if (options.base) {
    return `name: ${name}
kind: base
description: このbase Workerが提供する共通方針を記述する

model: openai/model-name
thinking: high

systemPrompt: ./SYSTEM.md
skill: ./skill/SKILL.md

tools:
  - read
  - grep
  - find
  - ls

contextFiles: disabled
`;
  }
  if (options.extendsWorker) {
    return `name: ${name}
description: このWorkerが担当するプロジェクト固有の作業を記述する

extends: ${options.extendsWorker}

systemPrompt: ./SYSTEM.md
skill: ./skill/SKILL.md
skillMode: extend
`;
  }
  return `name: ${name}
description: このWorkerが担当する作業を記述する

model: openai/model-name
thinking: high

systemPrompt: ./SYSTEM.md
skill: ./skill/SKILL.md

tools:
  - read
  - grep
  - find
  - ls

contextFiles: disabled
`;
}

/**
 * baseまたは通常Workerの責務境界を示すSYSTEM.md雛形を生成する。
 * @param name 新規Worker名。
 * @param base 共通方針用baseを生成するか。
 * @returns SYSTEM.mdの初期内容。
 */
function systemPrompt(name: string, base: boolean): string {
  if (base) {
    return `# ${name} base worker

## Shared principles

- 複数のプロジェクトで共通して適用する判断方針を記述する。
- プロジェクト固有の条件はlocal Workerへ記述する。
`;
  }
  return `# ${name} worker

## Role

依頼された範囲を確認し、根拠を示して報告する。

## Allowed

- リポジトリ内の情報を読み取る。
- 確認できた事実と推測を区別する。

## Not allowed

- 許可されていない変更や外部操作を行わない。
- 根拠を確認できない内容を断定しない。

## Final answer

確認した範囲、結果、根拠、不明点を含める。
`;
}

/**
 * baseまたは通常Workerが実行する手順のSKILL.md雛形を生成する。
 * @param name 新規Worker名。
 * @param base 継承元として合成されるSkillを生成するか。
 * @returns frontmatterを含むSKILL.mdの初期内容。
 */
function skill(name: string, base: boolean): string {
  if (base) {
    return `---
name: ${name}-base
description: Apply the shared workflow defined by the ${name} base worker.
---

# ${name} shared workflow

1. 依頼内容と対象範囲を確認する。
2. 根拠を確認できた結果と推測を区別する。
3. プロジェクト固有のSkillがある場合は、その具体的な手順を続けて実行する。
`;
  }
  return `---
name: ${name}-task
description: Complete the repository task assigned to the ${name} worker.
---

# ${name} task

1. 依頼内容と対象範囲を確認する。
2. 必要なリポジトリ情報を読み取る。
3. 根拠を確認できた結果だけを整理する。
4. 確認した範囲、結果、根拠、不明点を報告する。

根拠を確認できない場合や作業範囲を超える場合は、断定せず判断を保留する。
`;
}

/**
 * option整合性を検証し、既存fileを上書きせずWorker雛形一式を作る。
 * @param repositoryRoot local scopeの場合のGit repository root。
 * @param name 作成するWorker名。
 * @param options scope、base、継承の作成option。
 */
export async function initWorker(
  repositoryRoot: string | undefined,
  name: string,
  options: InitWorkerOptions,
): Promise<void> {
  assertWorkerName(name);
  if (options.base && options.scope !== "global") {
    throw new PixariumError("--base requires --global", "configuration");
  }
  if (options.base && options.extendsWorker) {
    throw new PixariumError("--base cannot be combined with --extends", "configuration");
  }
  if (options.extendsWorker && options.scope !== "local") {
    throw new PixariumError("--extends requires local scope", "configuration");
  }
  if (options.extendsWorker && !/^global:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.extendsWorker)) {
    throw new PixariumError('--extends must use the form "global:<worker-name>"', "configuration");
  }

  // directoryを排他的に作成してからfileを書くことで、既存Workerの部分上書きを防ぐ。
  const location = workerLocation(options.scope, name, repositoryRoot);
  await mkdir(path.dirname(location.directoryPath), { recursive: true });
  try {
    await mkdir(location.directoryPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new PixariumError(
        `worker "${name}" already exists at ${location.directoryPath}; no files were overwritten`,
        "worker",
      );
    } else {
      throw new PixariumError(
        `cannot create worker "${name}": ${error instanceof Error ? error.message : String(error)}`,
        "configuration",
      );
    }
  }
  await mkdir(path.join(location.directoryPath, "skill"));

  await Promise.all([
    writeFile(location.configPath, workerYaml(name, options), {
      encoding: "utf8",
      flag: "wx",
    }),
    writeFile(path.join(location.directoryPath, "SYSTEM.md"), systemPrompt(name, options.base), {
      encoding: "utf8",
      flag: "wx",
    }),
    writeFile(path.join(location.directoryPath, "skill", "SKILL.md"), skill(name, options.base), {
      encoding: "utf8",
      flag: "wx",
    }),
  ]);
  process.stdout.write(
    `Created ${options.base ? "base worker" : "worker"} "${name}" at ${location.directoryPath}\n`,
  );
}
