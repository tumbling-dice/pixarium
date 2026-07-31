import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  executeWorkerCommand,
  formatCommandExecutionResult,
  type CommandExecutionResult,
} from "./command-executor.js";
import {
  normalizeCommandToolName,
  workerCommandDefinitionSchema,
  type WorkerCommandDefinition,
} from "./worker-loader.js";
import { z } from "zod";

/** Pi child processだけに渡す、Worker command群とproject rootの環境変数名。 */
export const COMMAND_TOOLS_CONFIG_ENV = "PIXARIUM_COMMAND_TOOLS_CONFIG";

/** 共通Extensionが起動時に受け取る、Worker一回分だけのcommand tool設定。 */
export interface CommandToolsExtensionConfig {
  /** 全commandのworkingDirectoryを解決するGit repository root。 */
  projectRoot: string;
  /** 対象Workerへだけ登録する検証済みcommand定義。 */
  commands: WorkerCommandDefinition[];
}

/** Extension process境界で環境変数を再検証するschema。 */
const extensionConfigSchema = z
  .object({
    projectRoot: z.string().trim().min(1),
    commands: z.array(workerCommandDefinitionSchema),
  })
  .strict();

/**
 * JSON環境変数を、Extensionが信頼できる一回分の設定へ変換する。
 * @param source Pi child processへ渡されたJSON文字列。
 * @returns schema検証済みExtension設定。
 */
export function parseCommandToolsExtensionConfig(
  source: string | undefined,
): CommandToolsExtensionConfig {
  if (!source) throw new Error(`${COMMAND_TOOLS_CONFIG_ENV} is missing`);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `${COMMAND_TOOLS_CONFIG_ENV} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return extensionConfigSchema.parse(value);
}

/**
 * 一回のPi processへ、対象Workerのcommandだけをtoolとして登録する。
 * @param pi Pi Extension API。
 * @param config project rootとWorker固有command群。
 */
export function registerCommandTools(pi: ExtensionAPI, config: CommandToolsExtensionConfig): void {
  for (const command of config.commands) {
    const name = normalizeCommandToolName(command.name);
    const parameters =
      command.arguments === "passthrough"
        ? Type.Object(
            {
              args: Type.Array(Type.String(), {
                description: "Arguments passed directly to the executable without shell expansion",
              }),
            },
            { additionalProperties: false },
          )
        : Type.Object({}, { additionalProperties: false });
    pi.registerTool({
      name,
      label: command.name,
      description:
        command.description ?? `Run ${command.executable} as the ${command.name} command`,
      parameters,
      async execute(_toolCallId, params, signal) {
        const requestedArgs =
          command.arguments === "passthrough" &&
          "args" in params &&
          Array.isArray(params.args) &&
          params.args.every((argument): argument is string => typeof argument === "string")
            ? params.args
            : [];
        const result = await executeWorkerCommand(command, requestedArgs, {
          projectRoot: config.projectRoot,
          ...(signal ? { signal } : {}),
        });
        return {
          content: [{ type: "text", text: formatCommandExecutionResult(command, result) }],
          details: result satisfies CommandExecutionResult,
        };
      },
    });
  }
}

/**
 * Pi child processの環境から一回分の設定を読み、Worker専用command toolを登録する。
 * @param pi Pi child processが提供するExtension API。
 */
export default function pixariumCommandToolsExtension(pi: ExtensionAPI): void {
  registerCommandTools(pi, parseCommandToolsExtensionConfig(process.env[COMMAND_TOOLS_CONFIG_ENV]));
}
