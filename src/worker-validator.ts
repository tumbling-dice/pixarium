import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { PIXARIUM_COMMON_SYSTEM_PROMPT } from "./common-system-prompt.js";
import { PixariumError } from "./errors.js";
import {
  loadWorkerDefinition,
  normalizeCommandToolName,
  workerLocation,
  type WorkerDefinition,
  type WorkerLocation,
} from "./worker-loader.js";

/** 継承元とlocal定義を合成し、実行に必要な値がすべて確定したWorker設定。 */
export interface EffectiveWorkerConfig {
  /** directory名との一致を検証済みのWorker名。 */
  name: string;
  /** Worker一覧や選択判断へ使う、人間向けの責務説明。 */
  description: string;
  /** Piへ渡すproviderを含むmodel identity。 */
  model: string;
  /** Piへ渡す、許可済み集合内のthinking level。 */
  thinking: NonNullable<WorkerDefinition["thinking"]>;
  /** Workerへ公開するPi builtin toolの一覧。 */
  tools: NonNullable<WorkerDefinition["tools"]>;
  /** Workerへ専用Pi toolとして公開するcommand定義。空配列ならExtensionを読み込まない。 */
  commands: NonNullable<WorkerDefinition["commands"]>;
  /** PiがAGENTS.mdとCLAUDE.mdを自動探索するかを示す実効mode。 */
  contextFiles: NonNullable<WorkerDefinition["contextFiles"]>;
  /** 実行を停止する秒数。nullは時間制限なし。 */
  timeoutSeconds: number | null;
}

/** directory内にあることと実在を検証済みのsystem prompt file。 */
export interface ValidatedPrompt {
  /** promptを提供したWorkerのscope。継承layerの識別に使う。 */
  scope: WorkerLocation["scope"];
  /** promptを提供したWorker名。合成promptの出典表示に使う。 */
  workerName: string;
  /** symlinkを解決し、Worker directory内と確認したfileの絶対path。 */
  path: string;
  /** fileから読み込んだ未加工のprompt全文。 */
  content: string;
}

/** file安全性とfrontmatterを検証し、Piへ組み込める形へ分解したSkill。 */
export interface ValidatedSkill extends ValidatedPrompt {
  /** SKILL.md frontmatterに記載されたSkill名。 */
  name: string;
  /** SKILL.md frontmatterに記載された適用条件の説明。 */
  description: string;
  /** frontmatterを除去し、実行promptへ埋め込むSkill本文。 */
  body: string;
  /** Skill本文内の相対参照を解決する基準directory。 */
  baseDirectory: string;
}

/** 継承合成と必須値検証を終え、Piで直接実行できるWorker。 */
export interface ValidatedWorker {
  /** unionを実行可能Workerへ絞り込む判別値。 */
  kind: "worker";
  /** 継承後に全必須値が確定した実効設定。 */
  config: EffectiveWorkerConfig;
  /** 実行対象として選択されたWorker自身のlocation。 */
  location: WorkerLocation;
  /** extendsを使用した場合に解決されたglobal baseのlocation。 */
  baseLocation?: WorkerLocation | undefined;
  /** 一般的なbaseから具体的なlocalの順に並べたprompt layer。 */
  systemPrompts: ValidatedPrompt[];
  /** 優先規則を明記して全layerを連結した、Piへ渡す単一prompt。 */
  systemPrompt: string;
  /** replaceまたはextend規則を適用後のSkill layer一覧。 */
  skills: ValidatedSkill[];
}

/** 継承元としては有効だが、単体では実行できないglobal baseの検証結果。 */
export interface ValidatedBase {
  /** unionをbaseへ絞り込む判別値。 */
  kind: "base";
  /** schemaとbase固有制約を検証済みの元定義。 */
  definition: WorkerDefinition;
  /** global scopeであることを確認済みのbase location。 */
  location: WorkerLocation;
  /** baseが提供する任意のsystem prompt。 */
  systemPrompt?: ValidatedPrompt | undefined;
  /** baseが提供する任意のSkill。 */
  skill?: ValidatedSkill | undefined;
}

export type ValidatedWorkerDefinition = ValidatedWorker | ValidatedBase;

/**
 * candidateがparent自身または子孫かをpath segment単位で判定する。
 * @param parent Worker directoryの基準path。
 * @param candidate 参照先として検査するpath。
 * @returns candidateがparent内ならtrue。
 */
function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Workerから参照されたfileがdirectory外へ脱出せず、通常fileとして読めることを検証する。
 * @param location 参照元のWorker location。
 * @param field 診断に使う設定field名。
 * @param configuredPath worker.yamlに記載された相対path。
 * @returns symlink解決済みpathとfile内容。
 */
async function validateReferencedFile(
  location: WorkerLocation,
  field: "systemPrompt" | "skill",
  configuredPath: string,
): Promise<{ path: string; content: string }> {
  const resolved = path.resolve(location.directoryPath, configuredPath);
  // 字句的な`..`とsymlinkによる脱出を別々に検査し、未解決pathも実pathも守る。
  if (!isInside(location.directoryPath, resolved)) {
    throw new PixariumError(
      `${location.configPath}: ${field} points outside worker directory: ${configuredPath}`,
      "worker",
    );
  }

  let workerRealPath: string;
  let fileRealPath: string;
  try {
    [workerRealPath, fileRealPath] = await Promise.all([
      realpath(location.directoryPath),
      realpath(resolved),
    ]);
  } catch {
    throw new PixariumError(
      `${location.configPath}: ${field} file does not exist: ${configuredPath}`,
      "worker",
    );
  }

  if (!isInside(workerRealPath, fileRealPath)) {
    throw new PixariumError(
      `${location.configPath}: ${field} resolves outside worker directory: ${configuredPath}`,
      "worker",
    );
  }

  const fileStat = await stat(fileRealPath);
  if (!fileStat.isFile()) {
    throw new PixariumError(
      `${location.configPath}: ${field} is not a file: ${configuredPath}`,
      "worker",
    );
  }

  return { path: fileRealPath, content: await readFile(fileRealPath, "utf8") };
}

/**
 * SKILL.mdの先頭frontmatterを検証し、Pi promptへ渡す本文とmetadataへ分離する。
 * @param skillPath errorに含めるSkill file path。
 * @param source SKILL.mdの全文。
 * @returns 必須metadataとfrontmatterを除いた本文。
 */
function parseSkillFrontmatter(
  skillPath: string,
  source: string,
): { name: string; description: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match?.[1]) {
    throw new PixariumError(`${skillPath}: Skill frontmatter is missing`, "worker");
  }

  let value: unknown;
  try {
    value = parse(match[1]);
  } catch (error) {
    throw new PixariumError(
      `${skillPath}: invalid Skill frontmatter YAML: ${error instanceof Error ? error.message : String(error)}`,
      "worker",
    );
  }

  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    value.name.trim() === ""
  ) {
    throw new PixariumError(`${skillPath}: Skill frontmatter requires a non-empty name`, "worker");
  }
  if (
    !("description" in value) ||
    typeof value.description !== "string" ||
    value.description.trim() === ""
  ) {
    throw new PixariumError(
      `${skillPath}: Skill frontmatter requires a non-empty description`,
      "worker",
    );
  }

  return {
    name: value.name,
    description: value.description,
    body: source.slice(match[0].length).trim(),
  };
}

/**
 * 任意のsystemPrompt参照を検証済みpromptへ変換する。
 * @param location 参照元Worker location。
 * @param configuredPath 設定された相対path。未指定なら読み込まない。
 * @returns scope情報を付加したprompt、またはundefined。
 */
async function loadPrompt(
  location: WorkerLocation,
  configuredPath?: string,
): Promise<ValidatedPrompt | undefined> {
  if (!configuredPath) return undefined;
  const file = await validateReferencedFile(location, "systemPrompt", configuredPath);
  return {
    scope: location.scope,
    workerName: location.directoryName,
    path: file.path,
    content: file.content,
  };
}

/**
 * 任意のSkill参照を検証し、frontmatterと相対参照基準を付加する。
 * @param location 参照元Worker location。
 * @param configuredPath 設定された相対path。未指定なら読み込まない。
 * @returns 実行promptへ組み込めるSkill、またはundefined。
 */
async function loadSkill(
  location: WorkerLocation,
  configuredPath?: string,
): Promise<ValidatedSkill | undefined> {
  if (!configuredPath) return undefined;
  const file = await validateReferencedFile(location, "skill", configuredPath);
  const frontmatter = parseSkillFrontmatter(file.path, file.content);
  return {
    scope: location.scope,
    workerName: location.directoryName,
    path: file.path,
    content: file.content,
    name: frontmatter.name,
    description: frontmatter.description,
    body: frontmatter.body,
    baseDirectory: path.dirname(file.path),
  };
}

/**
 * 一つのWorker定義について、継承に依存しない自己整合性と参照fileを検証する。
 * @param location 検証対象のWorker location。
 * @returns schema検証済み定義と任意のprompt/Skill。
 */
async function validateOwnDefinition(location: WorkerLocation): Promise<{
  definition: WorkerDefinition;
  systemPrompt?: ValidatedPrompt | undefined;
  skill?: ValidatedSkill | undefined;
}> {
  const definition = await loadWorkerDefinition(location);
  if (definition.name !== location.directoryName) {
    throw new PixariumError(
      `${location.configPath}: name "${definition.name}" does not match directory "${location.directoryName}"`,
      "worker",
    );
  }
  // baseは複数repositoryから共有する契約なので、local配置による曖昧な継承を禁止する。
  if (definition.kind === "base" && location.scope !== "global") {
    throw new PixariumError(`${location.configPath}: base workers must use global scope`, "worker");
  }
  if (definition.kind === "base" && definition.extends) {
    throw new PixariumError(
      `${location.configPath}: base workers cannot extend another worker`,
      "worker",
    );
  }
  if (definition.extends && location.scope !== "local") {
    throw new PixariumError(`${location.configPath}: only local workers can use extends`, "worker");
  }
  if (definition.skillMode && !definition.extends) {
    throw new PixariumError(
      `${location.configPath}: skillMode requires an inherited worker`,
      "worker",
    );
  }
  if (definition.skillMode === "replace" && !definition.skill) {
    throw new PixariumError(
      `${location.configPath}: skillMode "replace" requires a local skill`,
      "worker",
    );
  }

  const [systemPrompt, skill] = await Promise.all([
    loadPrompt(location, definition.systemPrompt),
    loadSkill(location, definition.skill),
  ]);
  return { definition, systemPrompt, skill };
}

/**
 * 継承合成後に必須となる値を取り出し、不足時は元Worker位置を含むerrorにする。
 * @param value localまたはbaseから解決した値。
 * @param location 診断対象のWorker location。
 * @param field 不足している設定field名。
 * @returns undefinedでない値。
 */
function required<T>(value: T | undefined, location: WorkerLocation, field: string): T {
  if (value === undefined) {
    throw new PixariumError(`${location.configPath}: effective worker requires ${field}`, "worker");
  }
  return value;
}

/**
 * 継承後のbuiltinとcommandが同じPi tool名を要求しないことを保証する。
 * @param config 配列置換と既定値を適用済みの実効設定。
 * @param location 診断へ含める実行対象Worker位置。
 */
function assertDistinctEffectiveTools(
  config: Pick<EffectiveWorkerConfig, "tools" | "commands">,
  location: WorkerLocation,
): void {
  const names = new Set<string>(config.tools);
  for (const command of config.commands) {
    const toolName = normalizeCommandToolName(command.name);
    if (names.has(toolName)) {
      throw new PixariumError(
        `${location.configPath}: command "${command.name}" duplicates effective Pi tool name "${toolName}"`,
        "worker",
      );
    }
    names.add(toolName);
  }
}

/**
 * Pixarium共通、base、localの順にsystem promptを連結し、競合時の優先規則を明文化する。
 * @param prompts 一般から具体の順に並んだ検証済みprompt。
 * @returns Piへ一つのsystem promptとして渡す文字列。
 */
function composeSystemPrompt(prompts: ValidatedPrompt[]): string {
  const workerLayers = prompts.map(
    (prompt) =>
      `# Pixarium ${prompt.scope} system prompt: ${prompt.workerName}\n\n${prompt.content.trim()}`,
  );
  const layers = [
    `# Pixarium common system prompt\n\n${PIXARIUM_COMMON_SYSTEM_PROMPT}`,
    ...workerLayers,
  ];
  return (
    "The following system prompt layers are ordered from general to specific. " +
    "When they conflict, the later layer applies.\n\n" +
    layers.join("\n\n")
  );
}

/**
 * Worker定義を検証し、必要ならglobal baseを合成した実効設定を作る。
 * @param location 検証するlocalまたはglobal Worker location。
 * @returns baseの検証結果、または実行可能なWorker設定。
 */
export async function validateWorkerDefinition(
  location: WorkerLocation,
): Promise<ValidatedWorkerDefinition> {
  const own = await validateOwnDefinition(location);
  if (own.definition.kind === "base") {
    return {
      kind: "base",
      definition: own.definition,
      location,
      systemPrompt: own.systemPrompt,
      skill: own.skill,
    };
  }

  let base:
    | {
        definition: WorkerDefinition;
        location: WorkerLocation;
        systemPrompt?: ValidatedPrompt | undefined;
        skill?: ValidatedSkill | undefined;
      }
    | undefined;
  // extends形式をglobalに限定済みなので、循環継承なしの一段だけを安全に合成できる。
  if (own.definition.extends) {
    const baseName = own.definition.extends.slice("global:".length);
    const baseLocation = workerLocation("global", baseName);
    const inherited = await validateOwnDefinition(baseLocation);
    if (inherited.definition.kind !== "base") {
      throw new PixariumError(
        `${location.configPath}: extends target ${own.definition.extends} is not a base worker`,
        "worker",
      );
    }
    base = { ...inherited, location: baseLocation };
  }

  const systemPrompts = [base?.systemPrompt, own.systemPrompt].filter(
    (prompt): prompt is ValidatedPrompt => prompt !== undefined,
  );
  // replaceはbase Skillを完全に外し、extendは一般から具体の順を保つ。
  const skills =
    own.definition.skillMode === "replace"
      ? [own.skill].filter((skill): skill is ValidatedSkill => skill !== undefined)
      : [base?.skill, own.skill].filter((skill): skill is ValidatedSkill => skill !== undefined);

  const config: EffectiveWorkerConfig = {
    name: own.definition.name,
    description: own.definition.description,
    model: required(own.definition.model ?? base?.definition.model, location, "model"),
    thinking: required(own.definition.thinking ?? base?.definition.thinking, location, "thinking"),
    tools: required(own.definition.tools ?? base?.definition.tools, location, "tools"),
    // toolsと同じく配列全体を置換し、local定義がbaseのcommand権限を意図せず足し合わせないようにする。
    commands: own.definition.commands ?? base?.definition.commands ?? [],
    contextFiles: own.definition.contextFiles ?? base?.definition.contextFiles ?? "disabled",
    timeoutSeconds:
      own.definition.timeoutSeconds !== undefined
        ? own.definition.timeoutSeconds
        : (base?.definition.timeoutSeconds ?? null),
  };
  assertDistinctEffectiveTools(config, location);
  if (systemPrompts.length === 0) {
    throw new PixariumError(
      `${location.configPath}: effective worker requires systemPrompt`,
      "worker",
    );
  }
  if (skills.length === 0) {
    throw new PixariumError(`${location.configPath}: effective worker requires skill`, "worker");
  }

  return {
    kind: "worker",
    config,
    location,
    baseLocation: base?.location,
    systemPrompts,
    systemPrompt: composeSystemPrompt(systemPrompts),
    skills,
  };
}

/**
 * locationが実行可能なWorkerであることを保証し、base単体の実行を拒否する。
 * @param location 実行対象として選ばれたWorker location。
 * @returns 継承解決済みの実行可能Worker。
 */
export async function validateWorker(location: WorkerLocation): Promise<ValidatedWorker> {
  const validated = await validateWorkerDefinition(location);
  if (validated.kind === "base") {
    throw new PixariumError(
      `${location.configPath}: base worker "${validated.definition.name}" cannot be run`,
      "worker",
    );
  }
  return validated;
}
