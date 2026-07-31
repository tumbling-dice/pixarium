import { formatError } from "../errors.js";
import {
  listEffectiveWorkerLocations,
  listWorkerLocations,
  type WorkerDefinition,
  type WorkerLocation,
  type WorkerScope,
} from "../worker-loader.js";
import { validateWorkerDefinition, type ValidatedWorkerDefinition } from "../worker-validator.js";

export type ListScope = WorkerScope | "effective";

/**
 * list用scopeを実際のWorker location群へ変換する。
 * @param repositoryRoot local探索に使えるrepository root。
 * @param scope local、global、またはlocal優先を適用するeffective。
 * @returns 表示候補のlocation一覧。
 */
async function locationsForScope(
  repositoryRoot: string | undefined,
  scope: ListScope,
): Promise<WorkerLocation[]> {
  return scope === "effective"
    ? listEffectiveWorkerLocations(repositoryRoot)
    : listWorkerLocations(scope, repositoryRoot);
}

/**
 * 検証済み定義を、内部pathやprompt本文を含まない公開JSONへ射影する。
 * @param worker baseまたは実行可能Workerの検証結果。
 * @returns list --jsonへ含める公開field。
 */
function jsonValue(worker: ValidatedWorkerDefinition): object {
  if (worker.kind === "base") {
    return {
      name: worker.definition.name,
      kind: worker.kind,
      scope: worker.location.scope,
      description: worker.definition.description,
      model: worker.definition.model,
      thinking: worker.definition.thinking,
      tools: worker.definition.tools,
      commands: worker.definition.commands,
      contextFiles: worker.definition.contextFiles,
      timeoutSeconds: worker.definition.timeoutSeconds,
    };
  }
  return {
    name: worker.config.name,
    kind: worker.kind,
    scope: worker.location.scope,
    description: worker.config.description,
    extends: worker.baseLocation ? `global:${worker.baseLocation.directoryName}` : undefined,
    model: worker.config.model,
    thinking: worker.config.thinking,
    tools: worker.config.tools,
    commands: worker.config.commands,
    contextFiles: worker.config.contextFiles,
    timeoutSeconds: worker.config.timeoutSeconds,
  };
}

/**
 * 検証済みWorker一件を、人が端末で比較できる複数行形式へ出力する。
 * @param worker baseまたは実行可能Workerの検証結果。
 */
function writeHuman(worker: ValidatedWorkerDefinition): void {
  if (worker.kind === "base") {
    process.stdout.write(
      `${worker.definition.name} [${worker.location.scope}, base]\n` +
        `  description: ${worker.definition.description}\n` +
        `  model: ${worker.definition.model ?? "(incomplete)"}\n` +
        `  thinking: ${worker.definition.thinking ?? "(incomplete)"}\n` +
        `  tools: ${worker.definition.tools?.join(", ") ?? "(incomplete)"}\n` +
        `  commands: ${formatCommands(worker.definition.commands)}\n` +
        `  bash: ${worker.definition.tools?.includes("bash") ? "enabled" : "disabled"}\n` +
        `  context files: ${worker.definition.contextFiles ?? "disabled (default)"}\n` +
        `  timeout: ${formatTimeout(worker.definition.timeoutSeconds)}\n`,
    );
    return;
  }
  process.stdout.write(
    `${worker.config.name} [${worker.location.scope}]\n` +
      `  description: ${worker.config.description}\n` +
      `${worker.baseLocation ? `  extends: global:${worker.baseLocation.directoryName}\n` : ""}` +
      `  model: ${worker.config.model}\n` +
      `  thinking: ${worker.config.thinking}\n` +
      `  tools: ${worker.config.tools.join(", ")}\n` +
      `  commands: ${formatCommands(worker.config.commands)}\n` +
      `  bash: ${worker.config.tools.includes("bash") ? "enabled" : "disabled"}\n` +
      `  context files: ${worker.config.contextFiles}\n` +
      `  timeout: ${formatTimeout(worker.config.timeoutSeconds)}\n`,
  );
}

/**
 * command定義を固定引数とpassthroughの差が分かる一覧表記へ変換する。
 * @param commands Worker自身または継承後のcommand配列。
 * @returns 一行で比較できるcommand一覧。
 */
function formatCommands(commands: WorkerDefinition["commands"]): string {
  if (!commands || commands.length === 0) return "(none)";
  return commands
    .map((command) =>
      command.arguments === "passthrough"
        ? `${command.name} [passthrough]`
        : `${command.name} [${(command.args ?? []).join(" ") || "no arguments"}]`,
    )
    .join(", ");
}

/**
 * nullableなtimeout設定を一覧用の表示へ変換する。
 * @param timeoutSeconds 秒数、明示的な無制限、またはbase未設定。
 * @returns 人間向けtimeout表記。
 */
function formatTimeout(timeoutSeconds: number | null | undefined): string {
  if (timeoutSeconds === undefined) return "unlimited";
  if (timeoutSeconds === null) return "unlimited";
  return `${timeoutSeconds} seconds`;
}

/**
 * Worker一覧を検証し、validな項目とinvalid診断を別streamへ出力する。
 * @param repositoryRoot local探索に使えるrepository root。
 * @param json trueなら機械可読JSONをstdoutへ出力する。
 * @param scope 一覧へ適用するscope規則。
 * @returns 不正Workerがなければ0、あれば1。
 */
export async function listWorkers(
  repositoryRoot: string | undefined,
  json: boolean,
  scope: ListScope,
): Promise<number> {
  const locations = await locationsForScope(repositoryRoot, scope);
  if (locations.length === 0) {
    if (json) {
      process.stdout.write("[]\n");
    } else {
      process.stdout.write("No workers found in the selected scope.\n");
    }
    return 0;
  }

  // invalidな一件で一覧全体を失わないよう、検証結果をallSettledで個別収集する。
  const results = await Promise.allSettled(locations.map(validateWorkerDefinition));
  const valid: ValidatedWorkerDefinition[] = [];
  const invalid: unknown[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      if (scope !== "effective" || result.value.kind === "worker") {
        valid.push(result.value);
      }
    } else {
      invalid.push(result.reason);
    }
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(valid.map(jsonValue), null, 2)}\n`);
  } else {
    for (const worker of valid) writeHuman(worker);
  }

  for (const error of invalid) {
    process.stderr.write(`${formatError(error)}\n`);
  }
  return invalid.length > 0 ? 1 : 0;
}
