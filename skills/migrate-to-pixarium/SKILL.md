---
name: migrate-to-pixarium
description: Migrate one Codex custom agent and its dedicated Agent Skill into a Pixarium worker. Use for repository-scoped agents declared in `.codex/config.toml`, or for a user-level agent in `~/.codex/config.toml` only when the user explicitly requests a global migration. Preserve role constraints and report Codex-to-Pi incompatibilities.
---

# Codex custom agentをPixariumへ移行する

npmでglobal installされた`pixarium`コマンドを使用する。コマンドが見つからない場合は処理を止め、`npm install --global pixarium`をユーザーへ案内する。

## 境界

- Codex custom agentを一度に一つだけ移行する。
- scope指定がない場合は、現在のGitリポジトリに定義されたagentをlocal Workerへ移行する。
- ユーザーがglobal agentの移行を明示した場合だけ、`~/.codex/config.toml`のagentをglobal Workerまたはglobal baseへ移行する。
- global移行の依頼から、現在のリポジトリにlocal child Workerを作ることまでは推測しない。
- 一般的なWorkerの新設や更新には`configure-pixarium-worker`を使う。
- 移行元のCodex設定、agent設定、専用Skillを変更または削除しない。
- 既存のPixarium Workerを上書きしない。
- ユーザーの認証情報、`~/.codex/auth.json`、Piの認証ファイルを読み取らない。
- user-level configでは、対象agentのtableとそこから直接参照されるファイルだけを調べる。provider、MCP、通知、telemetryなど、対象agentと無関係なtableの内容を表示または移行しない。
- 移行後のWorkerを自動実行しない。LLM呼び出しはユーザーが別途依頼した場合だけ行う。
- CodexとPiで同じ制約を表現できない場合、同等とみなさず差異を報告する。

## 1. scopeと移行先を決める

ユーザーの依頼から次のいずれかを選ぶ。

| 依頼 | Codex設定 | 移行先 | `init` |
| --- | --- | --- | --- |
| scope指定なし、またはlocal | `<git-root>/.codex/config.toml` | local Worker | `init --local` |
| global Workerへの移行を明示 | `~/.codex/config.toml` | standalone global Worker | `init --global` |
| global baseへの移行を明示 | `~/.codex/config.toml` | global base | `init --global --base` |

「global」がCodex側の移行元とPixarium側の移行先のどちらを指すか判別できない場合は、作成前に確認する。global agentの完全な手順を移す依頼はstandalone global Worker、共通方針や既定値だけをlocal Workerから継承する依頼はglobal baseとして扱う。どちらか判断できなければ推測しない。

global移行では、対象agent名をユーザーの依頼から特定する。名前が未指定の場合は`~/.codex/config.toml`からagent名だけを列挙し、一つに決められなければ選択を求める。設定全体を出力しない。

## 2. 移行元を特定する

1. local移行では`git rev-parse --show-toplevel`で対象リポジトリのルートを確認する。global移行だけを行う場合はGitリポジトリを必須としない。
2. 選択したscopeの`config.toml`にある`[agents.<name>]`から対象agentを選ぶ。localで名前が未指定の場合、候補が一つならそれを使い、複数なら選択を求める。
3. `agents.<name>.config_file`を宣言元のTOMLファイルからの相対パスとして解決し、role設定を読む。
4. agentの指示、role設定、または明示的なSkill名から直接関係を確認できる専用`SKILL.md`だけを特定する。localではリポジトリ内、globalではユーザー環境内を対象とする。候補が複数ある場合や、汎用Skillと専用Skillを区別できない場合は推測しない。
5. local移行ではagentの動作に関係するリポジトリ内の`AGENTS.md`を確認し、自動探索を維持するか、必要な規則だけをWorkerへ明示するかを決める。global移行では、特定リポジトリの`AGENTS.md`をglobal Workerへ取り込まない。

次を移行元として記録する。

- `[agents.<name>]`の`description`
- role設定の`model`、`model_reasoning_effort`、`developer_instructions`
- role設定の`model_instructions_file`と、その参照先の内容
- sandbox、permissions、tools、MCP、web searchに関する設定
- 専用Skillのfrontmatterと本文
- agentまたはSkillが依存する`AGENTS.md`の規則

選択したscope外の設定を暗黙に読んで不足値を補わない。standalone Workerで必須となる値が移行元になければ、ユーザー指定が必要な項目として扱う。global baseでは、local Worker側で指定できる値を無理に補完しない。

## 3. 互換性を判定する

Workerを作る前に、次の対応を決める。

| Codex側 | Pixarium側 | 変換規則 |
| --- | --- | --- |
| agent名 | Workerディレクトリ名、`name` | 小文字英数字とハイフンへ正規化する |
| agentの`description` | `description` | 委譲先を選べる具体性を保つ |
| `model` | `model` | Piの`provider/model`形式にする |
| `model_reasoning_effort` | `thinking` | 共通する値をそのまま使う |
| role指示 | `SYSTEM.md` | 役割、許可、禁止、判断基準、最終回答へ再構成する |
| 専用Skill | `skill/SKILL.md` | 作業手順、確認対象、完了・中止条件として移す |
| sandboxと作業内容 | `tools` | 必要なPi組み込みツールだけを選ぶ |
| repository context | `contextFiles` | Pi標準の`AGENTS.md`と`CLAUDE.md`探索を許可する場合だけ`discover`、それ以外は`disabled` |
| timeout | `timeoutSeconds` | 移行元に有限値があれば正の秒数を指定する。固定値がなければ省略して無制限にし、継承した有限値を無効にする場合は`null`を指定する |

CodexのOpenAIモデル名がproviderなしで固定されている場合は、PixariumのOAuth利用を前提として`openai-codex/<model>`へ変換し、その変換を結果に記載する。別providerを使う指示がある場合やモデルを特定できない場合は推測しない。

Piで許可できるツールは`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`だけとする。専用Skillの実際の手順から最小集合を選び、Codexのツール名をそのまま書かない。

次の場合はWorker作成前に停止し、不一致と必要な判断を報告する。

- standalone Workerで固定するモデルまたは推論レベルを特定できない。
- 必須のMCP、web search、画像、subagent、外部ツールをPi組み込みツールへ置き換えられない。
- Codexのsandboxやpermissionsによる制限を、Piのツール許可だけでは維持できない。
- 読み取り専用agentが`bash`を必要とする。Piの`bash`は読み取り専用コマンドだけに制限できないため、明示的な許容なしに追加しない。
- 専用Skillまたは必須の参照ファイルを一意に特定できない。

## 4. Workerを生成する

1. Worker名が`^[a-z0-9-]+$`を満たすことを確認する。
2. 「scopeと移行先」の表で選んだ`init`を実行する。localはGitルート、globalは任意の作業ディレクトリから実行できる。global保存先への書き込みに実行環境の承認が必要なら、対象パスを示して承認を求める。
3. 生成された3ファイルを移行内容で置き換える。雛形の説明やプレースホルダーを残さない。

standalone Workerの`worker.yaml`には固定した値、必要最小限のtools、選択した`contextFiles`を書く。global baseでは`kind: base`を維持し、実際に共通化する値だけを残す。元のCodex設定に存在するがPiで再現していない項目を、YAMLの独自項目として追加しない。

`SYSTEM.md`には次だけを書く。

- Workerの役割と対象範囲
- 実施してよいこと、実施してはいけないこと
- 判断基準と、事実・推測の区別
- `AGENTS.md`から明示的に引き継ぐ必要がある制約
- 最終回答に含める内容

`skill/SKILL.md`には`name`と`description`だけのfrontmatterを置き、次を書く。

- 具体的な作業手順と確認対象
- Pi組み込みツールで実行できる操作
- 完了条件
- 中止または判断保留とする条件

Codexのagent生成、agent間メッセージ、承認要求、Codex専用ツールを使う手順は残さない。元Skillの目的に必要な参照先がWorkerディレクトリ外にある場合、Skillから通常のリポジトリファイルとして参照する。`worker.yaml`の`systemPrompt`または`skill`をWorkerディレクトリ外へ向けない。

## 5. 検証して報告する

1. localでは`pixarium check --local <worker-name>`、globalでは`pixarium check --global <worker-name>`を実行する。
2. 失敗した場合は生成したWorkerだけを修正し、成功するまで再実行する。移行元は修正しない。
3. 選択したscopeを指定した`list --json`で生成したWorkerの表示値を確認する。
4. 次を報告する。

   - 移行元と移行先のscope
   - 移行元agent設定と専用Skillのパス
   - 生成したWorkerのパス
   - agent名、モデル、推論レベル、tools、contextFilesの対応
   - `AGENTS.md`から明示的に移した規則
   - 移行時に変更または除外したCodex固有の動作
   - `check`の結果
   - 実行前に利用者が確認すべき制約

検証成功は、Codex agentとPi Workerの動作が完全に同じことを意味しない。sandbox、暗黙のcontext、利用可能ツールが異なる点を、確認していないまま同等と報告しない。
