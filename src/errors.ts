/** 利用者へ公開できる分類を保持し、内部例外をCLIの安定した診断へ変換するError。 */
export class PixariumError extends Error {
  /**
   * 分類済みのPixariumエラーを生成する。
   * @param message 認証情報を含まない、利用者へ表示可能な詳細。
   * @param category 呼び出し側が終了状態を判断するための失敗分類。
   */
  constructor(
    message: string,
    readonly category:
      | "configuration"
      | "worker"
      | "pi-launch"
      | "pi-authentication"
      | "pi-model"
      | "pi-exit"
      | "timeout",
  ) {
    super(message);
    this.name = "PixariumError";
  }
}

/**
 * 任意の例外値を、credential内容を漏らさない一行の公開診断へ変換する。
 * @param error catch境界で受け取った例外値。
 * @returns CLIのstderrへ書き出せる診断文字列。
 */
export function formatError(error: unknown): string {
  // 分類名をこの境界に集約し、下位層の文言変更で公開prefixが揺れないようにする。
  if (error instanceof PixariumError) {
    const labels: Record<PixariumError["category"], string> = {
      configuration: "Pixarium configuration error",
      worker: "Worker definition error",
      "pi-launch": "Pi launch error",
      "pi-authentication": "Pi authentication error",
      "pi-model": "Pi model error",
      "pi-exit": "Pi execution error",
      timeout: "Pi timeout",
    };
    return `${labels[error.category]}: ${error.message}`;
  }

  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}
