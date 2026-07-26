# 課題トラッカー 実装引き継ぎ文書

- **作業名**: `issue-tracker`
- **日付**: 2026-07-26
- **読む順番**: この文書 → CONTEXT → ADR 0011（この作業の決定）→ ADR 0004 / 0006 / 0007 / 0010
- **会話の場**: サービス上の `agent-orchestrator / issue-tracker` ルーム

---

## 1. この作業は何か

**各プロジェクトに課題トラッカーを追加する。**

オーナーの言葉:

> 各プロジェクトに designer 用の issue tracker を作れるようにしよう。
> 他のプロジェクトの agent が投稿することもできれば、implementer が scope 外の
> 残課題として投稿することもできる。designer も投稿できるし、もちろん owner も投稿可能。

解決する問題: **実装者が「これは今回のスコープ外だが、いつか誰かが見るべき」と
気づいたときの行き先が無かった。** `question` は設計者にボールを渡してしまい、
`status` は流れて消える。どちらも backlog にならない。

### 作らないもの（スコープ外）

- **優先度・ラベル・担当者・マイルストーン**
- **検索・全文検索・絞り込み**（状態での絞り込みだけ持つ）
- **添付ファイル**
- **通知**（メール・Slack・push。課題は自分で見に行くもの）
- **課題どうしの関連付け**（親子・重複・ブロック）
- **権限**（誰でも起票・コメント・クローズできる。ADR 0011 の却下案を参照）
- **既存のボール・離脱・手空き機構への統合**（§3 の不変条件）

---

## 2. データモデル

`schema_version` を上げ、後方互換の migration を書くこと。

```sql
CREATE TABLE issue (
  id               INTEGER PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES project(id),
  number           INTEGER NOT NULL,              -- プロジェクト内で 1 から単調増加。サーバ採番
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('open','closed')),
  origin_project   TEXT NOT NULL,                 -- 投稿者の出身プロジェクト slug
  origin_identifier TEXT NOT NULL,                -- 投稿者の識別子
  origin_role      TEXT NOT NULL,
  origin_work      TEXT,                          -- 任意。どの作業から出た課題か
  created_at       TEXT NOT NULL,                 -- UTC ISO8601。サーバが打つ
  closed_at        TEXT,
  closed_by        TEXT,                          -- "<project>/<identifier>"
  close_reason     TEXT,
  UNIQUE (project_id, number)
);

CREATE TABLE issue_comment (
  id               INTEGER PRIMARY KEY,
  issue_id         INTEGER NOT NULL REFERENCES issue(id),
  seq              INTEGER NOT NULL,              -- 課題内で 1 から連番。サーバ採番
  body             TEXT NOT NULL,
  origin_project   TEXT NOT NULL,
  origin_identifier TEXT NOT NULL,
  origin_role      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (issue_id, seq)
);
```

**課題の削除は作らない。** クローズで足りる。誤って起票したものも記録として残す
（`CONTEXT.md` の「追記のみ」と同じ思想）。プロジェクトを削除したときは
カスケードで消える（基準41 の対象に含める）。

---

## 3. 壊してはいけない不変条件

1. **課題はボールを作らない。** `poll` の `your_ball` に現れない。
   `abandoned` にも `idle_nudge` にも影響しない（[ADR 0011](../adr/0011-issue-tracker-outside-the-ball-mechanism.md)）
2. **番号とコメントの `seq` はサーバが採番する。** クライアントに計算させない
3. **時刻はサーバが UTC で打つ。** クライアントの時刻を受け取らない
4. **出身プロジェクトは投稿者自身の設定から導出し、投稿先は明示させる。**
   出身を呼び出し側に自由に指定させてはならない
5. **クローズした者と理由を必ず記録する。** 理由なしのクローズを許さない
6. **既存の受け入れ基準に回帰を出さない。** `npm test` が通り続ける

---

## 4. API

```
POST   /projects/:project/issues                     起票
GET    /projects/:project/issues?state=open|closed|all
GET    /projects/:project/issues/:number
POST   /projects/:project/issues/:number/comments    コメント
POST   /projects/:project/issues/:number/close        {reason}
POST   /projects/:project/issues/:number/reopen
GET    /issues?state=open                            全プロジェクト横断
```

- `:project` は**投稿先**。出身は本文の `origin_*` で受けるが、
  **CLI が自身の設定から埋める**のであって、人が指定するものではない
- `close` は `reason` 必須。無ければ 400
- 横断一覧はオーナーが使う。プロジェクトごとに束ねて返す

---

## 5. CLI

コマンド名とフラグ名は実装者が決めてよい。満たすこと:

- **起票・一覧・詳細・コメント・クローズ・再オープンができる**
- **投稿先プロジェクトを明示できる**（自分の所属と違うプロジェクトへ投稿する）
- **出身は自分の設定から自動で埋まる。** 手で指定させない
- **既定の一覧は open のみ。** closed を見るには明示が要る
- 適用外オプションは非ゼロで失敗する（基準61）

---

## 6. web（オーナーの endpoint）

**必須**:

1. **プロジェクト横断の未対応課題一覧。** どのプロジェクトの何番か、題名、出身が分かる
2. プロジェクトごとの課題一覧（open / closed の切り替え）
3. 課題の詳細（本文・コメント・出身・状態・クローズ理由）
4. **オーナーによる起票・コメント・クローズ**（[ADR 0011](../adr/0011-issue-tracker-outside-the-ball-mechanism.md) で
   ADR 0007 の範囲を広げた。文書編集は依然として持たせない）
5. サイドバーから到達できること（プロジェクト配下に「課題」を置く。
   作業のツリーとは別のリンクでよい）

**必須ではない**: 検索、絞り込み（状態以外）、リアルタイム更新。

**UI の文言は日本語**（既存の web と同じ規約）。`state` の値（`open` / `closed`）は
データの値なので翻訳しない。

---

## 7. スキルへの追記

`session-chat`（実装者）に、簡潔に足すこと。長い説明を書かず、手順として書く。

- **スコープ外だと判断したものは課題として起票する。** `question` にしない
- **`question` と課題の使い分け**: すぐ応答が必要なら `question`、
  いつか誰かが見るべきなら課題
- **課題には通知が来ない。** 自分で見に行く

`design-handoff`（設計者）に足すこと。

- 起動時と定期確認のたびに、**担当プロジェクトの未対応課題を見る**
- 課題はボールを作らないので、**見に行かなければ気づかない**

---

## 8. 受け入れ基準

1. 課題を起票でき、番号がプロジェクト内で 1 から単調増加する
2. **サーバが番号を採番する。** 同時に複数起票しても重複も欠番も出ない
3. 出身プロジェクト・識別子・ロールが記録される
4. **自分と違うプロジェクトへ起票できる。** 出身は自分の設定から埋まり、手で指定できない
5. コメントできる。`seq` がサーバ採番で重複しない
6. **`reason` なしのクローズが 400 で拒否される**
7. クローズした者と理由が記録され、再オープンできる
8. 一覧の既定が open のみ。`closed` / `all` を明示すると出る
9. **プロジェクト横断の未対応課題一覧が API と web の両方で取れる**
10. **未対応の課題が `poll` の `your_ball` に現れない。**
    課題を放置したまま5分経っても `idle_nudge` が変わらず、
    3分経っても `abandoned` に現れない（実測すること）
11. プロジェクトを削除すると課題とコメントもカスケードで消え、孤児が残らない
12. web で日本語 UI、`state` の値は翻訳されない
13. web からオーナーが起票・コメント・クローズできる
14. **既存の受け入れ基準に回帰が無い。** `npm test` が全件通る
15. スキルに §7 の追記があり、`question` と課題の使い分けが書かれている

**10 が最重要である。** ここを間違えると、backlog が溜まるほど設計者が
離脱扱いになり、離脱検知そのものが無意味になる。テストのモック時刻ではなく、
実プロセスで実時間を待って確認すること。

---

## 9. リポジトリ

- ベースは `origin/main`
- worktree は `worktree/issue-tracker`、ブランチは `work/issue-tracker`
- **`work/orchestrator-mvp` 系のブランチには触らない。** 別の実装者が作業中である
- 同じリポジトリを共有しないこと。自分の worktree で作業する（`session-chat` §3）
- コミットと push は自由。**PR の作成はオーナーの指示を待つ**
