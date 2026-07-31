import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { PixariumError } from "./errors.js";

/** directory名と設定名の双方に適用する、path separatorを許さないWorker名形式。 */
export const WORKER_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Pi CLIへ渡せるthinking levelの固定集合。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** Worker設定から許可できる、Pi同梱tool名の固定集合。 */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
/** Workerの探索場所と優先順位に用いるscopeの固定集合。 */
export const WORKER_SCOPES = ["local", "global"] as const;
/** PiによるAGENTS.mdとCLAUDE.mdの自動探索をWorker単位で制御する固定集合。 */
export const CONTEXT_FILE_MODES = ["discover", "disabled"] as const;

/** WorkerがPiへ公開する一つのcommand toolを表す、永続設定のschema。 */
export const workerCommandDefinitionSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    executable: z.string().trim().min(1),
    arguments: z.literal("passthrough").optional(),
    args: z.array(z.string()).optional(),
    workingDirectory: z.string().trim().min(1).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
  })
  .strict()
  .refine((command) => command.arguments === undefined || command.args === undefined, {
    message: "arguments and args cannot be specified together",
  });

/** worker.yamlで定義し、検証後にExtensionへ渡すcommand tool設定。 */
export type WorkerCommandDefinition = z.infer<typeof workerCommandDefinitionSchema>;

/**
 * Worker設定名をPiが扱える小文字snake_caseのtool名へ変換する。
 * @param name worker.yamlに記載された空でないcommand名。
 * @returns Piへ公開するtool名。英数字を含まない場合は空文字列。
 */
export function normalizeCommandToolName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** YAMLの未知fieldを拒否し、実行層が扱うWorker定義を一度だけ検証するschema。 */
const workerDefinitionSchema = z
  .object({
    name: z
      .string()
      .regex(WORKER_NAME_PATTERN, "must use lowercase letters, numbers, and single hyphens"),
    kind: z.enum(["worker", "base"]).default("worker"),
    description: z.string().trim().min(1),
    extends: z
      .string()
      .regex(/^global:[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must use the form "global:<worker-name>"')
      .optional(),
    model: z.string().trim().min(1).optional(),
    thinking: z.enum(THINKING_LEVELS).optional(),
    systemPrompt: z.string().trim().min(1).optional(),
    skill: z.string().trim().min(1).optional(),
    skillMode: z.enum(["extend", "replace"]).optional(),
    tools: z.array(z.enum(BUILTIN_TOOLS)).optional(),
    commands: z.array(workerCommandDefinitionSchema).optional(),
    contextFiles: z.enum(CONTEXT_FILE_MODES).optional(),
    timeoutSeconds: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .superRefine((definition, context) => {
    const configuredNames = new Set<string>();
    const toolNames = new Set<string>(definition.tools ?? []);
    for (const [index, command] of (definition.commands ?? []).entries()) {
      if (configuredNames.has(command.name)) {
        context.addIssue({
          code: "custom",
          path: ["commands", index, "name"],
          message: `duplicate command name "${command.name}"`,
        });
      }
      configuredNames.add(command.name);
      const toolName = normalizeCommandToolName(command.name);
      if (!toolName) {
        context.addIssue({
          code: "custom",
          path: ["commands", index, "name"],
          message: "must contain at least one ASCII letter or number",
        });
      } else if (toolNames.has(toolName)) {
        context.addIssue({
          code: "custom",
          path: ["commands", index, "name"],
          message: `normalized tool name "${toolName}" is duplicated`,
        });
      }
      toolNames.add(toolName);
    }
  });

export type WorkerDefinition = z.infer<typeof workerDefinitionSchema>;
export type WorkerScope = (typeof WORKER_SCOPES)[number];

/** Worker identityをfilesystem上の設定directoryとfileへ対応付けるlocation情報。 */
export interface WorkerLocation {
  /** Workerがrepository固有かユーザー共通かを示す解決済みscope。 */
  scope: WorkerScope;
  /** filesystem上のdirectory名。worker.yamlのnameとの一致検証にも使う。 */
  directoryName: string;
  /** Worker固有fileを格納するdirectoryの絶対path。 */
  directoryPath: string;
  /** Worker定義を読み込むworker.yamlの絶対path。 */
  configPath: string;
}

/** @returns global Workerとruntime設定を保持するユーザー単位のPixarium home。 */
export function pixariumHome(): string {
  return path.join(homedir(), ".pixarium");
}

/**
 * @param repositoryRoot 対象Git repositoryのroot。
 * @returns repository固有Workerを置くdirectory。
 */
export function localWorkersRoot(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".pixarium", "workers");
}

/** @returns 全repositoryから参照できるglobal Workerのroot directory。 */
export function globalWorkersRoot(): string {
  return path.join(pixariumHome(), "workers");
}

/**
 * scopeを実際のWorker root directoryへ変換する。
 * @param scope localまたはglobalの探索scope。
 * @param repositoryRoot local scopeに必須のGit repository root。
 * @returns 選択scopeのWorker root directory。
 */
export function workersRoot(scope: WorkerScope, repositoryRoot?: string): string {
  if (scope === "global") return globalWorkersRoot();
  if (!repositoryRoot) {
    throw new PixariumError("local workers require a Git repository", "configuration");
  }
  return localWorkersRoot(repositoryRoot);
}

/**
 * Worker名が安全な単一directory名であることを保証する。
 * @param name 検証するWorker名。
 */
export function assertWorkerName(name: string): void {
  if (!WORKER_NAME_PATTERN.test(name)) {
    throw new PixariumError(
      `invalid worker name "${name}"; use lowercase letters, numbers, and single hyphens`,
      "worker",
    );
  }
}

/**
 * Worker identityを、読み込みに必要な絶対path群へ変換する。
 * @param scope Workerの保存scope。
 * @param name 検証対象のWorker名。
 * @param repositoryRoot local scopeに必要なrepository root。
 * @returns 設定fileを含むWorker location。
 */
export function workerLocation(
  scope: WorkerScope,
  name: string,
  repositoryRoot?: string,
): WorkerLocation {
  assertWorkerName(name);
  const directoryPath = path.join(workersRoot(scope, repositoryRoot), name);
  return {
    scope,
    directoryName: name,
    directoryPath,
    configPath: path.join(directoryPath, "worker.yaml"),
  };
}

/**
 * Worker locationにdirectoryが存在するかを調べる。
 * @param location 調査するWorker location。
 * @returns directoryが存在すればtrue。検査不能は構成errorとして送出する。
 */
export async function workerLocationExists(location: WorkerLocation): Promise<boolean> {
  try {
    return (await stat(location.directoryPath)).isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw new PixariumError(
      `cannot inspect worker directory ${location.directoryPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "configuration",
    );
  }
}

/**
 * 明示scope、local優先、global fallbackの順でWorker locationを解決する。
 * @param name 解決するWorker名。
 * @param repositoryRoot local Workerを探索できるrepository root。
 * @param scope 明示scope。指定時はfallbackしない。
 * @returns 読み込み対象として確定したlocation。
 */
export async function resolveWorkerLocation(
  name: string,
  repositoryRoot?: string,
  scope?: WorkerScope,
): Promise<WorkerLocation> {
  if (scope) return workerLocation(scope, name, repositoryRoot);
  // 同名local Workerはrepository固有の意図なので、globalより常に優先する。
  if (repositoryRoot) {
    const local = workerLocation("local", name, repositoryRoot);
    if (await workerLocationExists(local)) return local;
  }
  return workerLocation("global", name);
}

/**
 * 一つのscope直下にあるWorker directoryを名前順で列挙する。
 * @param scope 列挙するscope。
 * @param repositoryRoot local scopeに必要なrepository root。
 * @returns 発見したWorker location。root未作成時は空配列。
 */
export async function listWorkerLocations(
  scope: WorkerScope,
  repositoryRoot?: string,
): Promise<WorkerLocation[]> {
  const root = workersRoot(scope, repositoryRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw new PixariumError(
      `cannot read worker directory ${root}: ${error instanceof Error ? error.message : String(error)}`,
      "configuration",
    );
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      scope,
      directoryName: entry.name,
      directoryPath: path.join(root, entry.name),
      configPath: path.join(root, entry.name, "worker.yaml"),
    }));
}

/**
 * local優先規則を適用した実効Worker一覧を作る。
 * @param repositoryRoot local Workerも含める場合のrepository root。
 * @returns 同名global Workerを除いた名前順のlocation一覧。
 */
export async function listEffectiveWorkerLocations(
  repositoryRoot?: string,
): Promise<WorkerLocation[]> {
  const [local, global] = await Promise.all([
    repositoryRoot ? listWorkerLocations("local", repositoryRoot) : Promise.resolve([]),
    listWorkerLocations("global"),
  ]);
  // 実行時の解決規則と一覧表示を一致させるため、同名globalはここで隠す。
  const localNames = new Set(local.map((location) => location.directoryName));
  return [...local, ...global.filter((location) => !localNames.has(location.directoryName))].sort(
    (left, right) => left.directoryName.localeCompare(right.directoryName),
  );
}

/**
 * worker.yamlを読み、YAML構文と全fieldをschema検証する。
 * @param location 読み込むWorker location。
 * @returns default値を適用済みのWorker定義。
 */
export async function loadWorkerDefinition(location: WorkerLocation): Promise<WorkerDefinition> {
  let source: string;
  try {
    source = await readFile(location.configPath, "utf8");
  } catch (error) {
    throw new PixariumError(
      `${location.configPath}: ${error instanceof Error ? error.message : String(error)}`,
      "worker",
    );
  }

  let value: unknown;
  try {
    value = parse(source);
  } catch (error) {
    throw new PixariumError(
      `${location.configPath}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
      "worker",
    );
  }

  // safeParseで全issueを集め、一回のcheckで修正箇所をまとめて報告する。
  const result = workerDefinitionSchema.safeParse(value);
  if (!result.success) {
    const reasons = result.error.issues
      .map((issue) => {
        const field = issue.path.length > 0 ? issue.path.join(".") : "document";
        return `${field}: ${issue.message}`;
      })
      .join("; ");
    throw new PixariumError(`${location.configPath}: ${reasons}`, "worker");
  }

  return result.data;
}
