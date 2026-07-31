# 機能変更ガイド

この文書は、Pixariumの機能を追加・修正するAIコーディングエージェント向けの作業手順である。`AGENTS.md`の常時ルールを前提とし、実装以外の更新対象も含めて変更を完結させるために使う。

## 1. 変更条件を確定する

実装前に次を短く整理する。

- 変更する利用者向けの動作
- 従来のまま維持する動作
- local、global、継承など、影響するscope
- 成功時の出力と失敗条件
- 今回変更しない互換性や外部連携

不明点を既存コード、テスト、README、`docs/configuration.md`、Skillから確認できる場合は先に調査する。結果が変わる選択だけをユーザーへ確認する。

## 2. 既存差分を保護する

`git status --short`と対象ファイルの差分を確認する。既存差分を今回の変更と決めつけず、関係のない変更を戻したり上書きしたりしない。

生成物と編集元を確認し、`src/`などの編集元を変更する。生成ファイルを直接編集しない。

## 3. 更新対象を洗い出す

次の各項目について、更新が必要かを判断する。該当しない項目は変更しない。

| 対象                          | 確認する条件                                                 |
| ----------------------------- | ------------------------------------------------------------ |
| `src/`                        | 実行時動作、CLI引数、検証、設定解決、エラー処理が変わる      |
| `test/`                       | 新しい成功経路、境界値、優先順位、失敗経路が増える           |
| `README.md`                   | 概要、導入からCodex経由でWorkerを実行する基本経路が変わる    |
| `docs/configuration.md`       | コマンド、設定形式、保存場所、優先順位、利用手順が変わる     |
| その他の`docs/`               | 開発判断、設計上の制約、複数機能にまたがる手順が変わる       |
| `examples/`                   | 既存例が新仕様と矛盾する、または新仕様の理解に例が必要になる |
| `skills/*/SKILL.md`           | Codexからの操作手順、選択条件、scope、失敗時の扱いが変わる   |
| `skills/*/agents/openai.yaml` | Skillの用途や代表的な依頼方法が変わる                        |
| `.codex-plugin/plugin.json`   | Pluginの説明、提供機能、配布versionが変わる                  |
| `package.json`とlockfile      | パッケージ説明、script、直接依存が変わる                     |

実装だけを変更して完了としない。利用者またはCodexが古い手順を参照する箇所がないか、関連語を`rg`で検索する。

## 4. 実装とテストを対応させる

先に既存の責務分割へ沿って実装し、同じ変更でテストを追加または更新する。

テストでは少なくとも次を検討する。

- 代表的な成功経路
- 既定値と明示指定の差
- localとglobalの優先順位
- 存在しない設定や不正な値
- 別scopeへの意図しないフォールバック
- stdout、stderr、終了コード
- 認証情報をリポジトリ内へ置かないための拒否経路

実際のLLM APIは呼び出さず、fake Pi実行ファイルを使う。

## 5. npm packageとCodex Pluginを分けて検証する

CLI本体とCodex Plugin資材は同じリポジトリで管理する。配布物はnpm packageとCodex Pluginに分かれるため、次を確認する。

1. npm packageの`files`が`dist/`と`README.md`だけを含み、Plugin資材を含まないことを確認する。
2. npm packageが`pixarium` binを提供することを確認する。
3. Skillがnpmでglobal installされた`pixarium`を使用することを確認する。
4. 各Skillの`SKILL.md`と`agents/openai.yaml`を同期し、Plugin validatorとSkill validatorを実行する。
5. Marketplace catalogを変更する場合は、[`tumbling-dice/codex-plugins`](https://github.com/tumbling-dice/codex-plugins)からこのGitリポジトリを参照する。Plugin資材をMarketplaceリポジトリへ複製しない。

`npm pack --dry-run`でnpm archiveを確認する。Plugin資材が同じ作業ツリーに存在することだけを理由に、npm archiveへ含まれると判断しない。

## 6. 最終検証を行う

最終変更後に次の順序で実行する。

```bash
npm run format
npm run check
git diff --check
```

失敗した場合は原因を修正し、最終変更後に必要な検証を再実行する。検証前の成功結果を、修正後の結果として扱わない。

最後に差分を読み、次を確認する。

- 要件に対応する実装、テスト、文書が揃っている
- README、`docs/configuration.md`、Skill、CLI helpの説明が実装と一致する
- placeholder、古い名称、古いコマンド例が残っていない
- formatterによる変更を含め、意図しない差分がない
- 認証情報やユーザー固有のパスを追加していない

## 7. コミットする

ユーザーからコミットを依頼された場合だけ、localの`commit-diff` Workerへ委譲する。Main Agentはcommit対象のpathと、最終変更後に成功した`npm run format`、`npm run check`、`git diff --check`の結果をtaskへ明記し、`$use-pixarium`で`commit-diff`を実行する。Main Agentが直接stageまたはcommitしない。

Workerがcommitした場合は、Main Agentがcommit ID、message、対象path、残った差分を確認して報告する。Workerが問題を報告してcommitしなかった場合は、Main Agentが問題を解消して必要な検証を再実行し、同じ対象を改めて委譲する。
