---
name: configure-pixarium-worker
description: Pixarium Workerを新規作成または更新し、local・globalのscope、global base、local継承、SYSTEM.md、Skill、model、thinking、tools、commands、timeoutを設定して検証する。ユーザーがWorkerの追加、調整、共通方針のbase化、既存Workerの継承構成への変更を依頼した場合に使う。Codex custom agentからの移行や、Workerへの作業委譲には使わない。
---

# Pixarium Workerを設定する

npmでglobal installされた`pixarium`コマンドを使用する。コマンドが見つからない場合は処理を止め、`npm install --global pixarium`をユーザーへ案内する。

## 境界

- Workerの新設、既存定義の更新、global base化、local継承設定だけを行う。
- Codex custom agentの移行には`migrate-to-pixarium`を使う。
- 設定したWorkerを自動実行せず、実際のLLM APIを呼び出さない。
- 認証情報、APIキー、OAuthトークン、Piの認証ファイルを読み取り、コピー、移動しない。
- 既存Workerを更新する場合、依頼と関係ない指示やファイルを変更しない。
- globalへの書き込みが依頼に含まれていない場合、`~/.pixarium/`を変更する前にユーザーの同意を得る。

## 1. 目的と既存定義を確認する

1. local Workerを扱う場合は`git rev-parse --show-toplevel`で対象リポジトリを確定する。
2. 次を必要なscopeだけ実行し、同名または関連するWorkerとbaseを確認する。

   ```sh
   pixarium list --local --json
   pixarium list --global --json
   ```

3. ユーザーの依頼とリポジトリの実装・文書から、Workerの担当作業、対象範囲、許可操作、完了条件を特定する。
4. scopeや継承構成を次の条件で選ぶ。

   - 現在のリポジトリだけで使う具体的な作業はlocal Workerにする。
   - 複数のリポジトリで単独実行する完成済みWorkerはglobal Workerにする。
   - 複数のリポジトリで共有する判断方針、既定値、共通手順はglobal baseにする。
   - global baseへプロジェクト固有の役割や手順を加える場合は、`extends: global:<base-name>`を持つlocal Workerにする。

scopeが依頼から決まらず、保存先と可搬性が変わる場合は推測しない。global継承を可搬性だけを理由に避けず、ユーザーが求めた再利用単位に従う。

## 2. 実効設定を設計する

次を決めてからファイルを変更する。

- `description`: 委譲時に対象作業を判別できる具体的な説明
- `model`: Piが認識する固定モデル名。継承値がなく、特定できない場合は`pixarium models`で候補を確認し、推測しない
- `thinking`: `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`
- `tools`: `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`から必要なものだけを選ぶ
- `commands`: `bash`を渡さず特定の実行fileだけを許可する場合に定義する。任意引数は`arguments: passthrough`、固定引数は`args`を使う
- `contextFiles`: Pi標準の`AGENTS.md`と`CLAUDE.md`探索を許可する場合は`discover`、許可しない場合は`disabled`。省略時は継承値を使い、継承値もなければ`disabled`
- `timeoutSeconds`: 有限の時間で自動停止する必要がある場合だけ正の整数を指定する。`null`は明示的な無制限。省略時は継承値を使い、継承値もなければ無制限
- `SYSTEM.md`: Pixarium共通promptへ追加する、Worker固有の役割、許可、禁止、判断基準、最終回答の条件
- `skill/SKILL.md`: 具体的な作業手順、確認対象、完了条件、中止または判断保留の条件

### modelとthinkingを選ぶ

modelとthinkingは、必要条件を満たす最小の組み合わせを別々に選ぶ。書き込み操作を行うことや失敗時の影響が大きいことだけを理由にmodelやthinkingを上げない。操作上の安全性は`tools`、SYSTEM.mdの禁止事項、Skillの停止条件で制御する。

modelは、対象範囲、判断の分岐、実装や問題解決の有無から選ぶ。利用可能なGPT-5.6系モデルでは次を基準にする。

| model | 選ぶ条件 |
| --- | --- |
| `openai-codex/gpt-5.6-luna` | 手順と出力形式が固定され、探索範囲が狭く、異常時は修正せず停止できる確認、分類、定型操作 |
| `openai-codex/gpt-5.6-terra` | 複数ファイルを扱う通常の実装、レビュー、テスト分析、原因がある程度限定されたデバッグ |
| `openai-codex/gpt-5.6-sol` | 広範囲な設計変更、原因未特定の複雑な障害、複数の制約をまたぐ移行や問題解決 |

次の条件が増えるごとに上位modelを検討する。

- 複数のサブシステム間の関係を追う。
- 要件が曖昧で、候補を比較して判断する。
- Worker自身が問題を特定し、修正し、再検証する。
- 長い差分や多数のファイルから整合性を判断する。

thinkingはmodelと独立して、推論の分岐数と検証量から選ぶ。

| thinking        | 選ぶ条件                                                                     |
| --------------- | ---------------------------------------------------------------------------- |
| `low`           | 固定手順で分岐が少なく、成功条件と停止条件が明示された作業                   |
| `medium`        | 通常の実装やレビューで、いくつかの選択と確認が必要な作業                     |
| `high`          | 複数案の比較、原因調査、複数段階の検証が必要な作業                           |
| `xhigh` / `max` | 長い依存関係や高い不確実性があり、追加推論による改善を具体的に説明できる作業 |

OpenAI Codex providerのGPT-5.6系では`low`、`medium`、`high`、`xhigh`、`max`から選ぶ。PiのCLIはprovider共通値として`off`と`minimal`も受け付けるが、GPT-5.6系では`minimal`は`low`へ変換され、`off`はreasoning effortを省略してprovider既定値を使うため、値の名前どおりの指定にならない。OpenAI APIの`none`をPiの`off`と同一視しない。

例えば、差分を確認して指定pathだけをcommitし、問題があれば修正せず停止するWorkerは`luna`の`low`を使う。差分の問題を自ら修正する責務まで加わる場合は、対象範囲に応じて`terra`以上を検討する。

ユーザーがmodelまたはthinkingを指定した場合はその値を使う。候補が`pixarium models`にない場合や、利用可能なmodelの用途を判断できない場合は推測せず確認する。

読み取り専用Workerへ`bash`を追加する場合、Piでは実行コマンドを読み取り専用に制限できないことを考慮する。`tools`を継承するlocal Workerで配列を指定した場合は、global値との和集合ではなく配列全体が置き換わる。

Workerへ特定のcommandだけが必要な場合は、`bash`ではなく`commands`を使う。Pixariumはcommandの危険度やサブコマンドを判定しない。Worker定義へ追加した実行fileと、passthroughで渡せる全引数が許可範囲になる。`commands`を継承するlocal Workerで配列を指定した場合も、global値との和集合ではなく配列全体が置き換わる。

`contextFiles: discover`は対象repository由来のprompt入力を許可し、Piの規則に従って`AGENTS.md`と`CLAUDE.md`の両方を探索する。片方だけを選択する設定として扱わない。Worker固有のSYSTEM.mdからcontext fileを手動探索させず、自動探索の要否はこのfieldで決める。

system promptはPixarium共通、global、localの順に適用される。Skillは既定でglobal、localの順に適用する。global Skillを使わない場合だけlocal `worker.yaml`へ`skillMode: replace`を指定する。同名定義による暗黙継承は使わない。

## 3. 作成または更新する

新規Workerは構成に対応するコマンドで雛形を作る。

```sh
pixarium init --local <worker-name>
pixarium init --global <worker-name>
pixarium init --global --base <base-name>
pixarium init --local <worker-name> --extends global:<base-name>
```

local Workerからglobal baseを継承する場合、作成前に次を実行し、継承先が有効なbaseであることを確認する。

```sh
pixarium check --global <base-name>
```

既存Workerには`init`を実行せず、そのWorkerディレクトリ内の`worker.yaml`、`SYSTEM.md`、`skill/SKILL.md`を更新する。`worker.yaml`へPixariumが定義していない項目を追加しない。`systemPrompt`と`skill`の参照先をWorkerディレクトリ外へ向けない。雛形の説明、プレースホルダーモデル、不要な手順を残さない。

global baseは部分的な定義を持てる。実行可能なWorkerは継承後に`model`、`thinking`、`systemPrompt`、`skill`、`tools`が揃うようにする。`commands`は省略でき、継承値もなければ空配列になる。

## 4. 検証して報告する

変更した各定義をscopeを明示して検証する。

```sh
pixarium check --local <worker-name>
pixarium check --global <worker-name-or-base-name>
```

検証に失敗した場合は、今回変更したWorkerだけを修正して再実行する。成功後、対応するscopeの`list --json`で表示値を確認する。Workerは実行しない。

次を報告する。

- 作成または更新したパスとscope
- standalone Worker、base、継承するlocal Workerのどれか
- 継承元と`skillMode`
- model、thinking、tools、commands、contextFiles、timeoutの実効値（無制限の場合はその旨）
- SYSTEM.mdとSkillへ記述した役割
- `check`の結果

local Workerがglobal baseを継承する場合、その依存を報告する。チームやCIでの利用が依頼に含まれる場合は、同じglobal baseを各環境へ用意する必要があることも報告する。可搬性を理由に構成変更や追加確認を行わない。
