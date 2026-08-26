# Pixariumの設定と利用方法

この文書は、Pixariumの基本的な導入を終えた利用者向けの設定・参照ガイドです。最初から通読する必要はありません。Workerを作成してCodexから実行するまでの基本手順は[`README.md`](../README.md)を参照してください。

| 目的 | 読む箇所 |
| --- | --- |
| CLIからWorkerを作成して実行する | [まずlocal Workerを実行する](#まずlocal-workerを実行する) |
| Workerの保存場所と設定項目を確認する | [Workerとscope](#workerとscope)、[Workerの定義を編集する](#workerの定義を編集する) |
| global Workerや共通baseを使う | [global Workerと継承を使う](#global-workerと継承を使う) |
| Workerを検査し、実行中の状態を確認する | [Workerを探して検査する](#workerを探して検査する)、[Workerを実行する](#workerを実行する) |
| Codex Pluginの詳細を確認する | [Codex Pluginから使う](#codex-pluginから使う) |
| 認証情報の保存場所を変更する | [認証情報をリポジトリの外へ置く](#認証情報をリポジトリの外へ置く) |

## まずlocal Workerを実行する

この手順では、対象リポジトリ専用の読み取りWorkerを作り、検査してから実行します。

### 1. 対象リポジトリにWorkerを作る

対象のGitリポジトリへ移動し、`reviewer` Workerの雛形を作成します。`init`でscopeを省略すると、local Workerが作られます。

```bash
cd /path/to/target-repository
pixarium init reviewer
```

生成された`.pixarium/workers/reviewer/worker.yaml`を開き、`model`を`pixarium models`に表示されたモデル名へ置き換えてください。雛形は、後述する4種類の読み取り用ツールだけを使用します。

```yaml
name: reviewer
description: 現在の変更差分を独立してレビューする

model: openai/model-name
thinking: high

systemPrompt: ./SYSTEM.md
skill: ./skill/SKILL.md

tools:
  - read
  - grep
  - find
  - ls

contextFiles: disabled
```

役割と制約は`SYSTEM.md`へ、作業手順と完了条件は`skill/SKILL.md`へ記述します。各ファイルの役割は[Workerの定義を編集する](#workerの定義を編集する)を参照してください。

### 2. 検査して実行する

対象リポジトリでWorkerを検査します。

```bash
pixarium check reviewer
```

終了コードが0なら、Workerの定義と参照ファイルは実行可能な状態です。検査に失敗した場合はstderrに表示された`worker.yaml`の項目または参照ファイルを修正し、同じコマンドを再実行してください。

検査に成功したら、Workerへ依頼を渡します。

```bash
pixarium run reviewer --task "現在の変更差分をレビューしてください"
```

Workerの最終回答は`stdout`へ出力されます。診断は`stderr`へ出力されます。設定や認証などで実行に失敗した場合は、終了コードが0以外になります。

## Workerとscope

Workerは、Piの実行設定と指示をまとめた定義です。保存場所によってscopeが分かれます。

| scope | 保存場所 | 用途 |
| --- | --- | --- |
| local | `<Gitリポジトリ>/.pixarium/workers/` | そのリポジトリに固有の作業を定義する |
| global | `~/.pixarium/workers/` | 複数のリポジトリから使うWorkerまたは共通baseを定義する |

同名のlocal Workerとglobal Workerがある場合、scopeを省略したWorker選択ではlocalを優先します。`--local`または`--global`を明示したコマンドは、指定scopeだけを対象とし、別scopeへフォールバックしません。

base Workerは、複数のlocal Workerへ共通設定を渡すglobal定義です。`kind: base`を持ち、単独では実行できません。local Workerの`extends`に`global:<base-name>`を指定した場合だけ継承が発生します。同名のWorkerを置くだけでは継承されません。

## Workerの定義を編集する

`pixarium init reviewer`は次のファイルを作成します。既存のWorkerがある場合、`init`はファイルを上書きせずに失敗します。

```text
.pixarium/workers/reviewer/
├── worker.yaml
├── SYSTEM.md
└── skill/
    └── SKILL.md
```

### `worker.yaml`

`worker.yaml`には、Piの実行に使う設定と指示ファイルへの参照を記述します。

| 項目 | 指定する値 |
| --- | --- |
| `name` | Workerディレクトリと同じ名前。小文字英数字を単一のハイフンでつなぐ |
| `kind` | `worker`または`base`。省略時は`worker` |
| `description` | Workerへ任せる作業、またはbaseが提供する共通方針 |
| `extends` | local Workerが継承する`global:<base-name>` |
| `model` | Piが認識するモデル名。継承するlocal Workerでは省略可能 |
| `thinking` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。継承時は省略可能 |
| `systemPrompt` | Worker内の`SYSTEM.md`への相対パス |
| `skill` | Worker内の`SKILL.md`への相対パス |
| `skillMode` | `extend`または`replace`。省略時は`extend` |
| `tools` | Workerへ公開するPi組み込みtool。`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` |
| `commands` | Worker専用toolとして公開する実行fileと引数 |
| `contextFiles` | `discover`または`disabled`。省略時は継承値を使い、なければ`disabled` |
| `timeoutSeconds` | 正の秒数または`null`。省略時は継承値を使い、継承値もなければ無制限 |

実行可能なWorkerには、継承後の`model`、`thinking`、`systemPrompt`、`skill`、`tools`が必要です。base Workerは継承元として使うため、これらの一部を省略できます。

`systemPrompt`と`skill`が参照できるのは、同じWorkerディレクトリ内のファイルだけです。`skill/SKILL.md`には、空でない`name`と`description`を持つAgent Skills形式のfrontmatterが必要です。

### `SYSTEM.md`

`SYSTEM.md`には、Workerが依頼を解釈するときの役割と作業条件を記述します。少なくとも次の内容を定めてください。

- 担当する作業
- 許可する操作
- 守る制約
- 判断基準
- 最終回答に含める内容

Pixariumは、tool call前の短い予告、長い作業中の進捗報告、依頼範囲の維持、変更後の検証、最終回答の要約を定めた共通system promptを、各Workerの`SYSTEM.md`より前に適用します。Worker固有の役割と制約だけを`SYSTEM.md`へ記述してください。

### Workerへコマンドを許可する

`commands`へ記載した実行fileは、そのWorkerだけが使えるPi toolになります。任意引数を許可する場合は`arguments: passthrough`、引数を固定する場合は`args`を指定します。

```yaml
tools:
  - read
  - grep
  - find
  - ls

commands:
  - name: git
    description: Gitリポジトリを操作する
    executable: git
    arguments: passthrough

  - name: unit-test
    description: Gradleの単体テストを実行する
    executable: ./gradlew
    args:
      - test
    workingDirectory: .
    timeoutSeconds: 300
    maxOutputBytes: 200000
```

この例では、Piへ`git(args: string[])`と引数なしの`unit_test`を登録します。`unit-test`のハイフンはunderscoreへ正規化されます。実行fileと引数はshell文字列へ連結せず、プロジェクトrootを基準に実行します。

`workingDirectory`はプロジェクトrootからの相対pathです。`timeoutSeconds`の既定値は300秒、`maxOutputBytes`の既定値はstdoutとstderrの合計で200,000 byteです。出力が上限を超えた場合は先頭部分だけを返し、切り詰めたことを結果へ記録します。

`bash`は`tools`へ明示したWorkerだけが利用できます。`commands`へ`git`を許可しても`bash`は追加されません。Pixariumはcommandのサブコマンドを危険度で分類せず、Worker定義にある実行能力を事前の許可として扱います。command実行時の対話確認は行いません。

### context fileを制御する

`contextFiles: discover`を指定すると、Pi標準の探索規則で`AGENTS.md`と`CLAUDE.md`を読み込みます。リポジトリ由来の指示をWorkerへ渡さない場合は`disabled`を指定します。

```yaml
contextFiles: discover
```

`contextFiles`を省略した場合は、global baseの値を継承し、継承値もなければ`disabled`になります。`disabled`の実効WorkerにはPixariumが`--no-context-files`を渡します。

### `skill/SKILL.md`

`skill/SKILL.md`には、Workerが実行する手順と完了条件を記述します。

```markdown
---
name: review-current-changes
description: Review current repository changes and report evidence-backed problems.
---

# Review current changes

1. Git差分を確認する。
2. 変更箇所の周辺実装を確認する。
3. 関連するテストを確認する。
4. 根拠を確認できた問題だけを報告する。
```

## global Workerと継承を使う

複数のリポジトリで単独実行するWorkerは、`--global`を指定して作成します。このコマンドはGitリポジトリの外でも実行できます。

```bash
pixarium init --global investigator
```

共通の判断方針や既定値だけを定義する場合は、global baseを作成します。

```bash
pixarium init --global --base evidence-reviewer
```

baseの共通設定を使うlocal Workerは、対象リポジトリで`--extends`を指定して作成します。

```bash
cd /path/to/target-repository
pixarium init api-reviewer --extends global:evidence-reviewer
```

生成されるlocal `worker.yaml`は次の形です。`model`、`thinking`、`tools`、`commands`、`contextFiles`、`timeoutSeconds`はglobal baseから継承できます。

```yaml
name: api-reviewer
description: このプロジェクトのAPI変更をレビューする

extends: global:evidence-reviewer

systemPrompt: ./SYSTEM.md
skill: ./skill/SKILL.md
skillMode: extend
```

system promptはPixarium共通、global、localの順で適用されます。Skillは既定でglobal、localの順に適用されます。global Skillを使わず、local Skillだけを適用する場合は`skillMode: replace`を指定してください。

local Workerで`model`、`thinking`、`tools`、`commands`、`contextFiles`、`timeoutSeconds`を指定すると、対応するglobal baseの値を置き換えます。`tools`と`commands`は要素を追加せず、配列全体を置き換えます。

### 継承するWorkerの可搬性

`extends: global:<base-name>`を持つlocal Workerは、リポジトリだけでは実行できません。別の利用者やCIで使う場合は、同名・同内容のglobal baseを各環境の`~/.pixarium/workers/`へ用意してください。

global baseが存在しない場合や`kind: base`でない場合、Pixariumは検査と実行を失敗させます。local Worker単独での実行には切り替えません。リポジトリだけで再現できるWorkerが必要なら、global baseを継承しないstandalone local Workerを使用してください。

## Workerを探して検査する

`list`は参照できるWorkerを表示します。scopeを省略すると、同名ではlocalを優先した実行可能Workerを表示します。`--global`を指定した場合はbase Workerも表示されます。

```bash
pixarium list
pixarium list --json
pixarium list --local
pixarium list --global
```

`check`にWorker名を渡すと、そのWorkerを検査します。継承するlocal Workerでは、global baseと合成した実効設定も検査対象です。

```bash
pixarium check reviewer
pixarium check --global evidence-reviewer
```

Worker名を省略すると、選択したscopeにある定義をまとめて検査します。

```bash
pixarium check
pixarium check --local
pixarium check --global
```

## Workerを実行する

### 依頼を渡す

`--task`で依頼を渡す方法は、ターミナルからの実行と実行中の追加指示を同時に使う場合に適しています。

```bash
pixarium run reviewer --task "現在の変更差分をレビューしてください"
```

依頼は標準入力からも渡せます。

```bash
printf '%s\n' '認証処理の実装経路を調査してください' |
  pixarium run investigator
```

標準入力を最初の依頼に使った場合、同じ標準入力から追加指示は送れません。

同名のlocal Workerではなくglobal Workerを実行する場合は、scopeを明示します。global Workerを実行しても、Piの作業ディレクトリは現在のGitリポジトリです。

```bash
pixarium run --global reviewer --task "現在の変更差分をレビューしてください"
```

### 出力とタイムアウトを確認する

Workerの最終回答は`stdout`へ出力されます。エラーと追加指示の受付結果は`stderr`へ出力されます。Piの途中eventは通常の出力には含まれません。途中eventを確認する方法は[実行中のWorkerを観測する](#実行中のworkerを観測する)で説明します。

`timeoutSeconds`を省略し、継承元にも値がなければ、Pixariumは時間を理由にWorkerを停止しません。有限の時間で停止する必要があるWorkerだけ、正の秒数を指定してください。継承元の有限タイムアウトをlocal Workerで無効にする場合は`null`を指定します。

```yaml
timeoutSeconds: null
```

終了コードが0以外の場合は`stderr`を確認してください。表示された分類から原因を特定し、対応するWorker定義や実行環境を修正します。

### 実行中のWorkerへ追加指示する

`--task`で最初の依頼を渡したrunでは、標準入力を追加指示用のJSON Linesとして使用できます。同じターミナルセッションの標準入力へ、次のような1行を送信してください。

```json
{ "type": "steer", "message": "互換性維持は不要です。新しいAPIだけを対象にしてください。" }
```

受け付けられると、stderrへ次の診断が出力されます。

```text
[pixarium] steering accepted
```

受付は、現在のツール実行が中断されたことや、追加指示の処理が完了したことを意味しません。Piは現在のassistant turnにあるツール実行を終え、次のモデル呼び出し前に追加指示を渡します。

### 実行中のWorkerを観測する

別のターミナルで実行中のWorkerを一覧表示します。

```bash
pixarium runs
```

表示されたrun IDは、先頭から一意になる範囲まで省略して`attach`へ渡せます。

```bash
pixarium attach 01abcdef
```

`attach`は、Workerへ渡した依頼と直近のtraceを表示し、その後のeventを追跡します。traceでは次の情報を確認できます。

- モデルが公開した推論とテキスト
- ツールの開始と終了
- retryとcompaction
- 追加指示queueの更新

bashツールについては、コマンドと終了コードに加えて出力の先頭2行も表示します。providerが推論を公開しない場合、推論は表示されません。

traceはOSの一時ディレクトリにある権限0700のrun directoryへ保存されます。容量は合計256 KiBの循環bufferです。依頼は同じdirectoryの権限0600のファイルへ保存され、run終了時にdirectoryごと削除されます。異常終了で残ったdirectoryは、次回の`run`または`runs`がprocessの生存とheartbeatを確認したうえで削除します。

`attach`でCtrl-Cを入力するとobserverだけが終了し、Workerは実行を続けます。

## CLIリファレンス

| コマンド | 用途 |
| --- | --- |
| `pixarium auth` | Piで使用するOpenAI CodexのOAuth認証を行う |
| `pixarium models` | Piで利用できるモデルを表示する |
| `pixarium init [--local \| --global] [--base \| --extends "global:<name>"] <worker-name>` | Workerまたはbaseの雛形を作る |
| `pixarium list [--local \| --global] [--json]` | Workerを通常形式またはJSON形式で表示する |
| `pixarium check [--local \| --global] [worker-name]` | Workerまたは選択scopeの定義を検査する |
| `pixarium run [--local \| --global] <worker-name> [--task "<task>"]` | Workerへ引数または標準入力で依頼を渡す |
| `pixarium runs [--json]` | 実行中のWorkerを表示する |
| `pixarium attach <run-id>` | 実行中Workerのtraceを再生し、その後のeventを追跡する |

## 認証情報をリポジトリの外へ置く

Pixariumは、npmがPixariumの直接依存としてインストールしたPiを使用します。npmが依存をPixarium package内または上位の`node_modules`へ配置した場合も、Node.jsのpackage解決に従います。独立してグローバルインストールされた`pi`または`pi-ai`へ実行を切り替えません。

OpenAI APIキーを使う場合は、Pixariumを実行するプロセスの環境変数へ設定します。

```bash
export OPENAI_API_KEY='...'
```

Piの認証情報は、既定では`~/.pi/agent`に保存されます。`PI_CODING_AGENT_DIR`を設定する場合は、次の場所を含まないディレクトリを指定してください。

- Pixarium本体のリポジトリ
- Workerを実行する対象リポジトリ
- `~/.pixarium/`

Pixariumは、`PI_CODING_AGENT_DIR`がこれらの場所を指す場合に実行を拒否します。認証情報の内容をWorkerやPluginの設定へ転記しないでください。

## Codex Pluginから使う

Codex Plugin資材はCLIと同じPixariumリポジトリで管理し、[Tumbling Dice Marketplace](https://github.com/tumbling-dice/codex-plugins)からこのリポジトリを参照して配布します。Pluginを使うと、Codexから同梱Skillを通してWorkerへ作業を委譲できます。

Pluginはnpm版Pixariumの`pixarium`を実行します。先にCLIをglobal installし、必要な認証を完了してください。

```bash
npm install --global pixarium
pixarium auth
codex plugin marketplace add tumbling-dice/codex-plugins
codex plugin add pixarium@tumbling-dice
```

Workerの作成と診断には`pixarium` CLIを使用します。PluginまたはCLIを更新した後は、Codexを再起動して新しいセッションを開始してください。

### 同梱Skillから依頼する

Pluginには次のSkillが含まれます。

| Skill                        | 用途                                                      |
| ---------------------------- | --------------------------------------------------------- |
| `$use-pixarium`              | 指定したWorker、または依頼に適したWorkerを実行する        |
| `$configure-pixarium-worker` | local・globalのWorkerやbaseを新設・更新し、継承を設定する |
| `$migrate-to-pixarium`       | Codex custom agentと専用SkillをWorkerへ移行する           |

プロジェクト用Workerを作る場合は、対象リポジトリのCodexセッションで次のように依頼します。

```text
$configure-pixarium-workerを使って、このリポジトリのAPI変更をレビューするWorkerを作成してください。
```

作成済みのWorkerへ委譲する場合は、Worker名を指定するか、依頼に合うWorkerの選択をCodexへ任せます。

```text
$use-pixariumを使って、reviewer Workerでこの変更をレビューしてください。
```

```text
$use-pixariumを使って、この変更を適切なWorkerでレビューしてください。
```

global Workerを明示する場合はscopeも指定してください。指定したWorkerが存在しない場合や検査に失敗した場合、別のWorkerへは自動的に切り替わりません。

```text
$use-pixariumを使って、globalのreviewer Workerでこの変更をレビューしてください。
```

Codex custom agentを移行する場合は、agent名と移行先を指定します。scopeを省略すると、現在のリポジトリにあるagentをlocal Workerへ移行します。

```text
$migrate-to-pixariumを使って、reviewer agentと専用SkillをPixarium Workerへ移行してください。
```

user-level custom agentを移行する場合は、globalであることを明示してください。global移行では対象agentに直接関係する設定とSkillだけを参照し、認証情報や無関係なuser-level設定は移行しません。

```text
$migrate-to-pixariumを使って、globalのreviewer agentをstandalone global Workerへ移行してください。
```

`$use-pixarium`は、Codex側のshell実行機構から`pixarium run`を起動します。Workerが利用するネットワーク、認証情報、filesystem、command toolへアクセスできるよう、実行時にsandbox外のshell commandに対する承認が必要です。

### CLIとPluginを更新する

CLIとPluginは同じGitリポジトリで管理しますが、npm packageとCodex Pluginとして別々に配布されます。npm版CLIを更新した後、Marketplaceのsnapshotを更新してPluginを再インストールします。

```bash
npm install --global pixarium@latest
codex plugin marketplace upgrade tumbling-dice
codex plugin add pixarium@tumbling-dice
codex plugin list
```

`codex plugin list`で`pixarium@tumbling-dice`が`installed, enabled`と表示されることを確認します。その後、ChatGPTデスクトップアプリまたはCodex CLIを再起動し、新しいCodexセッションを開始してください。既存セッションは更新前のSkillを保持しています。
