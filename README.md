# Pixarium

Pixariumは、[Pi Coding Agent](https://github.com/earendil-works/pi)のWorkerをGitリポジトリ単位で定義して実行するCLIです。Workerごとに役割、モデル、利用できるtool、作業手順を設定できます。

## CLIを導入する

Node.js 24以降の環境で、Pixariumをglobal installします。

```bash
npm install --global pixarium
```

OpenAI CodexのOAuthでPiを利用する場合は、通常のターミナルから認証します。

```bash
pixarium auth
```

認証が完了したら、利用可能なモデルを確認できます。

```bash
pixarium models
```

## Workerを作成して実行する

Workerを置くGitリポジトリへ移動し、`reviewer` Workerの雛形を作成します。具体的な成果物のイメージは[`examples/sample-repository`](./examples/sample-repository)を参照してください。

```bash
cd /path/to/your-repository
pixarium init reviewer
```

`.pixarium/workers/reviewer/worker.yaml`の`model`を、`pixarium models`に表示されたモデル名へ置き換え、役割と制約は`SYSTEM.md`、作業手順は`skill/SKILL.md`へ記述してください。

定義を検査してからWorkerを実行します。

```bash
pixarium check reviewer
pixarium run reviewer --task "現在の変更差分をレビューしてください"
```

Workerの最終回答はstdout、診断はstderrへ出力されます。設定、認証、モデル、Piの起動などで失敗した場合、終了コードは0以外になります。

## Codex Pluginを導入する

以下はCodex Pluginの導入手順です。

Pluginで導入されるのは、CodexからPixariumを扱うためのSkillのみです。PixariumのCLI本体は含まれず、global install済みの`pixarium`コマンドを各Skillが呼び出します。先に`npm install --global pixarium`と`pixarium auth`を完了してください。

Codexへ[Tumbling Dice Marketplace](https://github.com/tumbling-dice/codex-plugins)を登録し、Pixarium Pluginを追加します。

```bash
codex plugin marketplace add tumbling-dice/codex-plugins
codex plugin add pixarium@tumbling-dice
```

Pluginを追加する前から開いていたCodexセッションには、新しいSkillが読み込まれていません。Workerを使うGitリポジトリで新しいセッションを開始してください。

```bash
cd /path/to/your-repository
codex
```

### 導入されるSkill

| Skill | 行うこと |
| --- | --- |
| `$configure-pixarium-worker` | Workerを新規作成または更新し、役割、モデル、利用できるtool、作業手順などを設定して検証する |
| `$migrate-to-pixarium` | 既存のCodex custom agentと、そのagent専用のSkillを一つのPixarium Workerへ移行する |
| `$use-pixarium` | 依頼に合う作成済みWorkerを選ぶか、指定されたWorkerを実行して作業を委譲する |

#### `$configure-pixarium-worker`

CodexへWorkerの作成を依頼できます。

```text
$configure-pixarium-worker このリポジトリの変更差分をレビューするreviewer Workerを作成してください。
```

#### `$migrate-to-pixarium`

既存のCodex custom agentと、そのagent専用のSkillをPixarium Workerへ移行できます。

```text
$migrate-to-pixarium このリポジトリのreviewer custom agentと専用Skillをlocal Workerへ移行してください。
```

#### `$use-pixarium`

作成済みのWorkerへ作業を委譲する場合は、次のように依頼します。

```text
$use-pixarium reviewer Workerで現在の変更差分をレビューしてください。
```

## ソースから検証する

リポジトリを取得した開発者は、固定済みの依存関係を導入して検証できます。

```bash
npm ci
npm run format
npm run check
npm pack --dry-run
```

`npm run build`は`src/`から`dist/`を生成します。npmへ公開する際は`prepack`も同じbuildを実行します。`package.json`の`files`は`dist/`と`README.md`だけを許可するため、同じリポジトリにある`.codex-plugin/`と`skills/`はnpm archiveへ入りません。

## 必要に応じて読む

| 知りたいこと | 参照先 |
| --- | --- |
| Workerの設定項目、local・global scope、継承 | [Workerの設定](./docs/configuration.md#workerとscope) |
| CLIからWorkerを作成・検査・実行する方法 | [CLIの利用方法](./docs/configuration.md#まずlocal-workerを実行する) |
| 実行中のWorkerへの追加指示と観測 | [実行中のWorkerを観測する](./docs/configuration.md#実行中のworkerを観測する) |
| Codex PluginのSkillと導入方法 | [Codex Pluginの設定](./docs/configuration.md#codex-pluginから使う) |
| APIキーと認証情報の保存場所 | [認証情報をリポジトリの外へ置く](./docs/configuration.md#認証情報をリポジトリの外へ置く) |

## ライセンス

PixariumはMIT Licenseの下で公開しています。利用条件は[LICENSE](./LICENSE)を参照してください。
