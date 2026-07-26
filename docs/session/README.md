# docs/session — エージェント間チャットの規約

会話の正本は**作業ごとの** `docs/session/<作業名>.jsonl`（JSON Lines・追記のみ）。
**この README が規約の正**である。`.claude/skills/session-chat` と矛盾したらこちらに従う。

> ⚠️ この運用は、いま実装している AgentOrchestrator が完成すれば `ao` コマンドに置き換わる。
> それまでは（＝この作業の間は）ファイルベースで回す。

## 作業とファイルの対応表

| 作業名 | ファイル | HANDOFF | 状態 |
|---|---|---|---|
| `orchestrator-mvp` | `orchestrator-mvp.jsonl` | [docs/handoff/orchestrator-mvp.md](../handoff/orchestrator-mvp.md) | 進行中 |

## 参加者表

| 識別子 | ロール | 担当 |
|---|---|---|
| `owner` | オーナー（人間） | 要件・アカウント操作・GitHub リポジトリ作成・デプロイ。**離脱の許可を出せる唯一の存在** |
| `designer` | 設計者（エージェント） | CONTEXT / ADR / HANDOFF の更新、設計判断 |
| `implementer` | 実装者（エージェント） | `orchestrator-mvp` の実装 |

未登録の識別子で発言する前に、この表へ行を追加すること。

## メッセージスキーマ

```json
{"id":"msg-0001","ts":"2026-07-26T13:00:00+09:00","from":"designer","to":["implementer"],
 "type":"message|question|answer|decision|status","body":"...",
 "refs":["docs/handoff/orchestrator-mvp.md#5-コアロジック仕様"],"reply_to":null}
```

## ルール

1. **追記のみ。過去行の編集・削除は禁止。** 訂正は新しいメッセージで
2. **1回の書き込みは必ず1行。** 複数の内容は `body` 内の `\n` で1メッセージに収める
3. 1行 = 1つの有効な JSON。`question` への返信は `type=answer` + `reply_to` 必須
4. 作業開始時・再開時は、自分宛の未回答 `question` を最優先で処理する
5. **決定をチャットで完結させない。** 正は `CONTEXT.md` / `docs/adr/` / `docs/handoff/`
6. シークレット・トークン値を書かない（コミット対象ファイル）
7. **ボールが自分にある状態で待ちに入らない・会話を終えない**（下記）
8. **resolve は監視の終了ではない。離脱してよいのはオーナーが明示的に指示したときだけ**

## ボールの自問（ポーリングのたびに行う）

次のいずれかに当てはまるならボールは**自分**にある。待たずに作業を続けること。

1. 自分宛の未回答 `question` がある
2. 引き受けた作業がまだ完了報告に至っていない
3. 直前の自分のメッセージで「やる」と書いたことを、まだやっていない
4. 相手の指摘・依頼を受領したが、対応も反論もまだ返していない

すべて偽で、かつ自分が投げた `question` の回答待ちか完了報告への承認待ちのときだけ、
ボールは相手にある。**待つと決めたときは、何を待っているのかをチャットに書いてから待つ。**

## 書き込み（この手順で。JSON は手書きしない）

```bash
cd /Users/itsukisugita/Documents/project/AgentOrchestrator
f=docs/session/orchestrator-mvp.jsonl
next=$(printf 'msg-%04d' $(( $(tail -1 "$f" | jq -r '.id' | sed 's/msg-0*//') + 1 )))
jq -nc \
  --arg id "$next" \
  --arg ts "$(date +%Y-%m-%dT%H:%M:%S+09:00)" \
  --arg from "<自分の識別子>" \
  --arg type "<message|question|answer|decision|status>" \
  --arg body "本文。複数段落は\nで区切る" \
  --arg reply_to "<返信先id、新規話題なら空>" \
  --argjson to '["<宛先>"]' \
  --argjson refs '[]' \
  '{id:$id, ts:$ts, from:$from, to:$to, type:$type, body:$body, refs:$refs,
    reply_to:(if $reply_to=="" then null else $reply_to end)}' >> "$f"
tail -1 "$f" | jq -e '.id' >/dev/null || echo "!! 破損行を書いた。修正メッセージを追記せよ（行の編集・削除は禁止）"
```

**ID 衝突**: 採番が「末尾行 +1」である以上、2者がほぼ同時に書くと同じ ID になりうる。
追記専用なので行は消さない。以後その番号を参照するときは `msg-0024/designer` のように
`from` を添えて区別し、採番は常にファイル末尾を基準に続ける（欠番を作らない）。

## 監視（行数ポーリング。`tail -F` は全置換書き込みを取り逃すので禁止）

```bash
f=/Users/itsukisugita/Documents/project/AgentOrchestrator/docs/session/orchestrator-mvp.jsonl
prev=$(wc -l < "$f")
while true; do
  n=$(wc -l < "$f")
  if [ "$n" -gt "$prev" ]; then
    sed -n "$((prev+1)),${n}p" "$f" | grep -v '"from":"<自分の識別子>"' || true
    prev=$n
  fi
  sleep 2
done
```
