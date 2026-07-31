import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { PixariumError } from "./errors.js";

/** regular fileへ転送されたPi出力を追尾するpoll間隔。 */
const POLL_INTERVAL_MS = 25;

/** poll式に読み進めるPi output fileと、次に読むbyte位置の組。 */
interface OutputFile {
  /** 親processがreadとcloseを所有するopen済みfile handle。 */
  handle: FileHandle;
  /** 次のpollで読み始める先頭からのbyte offset。 */
  position: number;
}

/** child processのstdioをrun directory経由で中継し、追尾可能にするRPC transport。 */
export interface PiRpcTransport {
  /** spawnへ渡すstdin、stdout、stderr順のfile descriptor。 */
  stdio: [number, number, number];
  /** @param line Piへ送る改行付きRPC command。 */
  write(line: string): void;
  /** PiへEOFを通知し、追加commandを受理しない状態へ移す。 */
  closeInput(): void;
  /** @param onStdout stdout chunkのconsumer。 @param onStderr stderr chunkのconsumer。 */
  start(onStdout: (chunk: Buffer) => void, onStderr: (chunk: Buffer) => void): void;
  /** 残存出力を読み切り、親processが所有する全handleを閉じる。 */
  stop(): Promise<void>;
}

/**
 * 前回位置から現在のEOFまでを読み、chunk単位でconsumerへ渡す。
 * @param output open済みfileと次のread位置。
 * @param consume 読めたbyte列のconsumer。
 */
async function readAvailable(output: OutputFile, consume: (chunk: Buffer) => void): Promise<void> {
  // syscall回数と一時memoryの均衡を取り、長いRPC eventも複数回で安全に運ぶ。
  const buffer = Buffer.allocUnsafe(64 * 1024);
  while (true) {
    const { bytesRead } = await output.handle.read(buffer, 0, buffer.length, output.position);
    if (bytesRead === 0) return;
    output.position += bytesRead;
    consume(buffer.subarray(0, bytesRead));
  }
}

/**
 * Pi RPCのstdinをFIFO、stdout/stderrを追尾可能なfileで接続するtransportを作る。
 * @param directory run終了時にまとめて破棄される専用directory。
 * @returns child processへ渡すfdと親側の入出力制御。
 */
export async function createPiRpcTransport(directory: string): Promise<PiRpcTransport> {
  const inputPath = path.join(directory, "pi.stdin");
  const stdoutPath = path.join(directory, "pi.stdout");
  const stderrPath = path.join(directory, "pi.stderr");
  const created = spawnSync("mkfifo", ["-m", "600", inputPath], { stdio: "ignore" });
  if (created.error || created.status !== 0) {
    throw new PixariumError("could not create the Pi RPC input channel", "pi-launch");
  }

  // FIFOのread/write両端を先に開き、spawn前後のopen待ちによるdeadlockを避ける。
  const [input, childInput, stdout, stderr] = await Promise.all([
    open(inputPath, constants.O_RDWR | constants.O_NONBLOCK),
    open(inputPath, constants.O_RDONLY | constants.O_NONBLOCK),
    open(stdoutPath, constants.O_CREAT | constants.O_TRUNC | constants.O_RDWR, 0o600),
    open(stderrPath, constants.O_CREAT | constants.O_TRUNC | constants.O_RDWR, 0o600),
  ]);
  const stdoutState: OutputFile = { handle: stdout, position: 0 };
  const stderrState: OutputFile = { handle: stderr, position: 0 };
  let inputClosed = false;
  let stopped = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let pollChain = Promise.resolve();
  /** start前のpollにも安全なstdout consumer。 */
  let stdoutConsumer: (chunk: Buffer) => void = () => {};
  /** start前のpollにも安全なstderr consumer。 */
  let stderrConsumer: (chunk: Buffer) => void = () => {};

  /** pollが重なって同じbyteを二度読むことを防ぐため、readをPromise chainへ直列化する。 */
  const poll = (): void => {
    pollChain = pollChain.then(async () => {
      await readAvailable(stdoutState, stdoutConsumer);
      await readAvailable(stderrState, stderrConsumer);
    });
  };

  return {
    stdio: [childInput.fd, stdout.fd, stderr.fd],
    /** @param line Piへ送る改行付きRPC command。 */
    write(line: string): void {
      if (inputClosed) return;
      void input.write(line);
    },
    /** Piへのwrite側handleを一度だけ閉じる。 */
    closeInput(): void {
      if (inputClosed) return;
      inputClosed = true;
      void input.close();
    },
    /** @param onStdout stdout chunkのconsumer。 @param onStderr stderr chunkのconsumer。 */
    start(onStdout, onStderr): void {
      stdoutConsumer = onStdout;
      stderrConsumer = onStderr;
      void childInput.close();
      pollTimer = setInterval(poll, POLL_INTERVAL_MS);
      pollTimer.unref();
      poll();
    },
    /** poll完了と最終readを待ってから全file handleを閉じる。 */
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      await pollChain;
      await readAvailable(stdoutState, stdoutConsumer);
      await readAvailable(stderrState, stderrConsumer);
      if (!inputClosed) await input.close();
      await Promise.all([stdout.close(), stderr.close()]);
    },
  };
}
