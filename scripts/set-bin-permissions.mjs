import { chmod } from "node:fs/promises";
import path from "node:path";

/** npm archive内でも直接実行できる状態を維持するbuild済みbinの一覧。 */
const binPaths = ["dist/cli.js"];

// package managerごとのshim生成に依存せず、Unix環境でbin target自体を実行可能にする。
await Promise.all(binPaths.map((binPath) => chmod(path.resolve(binPath), 0o755)));
