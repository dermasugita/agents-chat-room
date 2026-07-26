# SESSION-PROTOCOL — 実装者との非同期チャット運用

会話の正本はリポジトリ内 `docs/session/<作業名>.jsonl`（JSON Lines・追記のみ）。**作業ごとにファイルを分ける**（複数の作業を別 worktree で並行させたときに、ID 衝突と読み分けの両方が解決する）。初回受け渡し時に以下を整備する。対象リポジトリに `session-chat` 系のプロジェクトスキルが既にあればそちらの手順を優先する。

## 1. 初期整備（受け渡し時に1回）

1. `docs/session/README.md` を作成: **作業とファイルの対応表**、参加者表（`owner` / `designer` / `implementer`）、メッセージスキーマ、type 定義、ルールを記載。README は作業をまたいで1本
2. `docs/session/<作業名>.jsonl` に designer からの最初のメッセージ（msg-0001）を書く。内容は必ず: **読む順番（HANDOFF → CONTEXT → ADR）** と **HANDOFF §7 要検証事項の裏取りを status で報告せよ、設計と食い違う事実は実装前に question を立てよ**

### メッセージスキーマ

```json
{"id":"msg-0001","ts":"2026-01-01T09:00:00+09:00","from":"designer","to":["implementer"],
 "type":"message|question|answer|decision|status","body":"...","refs":["docs/handoff/<作業名>.md#..."],"reply_to":null}
```

### ルール（README に明記する）

1. 追記のみ。過去行の編集・削除禁止。訂正は新規メッセージで
2. **1回の書き込みは必ず1行**。複数の内容は `body` 内の `\n` で1メッセージに収める
3. 1行 = 1つの有効な JSON。`question` への返信は `answer` + `reply_to` 必須
4. 各エージェントは作業開始時に自分宛の未回答 `question` を最優先処理
5. 決定はチャットで完結させない（正は CONTEXT / ADR / HANDOFF）
6. シークレット禁止（トークン値はリポジトリ外へ、チャットには置き場所のみ）

## 2. 安全な書き込み（jq -nc で1行保証・自動採番）

```bash
f=docs/session/<作業名>.jsonl
next=$(printf 'msg-%04d' $(( $(tail -1 "$f" | jq -r '.id' | sed 's/msg-0*//') + 1 )))
jq -nc --arg id "$next" --arg ts "$(date +%Y-%m-%dT%H:%M:%S+09:00)" \
  --arg from "designer" --arg type "answer" --arg body "本文\n複数段落可" \
  --arg reply_to "msg-XXXX" --argjson to '["implementer"]' --argjson refs '["docs/handoff/<作業名>.md#..."]' \
  '{id:$id, ts:$ts, from:$from, to:$to, type:$type, body:$body, refs:$refs,
    reply_to:(if $reply_to=="" then null else $reply_to end)}' >> "$f"
```

## 2.5 ID 衝突

採番が「末尾行 +1」である以上、2 者がほぼ同時に書くと**同じ ID になる**（実際に発生した）。追記専用なので**行は消さない**。以後その番号を参照するときは `msg-0024/designer` のように `from` を添えて区別し、採番は常にファイル末尾を基準に続ける（欠番を作らない）。書き込み直後に `jq -r '.id' "$f" | sort | uniq -d` で確認するとよい。作業ごとにファイルを分ければ同時追記の相手が減り、衝突自体が起きにくくなる。

## 3. 監視（行数ポーリング。`tail -F` は全置換書き込みを取り逃すので禁止）

複数の作業を並行させるときは、**`docs/session/*.jsonl` 全体**を1つの監視で見る。通知に作業名を付けると、どのスレッドの発言か即座に判別できる。

```bash
D=<絶対パス>/docs/session
declare -A seen
for f in "$D"/*.jsonl; do seen["$f"]=$(wc -l < "$f"); done
while true; do
  for f in "$D"/*.jsonl; do
    prev=${seen["$f"]:-0}; n=$(wc -l < "$f" 2>/dev/null || echo "$prev")
    if [ "$n" -gt "$prev" ]; then
      sed -n "$((prev+1)),${n}p" "$f" | grep -v '"from":"designer"' \
        | jq -rc --arg w "$(basename "$f" .jsonl)" '"[\($w)] \(.id) \(.from) type=\(.type) :: \(.body | .[0:300])"' 2>/dev/null || true
      seen["$f"]=$n
    fi
  done
  sleep 2
done
```

Monitor ツールがあれば `persistent: true` で登録し、通知駆動で応答する。通知本文は切り詰められることがあるので、**応答前に必ずファイルから全文を読む**。

**ポーリングのたびに「ボールは自分にあるか」を判定させる。** 自分宛の未回答 `question` がある / 引き受けた作業が完了報告に至っていない / 直前に「やる」と書いたことをまだやっていない / 指摘を受領したが対応も反論も返していない——このいずれかならボールは自分にあり、待たずに作業を続ける。相手の書き込みが無いことは、手を止めてよい理由にならない。**ボールが自分にある状態で待ちに入る・会話を終えることを禁じる。** 待つと決めたときは、何を待っているのかをチャットに書いてから待つ（黙って待つと相手からは作業中と区別がつかない）。

設計者側は、実装者が沈黙したときに**まず「相手のボールか」を確認し、次に差分を見る**。チャットの沈黙は進捗の指標にならない（実装中はチャットに書かないのが正常）。5分間隔で作業ツリーの差分と HEAD を確認し、動いていれば介入しない。2回連続で完全に同一なら、そこで初めて「何がボールを止めているか」を尋ねる `question` を投げる。

進捗監視の例（変化が無いときだけ通知するので、正常稼働中は静か）:

```bash
declare -A prev
while true; do
  for w in <リポジトリ>/worktree/*; do
    [ -d "$w/.git" ] || [ -f "$w/.git" ] || continue
    cur=$(git -C "$w" status --porcelain; git -C "$w" log -1 --format=%H)
    key=$(basename "$w"); sig=$(printf '%s' "$cur" | shasum | cut -d" " -f1)
    if [ "${prev[$key]}" = "$sig" ]; then echo "[$key] 差分に変化なし（前回確認から)"; fi
    prev[$key]=$sig
  done
  sleep 300
done
```

## 4. ラリー中の応答手順（designer）

1通受信するごとに:

1. `tail -1 | jq -r '.body'` で全文を読む
2. 判断を三分類する — 設計者即断 / オーナー確認（選択肢+推奨で聞く。伝聞の要件変更は本人確認）/ 実装者委任
3. 設計に関わるなら**先に** CONTEXT / ADR / HANDOFF を更新
4. `answer`（`reply_to` 付き・refs に更新した文書）を1行追記
5. マイルストーン報告（テスト通過・デプロイ・有効化）は**承認前に独立検証**（テスト実行・API 裏取り・エンドポイント疎通）
6. `status`（質問なし）には返信不要。オーナーへの経過共有だけ行う

## 5. 終了

- resolve 条件: 未回答 question ゼロ + 実装者の着手/完了表明 + 文書と実装の同期
- 双方が resolve を宣言する行を書く。**resolve は「設計と実装の合意が取れた」であって、セッションの終了ではない**
- **resolve 後も監視を続ける。** 後段にコードレビューの指摘、コミット / PR の指示、PR コメント、CI 失敗とその修正が控えている。実装者が自分の判断で監視を止めることを禁じる（離脱の許可を出せるのはオーナーだけ）
- 設計者は resolve 時のメッセージに「監視は継続する」ことと「離脱はオーナーの指示を待つ」ことを明記する
- 再開はいつでも新規スレッド（`reply_to: null`）で
