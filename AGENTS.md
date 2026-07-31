# AGENTS.md

## 常に守ること

- APIキー、OAuthトークン、Piの認証ファイル、ユーザー固有の認証情報をこのリポジトリへ保存しない。認証情報の内容を表示または検査しない。
- Piの認証情報は、このリポジトリとWorkerを実行する対象リポジトリのどちらにも置かない。リポジトリ内を指す`PI_CODING_AGENT_DIR`を拒否する実行時検査を維持する。
- npmパッケージの`node_modules`に同梱されたPi実行ファイルを使用し、グローバルな`pi`または`pi-ai`コマンドに依存しない。
- Codex PluginのSkillは、npmでglobal installされた`pixarium`を実行する。CLI実装をPlugin資材へ複製しない。
- 直接依存するパッケージのバージョンは完全に固定し、依存関係を変更した場合は `package-lock.json`も更新する。
- 要件で明示的に変更されない限り、CLIではNode.js 24、TypeScript、ESM、`node:util`の引数解析を使用する。
- Workerの通常出力はstdout、診断とエラーはstderrへ出力する。検証、起動、認証、モデル、タイムアウト、Pi実行に失敗した場合はゼロ以外の終了コードを返す。
- 自動テストでは実際のLLM APIを呼び出さない。テストにはfake Pi実行ファイルを使用し、ユーザーが明示的に依頼した場合に限り実際のモデルで検証する。
- 依頼された範囲外のコマンド、外部ツール、サービス、永続状態、互換性レイヤーを追加しない。
- Pluginへ登録する各Skillには`agents/openai.yaml`を置く。`interface.display_name`は英語、`interface.short_description`と`interface.default_prompt`は日本語で記述し、`default_prompt`には`$<skill-name>`を明記する。
- 機能を追加・修正する場合は、実装、テスト、文書、Codex Pluginへの影響を[`docs/feature-change-guide.md`](./docs/feature-change-guide.md)に従って確認する。
- `src/`を実装のソースとし、`npm run build`で`dist/`を再生成する。生成ファイルを直接編集しない。
- `npm run format`を実行した後の状態を、正しいフォーマットの基準とする。現在の作業と関係ないファイルを含め、formatterが生成した変更はすべて維持する。差分を減らす目的でformatter由来の変更を元に戻さない。
- 最終変更後に`npm run format`を実行する。コードを変更した場合は、続けて`npm run check`を実行する。ドキュメントだけを変更した場合、`npm run check`は不要とする。
