import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PixariumError } from "./errors.js";
import type { WorkerScope } from "./worker-loader.js";
import type { ValidatedWorker } from "./worker-validator.js";

/** attach用trace file群が占有できるrun単位の最大byte数。 */
const TRACE_BUFFER_LIMIT = 256 * 1024;
/** 実行processが生存をregistryへ通知する間隔。 */
const HEARTBEAT_INTERVAL_MS = 5_000;
/** process確認に加えてrunをactiveとみなせるheartbeatの最大経過時間。 */
const HEARTBEAT_STALE_MS = 20_000;
/** run終了時にattach側が残存eventを読むため待機する最大時間。 */
const OBSERVER_CLOSE_WAIT_MS = 1_000;

/** CLIへ公開できる、現在実行中のWorker runの識別情報。 */
export interface ActiveRun {
  /** attachで完全一致またはprefix指定に使う一意なUUID。 */
  id: string;
  /** runが実行している検証済みWorker名。 */
  worker: string;
  /** 実際に解決されたWorker scope。 */
  scope: WorkerScope;
  /** run開始時刻を示すISO 8601文字列。 */
  startedAt: string;
}

/** attach processへfile単位で公開する、timestamp付きの汎用trace event。 */
export interface TraceEvent {
  /** producerがeventを受け取った時刻を示すISO 8601文字列。 */
  at: string;
  /** rendererがevent形状を選ぶための種別名。 */
  type: string;
  /** event種別ごとの追加field。値はattach側で個別に検証する。 */
  [key: string]: unknown;
}

/** runの登録、trace公開、終了時cleanupをPi実行層へ提供するobserver。 */
export interface RunObserver {
  /** listとattachへ公開するrun識別情報。 */
  info: ActiveRun;
  /** transport fileとregistry fileを保持するrun固有directory。 */
  directory: string;
  /** @param event timestampを除く、attachへ公開するtrace event。 */
  publish(event: Omit<TraceEvent, "at">): void;
  /** 未完了writeを待ち、run registry一式を破棄する。 */
  close(): Promise<void>;
}

/** attachが追尾するactive runと、そのruntime storageを結び付ける接続情報。 */
export interface ConnectedRun {
  /** 利用者へ表示するrun識別情報。 */
  info: ActiveRun;
  /** task、event、observer markerを読み書きするrun固有directory。 */
  directory: string;
}

/** producerの生存確認に必要な内部fieldをActiveRunへ加えた永続registry形式。 */
interface RegistryEntry extends ActiveRun {
  /** 将来のregistry形式変更時に旧形式を拒否する固定version。 */
  version: 1;
  /** runを所有し、生存確認とstale cleanupの対象になるOS process ID。 */
  pid: number;
  /** producerが最後に生存を通知した時刻を示すISO 8601文字列。 */
  heartbeatAt: string;
}

/** trace bufferの合計sizeを制限するために保持するevent file metadata。 */
interface BufferedEvent {
  /** 上限超過時に削除するimmutable event fileの絶対path。 */
  path: string;
  /** 合計値から差し引くevent fileのbyte数。 */
  size: number;
}

/** @returns OS userごとに分離された一時run registryのroot directory。 */
function runtimeRoot(): string {
  const user = process.getuid?.() ?? "user";
  return path.join(tmpdir(), `pixarium-${user}`, "runs");
}

/** @param id 完全なrun UUID。 @returns run固有のruntime directory。 */
function runDirectory(id: string): string {
  return path.join(runtimeRoot(), id);
}

/** @param directory run directory。 @returns atomic更新されるmetadata file path。 */
function metadataPath(directory: string): string {
  return path.join(directory, "metadata.json");
}

/** @param directory run directory。 @returns attach時に表示するtask file path。 */
function taskPath(directory: string): string {
  return path.join(directory, "task.txt");
}

/** @param directory run directory。 @returns 順序付きtrace event directory。 */
function eventsDirectory(directory: string): string {
  return path.join(directory, "events");
}

/** @param directory run directory。 @returns 接続中attach markerのdirectory。 */
function observersDirectory(directory: string): string {
  return path.join(directory, "observers");
}

/** @param value 検査するJSON値。 @returns key参照可能な通常objectならtrue。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 永続化されたJSONを、version固定のrun registry entryとして検証する。
 * @param value metadata.jsonからparseした値。
 * @returns 必須fieldが揃うentry。不正ならundefined。
 */
function parseRegistryEntry(value: unknown): RegistryEntry | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    typeof value.worker !== "string" ||
    (value.scope !== "local" && value.scope !== "global") ||
    typeof value.startedAt !== "string" ||
    typeof value.pid !== "number" ||
    typeof value.heartbeatAt !== "string"
  ) {
    return undefined;
  }
  return {
    version: 1,
    id: value.id,
    worker: value.worker,
    scope: value.scope,
    startedAt: value.startedAt,
    pid: value.pid,
    heartbeatAt: value.heartbeatAt,
  };
}

/**
 * 内部のpidとheartbeatを除き、利用者へ公開するrun情報だけを取り出す。
 * @param entry 検証済みregistry entry。
 * @returns CLIへ公開できるActiveRun。
 */
function publicRun(entry: RegistryEntry): ActiveRun {
  return {
    id: entry.id,
    worker: entry.worker,
    scope: entry.scope,
    startedAt: entry.startedAt,
  };
}

/**
 * metadataを同一directory内でatomic置換し、attach側が途中のJSONを読まないようにする。
 * @param directory 対象run directory。
 * @param entry 書き込む最新registry entry。
 */
async function writeMetadata(directory: string, entry: RegistryEntry): Promise<void> {
  const temporaryPath = path.join(directory, `.metadata.${process.pid}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await rename(temporaryPath, metadataPath(directory));
}

/**
 * metadataを読み、不完全fileや削除競合をinactiveとして扱う。
 * @param directory 調査するrun directory。
 * @returns 検証済みentry。読めない場合はundefined。
 */
async function readEntry(directory: string): Promise<RegistryEntry | undefined> {
  try {
    return parseRegistryEntry(JSON.parse(await readFile(metadataPath(directory), "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * signalを送らずにprocess table上のpid生存を確認する。
 * @param pid registryへ記録されたprocess ID。
 * @returns processが存在するか、権限不足で存在が確認できた場合はtrue。
 */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** @param entry registry entry。 @returns heartbeatとpidの双方が有効ならtrue。 */
function entryIsActive(entry: RegistryEntry): boolean {
  const heartbeatAge = Date.now() - Date.parse(entry.heartbeatAt);
  return heartbeatAge <= HEARTBEAT_STALE_MS && processExists(entry.pid);
}

/**
 * 生存runを列挙し、停止processが残した一時directoryを回収する。
 * @returns active entryと対応directoryの配列。
 */
async function registryEntries(): Promise<Array<{ entry: RegistryEntry; directory: string }>> {
  let names: string[];
  try {
    names = await readdir(runtimeRoot());
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const values = await Promise.all(
    names.map(async (name) => {
      const directory = path.join(runtimeRoot(), name);
      const entry = await readEntry(directory);
      // 一時領域は正常終了できなかったprocessでも残るため、列挙時に安全に回収する。
      if (!entry || !entryIsActive(entry)) {
        await rm(directory, { recursive: true, force: true });
        return undefined;
      }
      return { entry, directory };
    }),
  );
  return values.filter(
    (value): value is { entry: RegistryEntry; directory: string } => value !== undefined,
  );
}

/** @param directory run directory。 @returns 現在接続中のattach marker数。 */
async function observerCount(directory: string): Promise<number> {
  try {
    return (await readdir(observersDirectory(directory))).length;
  } catch {
    return 0;
  }
}

/**
 * close直前にattach側へ未読eventを読む短い猶予を与える。
 * @param directory 終了するrun directory。
 */
async function waitForObservers(directory: string): Promise<void> {
  const deadline = Date.now() + OBSERVER_CLOSE_WAIT_MS;
  while (Date.now() < deadline && (await observerCount(directory)) > 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

/**
 * 実行中runをregistryへ登録し、bounded trace publisherを生成する。
 * @param worker 実行対象の検証済みWorker。
 * @param task attach時に表示する依頼本文。
 * @returns event公開と確実なcleanupを担うobserver。
 */
export async function startRunObserver(
  worker: ValidatedWorker,
  task: string,
): Promise<RunObserver> {
  await mkdir(runtimeRoot(), { recursive: true, mode: 0o700 });
  await registryEntries();

  const id = randomUUID();
  const directory = runDirectory(id);
  await Promise.all([
    mkdir(eventsDirectory(directory), { recursive: true, mode: 0o700 }),
    mkdir(observersDirectory(directory), { recursive: true, mode: 0o700 }),
  ]);
  const entry: RegistryEntry = {
    version: 1,
    id,
    worker: worker.config.name,
    scope: worker.location.scope,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    heartbeatAt: new Date().toISOString(),
  };
  await Promise.all([
    writeMetadata(directory, entry),
    writeFile(taskPath(directory), task, { mode: 0o600 }),
  ]);

  let closed = false;
  let sequence = 0;
  let bufferedBytes = 0;
  const buffered: BufferedEvent[] = [];
  let writeChain = Promise.resolve();
  let metadataChain = Promise.resolve();

  /**
   * eventを順序付きfileとして非同期直列化する。
   * file単位にするのは、別processのattachが追記途中を読まないためである。
   * @param event timestampを除くtrace event。
   */
  const publish = (event: Omit<TraceEvent, "at">): void => {
    if (closed) return;
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
    const size = Buffer.byteLength(line);
    if (size > TRACE_BUFFER_LIMIT) return;
    sequence += 1;
    const eventPath = path.join(
      eventsDirectory(directory),
      `${String(sequence).padStart(12, "0")}.json`,
    );
    const temporaryPath = `${eventPath}.${process.pid}.tmp`;
    writeChain = writeChain.then(async () => {
      await writeFile(temporaryPath, line, { mode: 0o600 });
      await rename(temporaryPath, eventPath);
      buffered.push({ path: eventPath, size });
      bufferedBytes += size;
      // 長時間runでも一時領域を無制限に消費しないよう、古いeventから削除する。
      while (bufferedBytes > TRACE_BUFFER_LIMIT) {
        const removed = buffered.shift();
        if (!removed) break;
        bufferedBytes -= removed.size;
        await rm(removed.path, { force: true });
      }
    });
  };

  const heartbeat = setInterval(() => {
    entry.heartbeatAt = new Date().toISOString();
    metadataChain = metadataChain.then(() => writeMetadata(directory, entry));
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  publish({
    type: "run_started",
    model: worker.config.model,
    thinking: worker.config.thinking,
    tools: worker.config.tools,
    commands: worker.config.commands.map((command) => ({
      name: command.name,
      executable: command.executable,
      arguments: command.arguments ?? "fixed",
    })),
    bash: worker.config.tools.includes("bash") ? "enabled" : "disabled",
    contextFiles: worker.config.contextFiles,
    skills: worker.skills.map((skill) => ({ name: skill.name, scope: skill.scope })),
  });

  return {
    info: publicRun(entry),
    directory,
    publish,
    /** heartbeatとwriteを停止し、attachの読取猶予後にruntime dataを破棄する。 */
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      await Promise.all([writeChain, metadataChain]);
      await waitForObservers(directory);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** @returns stale entryを除去した、開始時刻順のactive run一覧。 */
export async function listActiveRuns(): Promise<ActiveRun[]> {
  return (await registryEntries())
    .map(({ entry }) => publicRun(entry))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

/**
 * UUID prefixを一意なactive runへ解決する。
 * @param idPrefix CLI利用者が指定した完全または短縮run ID。
 * @returns attachに必要な公開情報とruntime directory。
 */
export async function connectToRun(idPrefix: string): Promise<ConnectedRun> {
  const entries = await registryEntries();
  const matches = entries.filter(({ entry }) => entry.id.startsWith(idPrefix));
  if (matches.length === 0) {
    throw new PixariumError(`active run not found: ${idPrefix}`, "configuration");
  }
  if (matches.length > 1) {
    throw new PixariumError(`run ID prefix is ambiguous: ${idPrefix}`, "configuration");
  }
  const match = matches[0];
  if (!match) {
    throw new PixariumError(`active run not found: ${idPrefix}`, "configuration");
  }
  return { info: publicRun(match.entry), directory: match.directory };
}

/**
 * producerのcloseがattach完了を短時間待てるよう接続markerを作る。
 * @param run 接続対象run。
 * @returns finallyで削除すべきmarker path。
 */
export async function createObserverMarker(run: ConnectedRun): Promise<string> {
  const markerPath = path.join(observersDirectory(run.directory), randomUUID());
  try {
    await writeFile(markerPath, "", { mode: 0o600 });
    return markerPath;
  } catch {
    throw new PixariumError(`active run is no longer reachable: ${run.info.id}`, "configuration");
  }
}

/** @param run 接続中run。 @returns 現在読めるtrace event fileをsequence順で返す。 */
export async function traceEventFiles(run: ConnectedRun): Promise<string[]> {
  try {
    return (await readdir(eventsDirectory(run.directory)))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(eventsDirectory(run.directory), name));
  } catch {
    return [];
  }
}

/** @param run 接続中run。 @returns producerが保存した元task全文。 */
export async function readRunTask(run: ConnectedRun): Promise<string> {
  try {
    return await readFile(taskPath(run.directory), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new PixariumError(`active run is no longer reachable: ${run.info.id}`, "configuration");
    }
    throw new PixariumError(
      `could not read run task: ${error instanceof Error ? error.message : String(error)}`,
      "configuration",
    );
  }
}

/** @param run 接続中run。 @returns producerのruntime directoryがまだ存在すればtrue。 */
export async function runStillExists(run: ConnectedRun): Promise<boolean> {
  try {
    return (await stat(run.directory)).isDirectory();
  } catch {
    return false;
  }
}

/** @param markerPath createObserverMarkerが返した接続marker。 */
export async function removeObserverMarker(markerPath: string): Promise<void> {
  await rm(markerPath, { force: true });
}
