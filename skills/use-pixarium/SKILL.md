---
name: use-pixarium
description: Pixarium Workerへ作業を委譲するため、対象GitリポジトリでlocalまたはglobalのWorkerを直接実行し、失敗時だけ設定、認証、モデル、実行環境を診断する。ユーザーがWorker名を指定した依頼と、依頼内容からWorkerを選ぶ依頼の両方で使用する。
---

# Pixariumを使用する

npmでglobal installされた`pixarium`コマンドをCodexからの実行入口とする。コマンドが見つからない場合は処理を止め、`npm install --global pixarium`をユーザーへ案内する。

既存Workerと対象リポジトリを信頼済みとして扱う。Workerの作成、更新、導入時の検証は`configure-pixarium-worker`で行い、通常の委譲前に`check`を重ねて実行しない。`run`はWorkerのscope解決と実効設定の検証を内部で行う。

## 1. Workerを決める

対象のGitリポジトリでWorkerを決める。

### ユーザーがWorker名を指定した場合

1. 指定された名前をそのまま使用し、依頼内容から別のWorkerを選び直さない。
2. 事前の`list`と`check`を実行しない。
3. scopeも指定された場合だけ保持する。scope未指定の場合はCLIのscope optionを省略し、local優先、global fallbackの解決に任せる。

### Worker名が指定されていない場合

1. `pixarium list --json`を実行する。この一覧は同名ではlocalを優先し、global baseを継承済みの実効設定を返す。
2. 各Workerのdescriptionと許可ツールを依頼内容と比較し、依頼対象を明示的に含み、必要な操作を実行できるWorkerだけを選ぶ。
3. 該当するWorkerがない場合や一意に選べない場合は、Workerを作ったり推測で選んだりせず報告する。
4. 選んだWorkerの`name`と`scope`を保持し、追加の`check`を挟まず実行する。

## 2. CLIで実行する

1. Piの認証、ネットワーク、ツール実行に必要なアクセスを与えるため、Codex側のsandbox外実行機構を使い、`run`を最初から権限付きで起動する。Pixariumへ権限確認や権限昇格を委ねない。
2. 具体的な依頼内容と対象範囲をtaskへ渡す。scope未指定のWorkerはscope optionを省略する。

   ```sh
   pixarium run <worker-name> --task "<具体的な作業内容と対象範囲>"
   pixarium run --<scope> <worker-name> --task "<具体的な作業内容と対象範囲>"
   ```

3. 長時間実行ではterminal sessionを保持し、空のpollで実行中か終了済みかだけを確認する。頻繁なpollは行わない。
4. Worker実行中にユーザーから関連する追加指示があった場合だけ、必要な差分を次のJSON Linesとして同じterminal sessionへ送る。

   ```json
   { "type": "steer", "message": "<Workerへ追加する条件だけを記述する>" }
   ```

   stderrの`[pixarium] steering accepted`は受付だけを示し、処理完了とは扱わない。

5. 終了コードが0の場合だけstdoutをWorkerの最終回答として扱う。Workerの回答が判断に影響する場合や根拠が不足している場合は、主な主張をリポジトリ内で確認する。

## 3. 失敗した場合だけ診断する

1. ゼロ以外の終了コード、タイムアウト、設定、認証、モデル、Pi実行のエラーを委譲失敗として扱う。途中までの出力を成功したWorkerの結果として提示しない。
2. stderrがconfigurationまたはWorker定義のエラーを示す場合、実行した名前とscopeに対して`check`を実行する。
3. 認証またはモデルのエラーでは、`pixarium models`で利用可能なモデルを確認する。認証情報がない場合だけ、ユーザーへ`pixarium auth`の対話実行を依頼する。
4. filesystem、Pi起動、timeoutのエラーでは、報告された失敗箇所と実行環境を確認する。権限を回避するために`PI_CODING_AGENT_DIR`を対象リポジトリ、Pixariumリポジトリ、一時ディレクトリへ変更しない。
5. 原因を解消できた場合だけ、同じscope、Worker、taskを再実行する。明示指定されたWorkerが失敗しても別Workerへフォールバックしない。
6. 認証ファイルをコピー、移動、表示、検査しない。

人間がWorkerへ渡したtask、推論、ツール利用を観測する場合は、Codexへtraceを取り込まず、人間向けCLIの`pixarium runs`と`pixarium attach <run-id>`を別ターミナルで使用する。Codex自身は、ユーザーから明示的に依頼されない限り`attach`を実行しない。

Worker固有のレビュー手順や調査手順は、このSkillへ追加しない。local定義は対象リポジトリの`.pixarium/workers/<name>/`、global定義とbaseは`~/.pixarium/workers/<name>/`に置く。継承関係はlocal `worker.yaml`の`extends`を基準とし、Codex側で独自に合成しない。
