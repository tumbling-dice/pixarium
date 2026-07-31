#!/usr/bin/env node
import { writeSync } from "node:fs";
import { access, writeFile } from "node:fs/promises";

/** callerから渡されたPi agent directory。credential内容にはアクセスしない。 */
const piCodingAgentDirectory = process.env.PI_CODING_AGENT_DIR;
/** process境界からagent directoryへ到達可能だったかを記録するflag。 */
let piCodingAgentDirectoryAccessible = false;
if (piCodingAgentDirectory) {
  try {
    await access(piCodingAgentDirectory);
    piCodingAgentDirectoryAccessible = true;
  } catch {
    // fakeはcredential内容を読まず、Pi process境界からdirectoryへ到達できるかだけを記録する。
  }
}

/** testがPi起動引数、cwd、RPC command、安全なdirectory metadataを検証するための記録。 */
const invocationRecord = {
  args: process.argv.slice(2),
  cwd: process.cwd(),
  commands: [],
  piCodingAgentDirectory,
  piCodingAgentDirectoryAccessible,
  commandToolsConfig: process.env.PIXARIUM_COMMAND_TOOLS_CONFIG,
};

/** FAKE_PI_RECORD指定時だけ、現在の呼出記録をfixture外から読めるfileへ保存する。 */
async function persistInvocation() {
  if (process.env.FAKE_PI_RECORD) {
    await writeFile(process.env.FAKE_PI_RECORD, JSON.stringify(invocationRecord), "utf8");
  }
}

await persistInvocation();

if (process.env.FAKE_PI_STDERR) {
  writeSync(2, process.env.FAKE_PI_STDERR);
}

/** fake Piがprompt処理または通常command終了時に返す設定済み終了code。 */
const exitCode = Number(process.env.FAKE_PI_EXIT_CODE ?? "0");
/** timeoutとattachを再現するため完了を遅らせるmillisecond数。 */
const delay = Number(process.env.FAKE_PI_DELAY_MS ?? "0");

/**
 * timeoutによる停止がchild processまで届いた証跡を残して終了する。
 * @returns signal記録が完了するまで生存するPromise。
 */
process.on("SIGTERM", async () => {
  if (process.env.FAKE_PI_SIGNAL_RECORD) {
    await writeFile(process.env.FAKE_PI_SIGNAL_RECORD, "SIGTERM", "utf8");
  }
  process.exit(143);
});

if (process.argv.includes("rpc")) {
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  let input = "";
  let completionTimer;

  /** @param value Pi RPC stdoutへ一件のJSON lineとして送るevent。 */
  const send = (value) => writeSync(1, `${JSON.stringify(value)}\n`);
  /** 最終assistant messageからagent_settledまでの正常完了event列を送る。 */
  const complete = () => {
    const answer = process.env.FAKE_PI_STDOUT ?? "";
    send({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: answer }] },
    });
    send({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: answer }] }],
      willRetry: false,
    });
    send({ type: "agent_settled" });
  };
  /**
   * promptまたはsteer RPCを記録し、設定されたfake event列で応答する。
   * @param command stdinからparseしたPi RPC command。
   */
  const handleCommand = async (command) => {
    invocationRecord.commands.push(command);
    await persistInvocation();
    if (command.type === "prompt") {
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
      send({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
      });
      send({ type: "agent_start" });
      if (process.env.FAKE_PI_THINKING) {
        send({
          type: "message_update",
          message: { role: "assistant", content: [] },
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: process.env.FAKE_PI_THINKING,
          },
        });
      }
      if (process.env.FAKE_PI_TOOL) {
        // 同じfixtureでbash固有detailとfile tool detailを再現できるようevent形状を分ける。
        const toolName = process.env.FAKE_PI_TOOL;
        send({
          type: "tool_execution_start",
          toolName,
          args:
            toolName === "bash"
              ? { command: process.env.FAKE_PI_TOOL_COMMAND ?? "git status --short" }
              : { path: process.env.FAKE_PI_TOOL_PATH ?? "src/example.ts" },
        });
        const isError = process.env.FAKE_PI_TOOL_ERROR === "1";
        const exitCode = process.env.FAKE_PI_TOOL_EXIT_CODE ?? "1";
        const output = process.env.FAKE_PI_TOOL_OUTPUT ?? "";
        send({
          type: "tool_execution_end",
          toolName,
          result: {
            content: [
              {
                type: "text",
                text:
                  toolName === "bash" && isError
                    ? `${output}${output ? "\n\n" : ""}Command exited with code ${exitCode}`
                    : output,
              },
            ],
          },
          isError,
        });
      }
      // prompt応答後もprocessを生存させ、timeout・cancel・attachの競合をtest可能にする。
      completionTimer = setTimeout(complete, delay);
    } else if (command.type === "steer") {
      if (process.env.FAKE_PI_STEERING_RECORD) {
        await writeFile(process.env.FAKE_PI_STEERING_RECORD, command.message, "utf8");
      }
      send({
        id: command.id,
        type: "response",
        command: "steer",
        success: true,
      });
      send({ type: "queue_update", steering: [command.message], followUp: [] });
    }
  };

  process.stdin.on("data", (chunk) => {
    input += chunk;
    const lines = input.split("\n");
    input = lines.pop() ?? "";
    for (const line of lines) {
      if (line) void handleCommand(JSON.parse(line));
    }
  });
  process.stdin.on("end", () => {
    if (completionTimer) clearTimeout(completionTimer);
  });
} else {
  if (process.env.FAKE_PI_STDOUT) {
    writeSync(1, process.env.FAKE_PI_STDOUT);
  }
  if (delay > 0) {
    // auth/modelsの非RPC commandでも長時間processの停止caseを再現できるよう待機する。
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  process.exitCode = exitCode;
}
