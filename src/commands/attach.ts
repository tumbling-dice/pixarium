import { readFile } from "node:fs/promises";
import { PixariumError } from "../errors.js";
import {
  connectToRun,
  createObserverMarker,
  readRunTask,
  removeObserverMarker,
  runStillExists,
  traceEventFiles,
} from "../run-observer.js";

/** 連続するdeltaを同じ行へ描画するため、現在開いている出力種別を保持する状態。 */
interface RenderState {
  /** 現在改行せず描画中のstream。行が閉じている場合はundefined。 */
  stream: "reasoning" | "assistant" | undefined;
}

/** @param value trace JSONの値。 @returns 通常objectとしてfield参照できればtrue。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * trace fieldを安全な短い表示文字列へ変換する。
 * @param value 外部eventから得た値。
 * @param fallback primitiveでない場合の代替表示。
 * @returns stdoutへ埋め込める文字列。
 */
function display(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : fallback;
}

/**
 * delta streamの行を閉じ、次の構造化eventを行頭から表示できる状態へ戻す。
 * @param state 現在描画中のstream状態。
 */
function endStream(state: RenderState): void {
  if (!state.stream) return;
  process.stdout.write("\n");
  state.stream = undefined;
}

/**
 * reasoningまたはassistantの増分を、stream切替時だけlabel付きで描画する。
 * @param state 現在描画中のstream状態。
 * @param stream deltaの出力種別。
 * @param delta trace eventから受け取った未検証値。
 */
function renderDelta(state: RenderState, stream: "reasoning" | "assistant", delta: unknown): void {
  if (typeof delta !== "string" || delta === "") return;
  if (state.stream !== stream) {
    endStream(state);
    process.stdout.write(`[${stream}] `);
    state.stream = stream;
  }
  process.stdout.write(delta);
}

/**
 * 一つのtrace eventを端末向け表示へ変換する。
 * @param state 複数event間で維持する描画状態。
 * @param event 検証済みobject形状のtrace event。
 * @returns run_endを描画した場合はtrue。
 */
function renderEvent(state: RenderState, event: Record<string, unknown>): boolean {
  switch (event.type) {
    case "run_started": {
      endStream(state);
      const commands = Array.isArray(event.commands)
        ? event.commands
            .filter(isRecord)
            .map((command) => display(command.name, "command"))
            .join(",")
        : "";
      process.stdout.write(
        `[run] model=${String(event.model)} thinking=${String(event.thinking)} ` +
          `tools=${Array.isArray(event.tools) ? event.tools.join(",") : ""} ` +
          `commands=${commands} bash=${display(event.bash, "disabled")}\n`,
      );
      break;
    }
    case "reasoning_delta":
      renderDelta(state, "reasoning", event.delta);
      break;
    case "text_delta":
      renderDelta(state, "assistant", event.delta);
      break;
    case "tool_start":
      endStream(state);
      process.stdout.write(
        `[tool:start] ${display(event.toolName, "tool")}` +
          `${typeof event.detail === "string" && event.detail ? ` ${event.detail}` : ""}\n`,
      );
      break;
    case "tool_end":
      endStream(state);
      process.stdout.write(
        `[tool:end] ${display(event.toolName, "tool")} ${event.isError ? "failed" : "succeeded"}` +
          `${typeof event.exitCode === "number" ? ` exit=${event.exitCode}` : ""}\n`,
      );
      if (Array.isArray(event.outputPreview)) {
        for (const line of event.outputPreview) {
          if (typeof line === "string") process.stdout.write(`[tool:output] ${line}\n`);
        }
      }
      break;
    case "compaction_start":
      endStream(state);
      process.stdout.write(`[compaction] started (${display(event.reason, "unknown")})\n`);
      break;
    case "compaction_end":
      endStream(state);
      process.stdout.write("[compaction] completed\n");
      break;
    case "retry":
      endStream(state);
      process.stdout.write(
        `[retry] ${display(event.attempt, "?")}/${display(event.maxAttempts, "?")}\n`,
      );
      break;
    case "steering":
      endStream(state);
      process.stdout.write(`[steering] ${display(event.state, "updated")}\n`);
      break;
    case "run_end":
      endStream(state);
      process.stdout.write(`[run] ${display(event.state, "completed")}\n`);
      return true;
  }
  return false;
}

/**
 * active runのtraceを追尾し、producerを停止せずに端末へ表示する。
 * @param idPrefix 一意に解決できる完全または短縮run ID。
 */
export async function attachRun(idPrefix: string): Promise<void> {
  const run = await connectToRun(idPrefix);
  const markerPath = await createObserverMarker(run);
  const state: RenderState = { stream: undefined };
  // event fileはimmutableなので、既読pathだけを記録すればoffset管理なしで重複を防げる。
  const readFiles = new Set<string>();
  let ended = false;
  let interrupted = false;

  process.stdout.write(
    `Attached to ${run.info.worker} (${run.info.id}). ` +
      "Ctrl-C detaches; the worker keeps running.\n",
  );
  process.stdout.write(`[task] ${await readRunTask(run)}\n`);

  /** SIGINTではproducerをkillせず、attach loopだけを抜ける。 */
  const onInterrupt = (): void => {
    interrupted = true;
  };
  process.once("SIGINT", onInterrupt);

  try {
    while (!ended && !interrupted) {
      for (const eventPath of await traceEventFiles(run)) {
        if (readFiles.has(eventPath)) continue;
        readFiles.add(eventPath);
        let event: unknown;
        try {
          event = JSON.parse(await readFile(eventPath, "utf8"));
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            continue;
          }
          if (await runStillExists(run)) {
            throw new PixariumError(
              `could not read run trace: ${error instanceof Error ? error.message : String(error)}`,
              "configuration",
            );
          }
          continue;
        }
        if (isRecord(event) && renderEvent(state, event)) ended = true;
      }
      if (ended || !(await runStillExists(run))) break;
      // filesystem pollingを短く休止し、eventがない時間のCPU消費を抑える。
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    endStream(state);
    await removeObserverMarker(markerPath);
  }
}
