---
name: commit-diff
description: 指定されたGit差分を確認し、問題がなければその差分だけを1件のcommitにする。
---

# 差分を確認してcommitする

1. 依頼からcommit対象のpathと、実行済み検証の結果を特定する。どちらかが不明ならcommitせず報告する。
2. `git status --short`、`git diff --check`、unstaged diff、staged diff、対象のuntracked fileを確認する。
3. 次のいずれかがあればcommitせず、該当pathと理由を報告する。
   - 依頼範囲外の変更を対象に含める必要がある。
   - conflict marker、whitespace error、認証情報、生成物の直接編集、明らかなplaceholderがある。
   - 差分の内容とcommit目的が一致しない。
   - 依頼が必要とする検証の成功を確認できない。
4. 対象pathだけを列挙して`git add`し、`git diff --cached --check`を実行する。
5. `git diff --cached --stat`とstaged diffを読み、対象外の変更がないことを再確認する。
6. 差分を表す英語の命令形subjectで1件のcommitを作成する。
7. `git status --short`と`git log -1 --oneline`で結果を確認する。

ファイルを修正して問題を解消してはならない。問題があればcommitせずMain Agentへ戻す。
