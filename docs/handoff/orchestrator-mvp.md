# AgentOrchestrator MVP 実装引き継ぎ文書

- **作業名**: `orchestrator-mvp`
- **日付**: 2026-07-26
- **読む順番**: この文書 → `CONTEXT.md`（用語集。本文書の用語はすべてここに従う）→ `docs/adr/`（決定の理由）
- **問い合わせ先**: 設計者へは `docs/session/orchestrator-mvp.jsonl` 経由。オーナーへは設計者が取り次ぐ

---

## 1. プロダクト概要

design-handoff ワークフロー（オーナー・設計者エージェント・実装者エージェントが、
CONTEXT / ADR / HANDOFF と非同期チャットを介して設計と実装を回す進め方）を、
**ファイル運用からサービスに移す**。

目的は**スケーラビリティ**である。1人のオーナーが同時に回せる設計–実装ラリーの本数を増やす。
バグ修正ではない。現行のファイル運用は動いているが、
「設計者と実装者が同じファイルシステムを共有する」前提と、
「規律で事故を防ぐ」構造が、本数を増やすと破綻する。

サーバは SQLite を持ち、**設計文書とスレッドの正本**を保持する。
設計者・実装者は CLI で、オーナーは web で接続する。
サーバは ssh ホスト上の docker で動き、クライアントは ssh local port forward 経由で到達する。

### ⚠️ 名前に反すること

ローカルの作業ディレクトリ名は `AgentOrchestrator` だが、
**サーバはエージェントをオーケストレーションしない。**
サーバは受動であり、エージェントプロセスの起動は一切行わない（[ADR 0002](../adr/0002-passive-server-per-thread-designers.md)）。
誰がいつエージェントを立ち上げるかはオーナーが決める。

### MVP スコープ外（作らないもの）

- **認証・ユーザ管理・マルチテナント**（[ADR 0004](../adr/0004-no-authentication.md)）。
  **ホストのループバックからしか到達できないこと**が唯一の防御（境界の置き場所は §2 の表）
- **サーバからのエージェント起動**（[ADR 0002](../adr/0002-passive-server-per-thread-designers.md)）
- **MCP サーバ**（[ADR 0003](../adr/0003-cli-only-client-and-polling.md)）。HTTP API の上に後から足せる
- **SSE / WebSocket / ロングポーリング**。新着検知は10秒ポーリングのみ
- **web からの文書編集**（[ADR 0007](../adr/0007-web-viewer-is-the-owner-endpoint.md)）。web で書けるのはスレッドへの発言だけ
- **サーバ側の差分適用・3-way マージ**（[ADR 0005](../adr/0005-full-text-put-with-optimistic-lock.md)）。文書更新は全文 PUT のみ
- **コードの管理**。コードの正本は GitHub にあり、サービスは一切関与しない
- **リアルタイム通知・メール・Slack 連携**
- **文書のリッチエディタ・プレビュー・全文検索**
- **Claude Code の transcript 取り込み**。インポート対象は既存のファイルベース文書のみ
- **CI 連携・PR 自動化**

---

## 2. アーキテクチャ

```
                    ssh ホスト（オーナー専用）
   ┌─────────────────────────────────────────────────┐
   │  docker container                               │
   │  ┌───────────────────────────────────────────┐  │
   │  │  ao-server (HTTP)                         │  │
   │  │    /api/v1/...   ← 設計者・実装者         │  │
   │  │    /            ← web ビューア（オーナー）│  │
   │  │  ┌─────────────────────────────────────┐  │  │
   │  │  │ SQLite: 文書の正本 / スレッド / 参加者│  │  │
   │  │  └─────────────────────────────────────┘  │  │
   │  └───────────────────────────────────────────┘  │
   │  内部 bind: 0.0.0.0:PORT（docker publish のため必須）│
   │  publish:  -p 127.0.0.1:PORT:PORT（host_ip 省略禁止）│
   └─────────────────────────────────────────────────┘
                          ▲
                          │ ssh local port forward
          ┌───────────────┴──────────────┐
          │                              │
   ローカルマシン                   ssh 先の開発環境
   ┌──────────────┐                ┌──────────────┐
   │ ao CLI       │                │ ao CLI       │
   │ 設計者エージェント│              │ 実装者エージェント│
   │ .ao/docs/ (写し)│              │ .ao/docs/ (写し)│
   └──────────────┘                └──────────────┘
          │                              │
          └──────── GitHub （コードの正本）────┘
```

### コンポーネント対応表

| コンポーネント | 役割 | 利用者 |
|---|---|---|
| `ao-server` | HTTP API + web ビューア + SQLite | — |
| `ao` CLI | 文書の pull/push、スレッドへの post、`watch` によるポーリング、注入、インポート | 設計者・実装者エージェント |
| web ビューア | 文書の現在状態とリビジョン履歴、会話履歴、横断の未回答 question 受信箱、発言 | オーナー（人間） |

### endpoint と参加者の対応

| 参加者 | endpoint | 心拍 | 離脱判定 |
|---|---|---|---|
| 設計者 | CLI | あり（`watch` のポーリング） | 対象 |
| 実装者 | CLI | あり（`watch` のポーリング） | 対象 |
| オーナー | web | **なし** | **対象外**（人間はポーリングしない） |

### 認証・認可

**無い。** 全エンドポイントが無認証で、参加者の識別子は自己申告である
（[ADR 0004](../adr/0004-no-authentication.md)）。

守るのは **「ホストのループバックからしか到達できないこと」の1点のみ**。
守る場所は配布形態ごとに違う。

| 配布形態 | プロセスの bind | 露出の境界 |
|---|---|---|
| **docker**（ssh ホストへの本番デプロイ） | コンテナ内 **`0.0.0.0`**（必須） | ホスト側 publish を **`127.0.0.1:PORT:PORT`** に限定 |
| **直接起動**（ローカル開発） | **`127.0.0.1`**（既定） | bind そのもの |

> **訂正（2026-07-26、実装者の実測による）**: 本節は当初
> 「サーバは 127.0.0.1 にのみバインドする。`0.0.0.0` を許す経路を実装に一切含めない」と
> 規定していた。**これは docker 配布と論理的に両立しない設計者の誤りである。**
> コンテナ内部で `127.0.0.1` に待ち受けると docker の publish が到達できず、
> サービスが疎通しない（実測: `curl` が exit 52 / `Empty reply from server`）。
> コンテナのネットワーク名前空間は隔離されているため、**内部の `0.0.0.0` は露出ではない。**

実装が守ること:

- bind アドレスは設定可能にしてよいが、**直接起動時の既定値は `127.0.0.1`**。
  引数も環境変数も無いときに `0.0.0.0` で待ち受けてはならない
- docker イメージの既定コマンドだけが `0.0.0.0` を指定する
- **`-p PORT:PORT`（host_ip 省略）を、文書・起動スクリプト・compose のどこにも書かない。**
  docker は host_ip を省略すると既定で `0.0.0.0` に公開する
- 起動時に `listening on <addr>:<port>` を必ずログへ出す。
  `0.0.0.0` にバインドする場合は、その行に警告を添える

---

## 3. API 仕様

すべて `/api/v1` 配下。リクエスト・レスポンスとも JSON。時刻は**サーバが UTC ISO8601 で記録する**
（クライアントの時刻は受け取らない。複数マシンの時計ズレでスレッドの順序が壊れるため）。

### プロジェクトと作業

| メソッド | パス | 備考 |
|---|---|---|
| `GET` | `/health` | サーバとスキーマのバージョンを返す |
| `GET` | `/projects` | 一覧 |
| `POST` | `/projects` | `{slug, name}`。slug 重複は 409 |
| `GET` | `/projects/:project` | 概要 + 作業一覧 + 文書一覧 |
| `POST` | `/projects/:project/works` | `{slug, title}` |
| `POST` | `/projects/:project/works/:work/resolve` | 作業を `resolved` にする。**スレッドは閉じない**（§5.5） |

### 文書

| メソッド | パス | 備考 |
|---|---|---|
| `GET` | `/projects/:project/documents` | 一覧（本文なし。kind / slug / title / current_revision） |
| `GET` | `/projects/:project/documents/:doc` | `{body, revision, title, updated_at, author}` |
| `GET` | `/projects/:project/documents/:doc/revisions` | リビジョン一覧（本文なし） |
| `GET` | `/projects/:project/documents/:doc/revisions/:n` | 指定リビジョンの全文 |
| `POST` | `/projects/:project/documents` | 新規作成。`{kind, slug?, title, body, author}` |
| `PUT` | `/projects/:project/documents/:doc` | 更新。`{body, base_revision, author, note?}` |

`:doc` は `context` / `adr/0003-...` / `handoff/orchestrator-mvp` の形。

**`PUT` の応答規約**:

- `base_revision` がサーバの現在リビジョンと**厳密に一致**すれば 200。新しいリビジョン番号を返す
- 一致しなければ **409**。ボディに `{current_revision, current_body}` を含める
  （クライアントが即座に編集を当て直せるようにするため。往復を1回減らす）
- 差分適用も自動マージも**行わない**（[ADR 0005](../adr/0005-full-text-put-with-optimistic-lock.md)）

**ADR 作成時の採番**: `kind=adr` で `POST` した場合、`slug` は指定させず**サーバが採番**する。
プロジェクト内で単調増加する番号を採り、`NNNN-<title を kebab-case 化>` を slug とする。
設計者が複数いるため、クライアント側で番号を決めさせてはならない。

**CONTEXT の一意性**: `kind=context` の文書はプロジェクトに高々1つ。2つ目の作成は 409。

### スレッド

| メソッド | パス | 備考 |
|---|---|---|
| `GET` | `/projects/:project/works/:work/messages?since=<seq>` | `since` より後のメッセージ |
| `POST` | `/projects/:project/works/:work/messages` | 投稿。下記参照 |
| `POST` | `/projects/:project/works/:work/messages/:seq/close` | question を明示クローズ。**投稿者本人のみ** |
| `GET` | `/projects/:project/works/:work/poll?since=<seq>&as=<identifier>[&role=<role>]` | **心拍を兼ねる**。§3.1 |
| `GET` | `/inbox?as=<identifier>` | 全プロジェクト横断の、自分宛の未回答 question |

> **訂正（2026-07-26、実装者の指摘による）**: これらのパスは当初 `/works/:work/...` と
> プロジェクトを含まない形で書いていた。**これは設計者の誤りである。**
> `work` の一意制約は `(project_id, slug)` であり、別プロジェクトに同名の作業を作れる。
> プロジェクトを含まないパスでは同名の作業を識別できず、参照先が不定になる。
>
> 却下した代案:
> - **`work.slug` をサービス全体で一意にする** — スキーマは単純になるが、
>   「プロジェクトの下に作業がぶら下がる」という `CONTEXT.md` の定義と矛盾する。
>   別プロジェクトで同じ作業名（`orchestrator-mvp` など）を使えないのは不自然
> - **`:work` を内部 ID にする** — 一意にはなるが、人もエージェントも打てず、
>   ログやチャットの `refs` に書いても読めない

**参加者識別子のスコープ**: `participant` 行は作業ごとに作られる（`UNIQUE (work_id, identifier)`）。
これは心拍と初出をスレッド単位で追うためであり、**識別子の文字列そのものはサービス全体で
同一人物を指す規約とする**。`/inbox?as=designer-a` は、全プロジェクト・全作業を横断して
`designer-a` 宛の未回答 question を集める。同じ文字列を別人に使い回してはならない。

**`POST /projects/:project/works/:work/messages` のリクエスト**:

```json
{
  "idempotency_key": "<クライアント生成の UUID>",
  "from": "designer-a",
  "role": "designer",
  "type": "message|question|answer|decision|status|resolve",
  "body": "本文。改行を含んでよい",
  "to": ["impl-a", "impl-b"],
  "reply_to": 12,
  "refs": ["src/server/db.ts", "https://github.com/.../pull/3"],
  "expects": [{"doc": "context", "revision": 7}],
  "ball": ["impl-a"]
}
```

- **`seq` はサーバが採番する。** 作業内で 1 から連番。クライアントは ID を計算しない
  （現行運用で最大の事故源だった「末尾行 +1」の衝突を原理的に消す）
- **`idempotency_key`**: 同一作業内で同じキーの投稿は、新規作成せず**既存メッセージをそのまま返す**。
  応答が失われて CLI が再送したときの二重投稿を防ぐ
- **`type=question` は `to` が空であってはならない**（400）。誰のボールにもならない質問を作らないため
- **`type=answer` は `reply_to` 必須**（400）
- `expects` は期待バージョン。受け手が自分の認識とのズレに気づくためのもので、**書き込みを拒否しない**
- `ball` は宣言ボール（§5.3）
- **参加者は事前登録しない。** 未知の `from` は、その `role` で参加者として自動登録される

### 3.1 `poll` — 新着取得・心拍・状態通知を兼ねる

エージェントが10秒ごとに叩く唯一のエンドポイント。**このリクエストが心拍を兼ねる**
（[ADR 0006](../adr/0006-ball-tracking-and-heartbeat.md)）。呼び出しごとに `as` で指定された
参加者の `last_heartbeat_at` を更新する。

**`role` の扱い**（当初 §3 に記載が無く、実装との食い違いを実測で発見したため追記）:

- `as` の参加者が**まだ存在しない**場合、`role` は**必須**（400）。参加者はここで自動登録される
- `as` の参加者が**既に存在する**場合、`role` は**省略可**。省略時は登録済みのロールを使う
- `role` を渡し、それが登録済みのロールと**異なる**場合は 409。
  エラー本文には**要求されたロールと登録済みのロールの両方**を含めること
  （「designer is already registered as designer」のように、
  何を要求したのか分からない文言にしない）

省略可にする理由は、既存参加者にとって `role` は冗長であり、
毎回のポーリングで送らせると「送り忘れ・取り違え」が起きるため。
CLI は `.ao/config.json` から常に送ってよいが、API 側で必須にはしない。

応答:

```json
{
  "messages": [ ... since より後の新着 ... ],
  "your_ball": {
    "has_ball": true,
    "reasons": [
      {"kind": "unanswered_question", "seq": 12, "from": "designer-a"},
      {"kind": "declared", "seq": 15, "by": "designer-a"}
    ]
  },
  "idle_nudge": null,
  "abandoned": [
    {"identifier": "impl-b", "last_heartbeat_at": "...", "ball_reasons": [...]}
  ],
  "stale_expectations": [
    {"doc": "context", "you_have": 7, "current": 9}
  ]
}
```

- `your_ball` — 導出ボールと宣言ボールを合わせた、**この参加者の**ボール状態
- `idle_nudge` — 手空きが5分続いたときに文言を入れる。それ以外は `null`（§5.4）
- `abandoned` — **他の**参加者のうち離脱状態のもの（§5.4）。設計者がオーナーへ上げる材料
- `stale_expectations` — この参加者が直近のメッセージで宣言した期待バージョンが、
  現在のリビジョンより古い場合に入れる。pull を促す

### インポート

| メソッド | パス | 備考 |
|---|---|---|
| `POST` | `/import` | ファイルベース文書の取り込み。§6 |

---

## 4. データモデル

SQLite。DB ファイルは1つ（プロジェクトごとに分けない）。

```sql
PRAGMA journal_mode  = WAL;      -- web と CLI が同時に読むため
PRAGMA foreign_keys  = ON;
PRAGMA busy_timeout  = 5000;     -- ★ 必須。理由は下記

CREATE TABLE project (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL                    -- UTC ISO8601
);

CREATE TABLE work (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES project(id),
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('open','resolved')),
  created_at  TEXT NOT NULL,
  UNIQUE (project_id, slug)
);
-- スレッドは作業に1つなので独立したテーブルを持たない。message.work_id がスレッドを表す。

CREATE TABLE document (
  id               INTEGER PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES project(id),
  kind             TEXT NOT NULL CHECK (kind IN ('context','adr','handoff')),
  slug             TEXT NOT NULL,
  work_id          INTEGER REFERENCES work(id),   -- handoff のみ非 NULL
  adr_number       INTEGER,                       -- adr のみ非 NULL
  title            TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (project_id, kind, slug)
);
CREATE UNIQUE INDEX idx_single_context ON document(project_id) WHERE kind = 'context';
CREATE UNIQUE INDEX idx_adr_number     ON document(project_id, adr_number) WHERE kind = 'adr';

-- リビジョンは全文スナップショット（差分ではない）。文書は小さく、任意リビジョンの閲覧が単純になる。
CREATE TABLE revision (
  id          INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES document(id),
  revision    INTEGER NOT NULL,                  -- 文書ごとに 1 から単調増加
  body        TEXT NOT NULL,
  author      TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (document_id, revision)
);

-- 行は作業ごとだが、identifier の文字列はサービス全体で同一人物を指す規約。
-- /inbox はこの文字列で全プロジェクトを横断して引く（§3 の「参加者識別子のスコープ」）。
CREATE TABLE participant (
  id                INTEGER PRIMARY KEY,
  work_id           INTEGER NOT NULL REFERENCES work(id),
  identifier        TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('owner','designer','implementer')),
  first_seen_at     TEXT NOT NULL,
  last_heartbeat_at TEXT,                        -- owner は常に NULL
  UNIQUE (work_id, identifier)
);

CREATE TABLE message (
  id              INTEGER PRIMARY KEY,
  work_id         INTEGER NOT NULL REFERENCES work(id),
  seq             INTEGER NOT NULL,              -- 作業内で 1 から連番。サーバ採番
  idempotency_key TEXT NOT NULL,
  from_identifier TEXT NOT NULL,
  type            TEXT NOT NULL
                  CHECK (type IN ('message','question','answer','decision','status','resolve')),
  body            TEXT NOT NULL,
  reply_to_seq    INTEGER,
  closed_at       TEXT,                          -- question の明示クローズ
  created_at      TEXT NOT NULL,
  UNIQUE (work_id, seq),
  UNIQUE (work_id, idempotency_key)
);

CREATE TABLE message_to (
  message_id INTEGER NOT NULL REFERENCES message(id),
  identifier TEXT NOT NULL,
  PRIMARY KEY (message_id, identifier)
);

CREATE TABLE message_ref (
  message_id INTEGER NOT NULL REFERENCES message(id),
  ref        TEXT NOT NULL
);

-- 期待バージョン。書き込みを拒否しないので制約は張らない。
CREATE TABLE message_expects (
  message_id  INTEGER NOT NULL REFERENCES message(id),
  document_id INTEGER NOT NULL REFERENCES document(id),
  revision    INTEGER NOT NULL,
  PRIMARY KEY (message_id, document_id)
);

-- 宣言ボール。「最後に宣言を伴ったメッセージ」の集合が現在の宣言ボール集合になる。
CREATE TABLE ball_declaration (
  message_id INTEGER NOT NULL REFERENCES message(id),
  identifier TEXT NOT NULL,
  PRIMARY KEY (message_id, identifier)
);
```

### `busy_timeout` は必須（実測。§7.4 クローズ済み）

**WAL だけでは足りない。すべての DB 接続に `busy_timeout=5000` を設定すること。**
接続を作る箇所が複数あるなら、接続生成を1関数に閉じて全経路が通るようにする。

実装者の実測（Node v22.14.0 / `node:sqlite`、watch 相当8本 + web 読み取り1本 + 書き込み1本を並行）:

| 設定 | 結果 |
|---|---|
| `busy_timeout=0` | 8,490 試行中 **3,338 件が `database is locked`**（成功 5,152） |
| `busy_timeout=5000` | **11,400 操作すべて成功**（busy 0 / その他エラー 0） |

WAL は読み書きの同時実行を許すが `SQLITE_BUSY` を消しはしない。
10秒ポーリングが N 本走る本サービスでは、設定しなければ確実に落ちる。

### 保存先の分担

| データ | 正本 | 備考 |
|---|---|---|
| CONTEXT / ADR / HANDOFF | **この DB** | [ADR 0001](../adr/0001-documents-source-of-truth-in-db.md) |
| スレッドのメッセージ | **この DB** | |
| **コード** | **GitHub** | サービスは関与しない |
| 写し（`.ao/docs/`） | — | 正本ではない。読む場・編集の下書き場 |

---

## 5. コアロジック仕様

### 5.1 文書の pull / push

```
pull:
  1. GET /documents/:doc → {body, revision}
  2. 写しの先頭にヘッダを付けて .ao/docs/ 配下へ書き出す
  3. .ao/state.json に {doc: revision} を記録する

push:
  1. .ao/docs/ の写しを読み、ヘッダを取り除く
  2. .ao/state.json の revision を base_revision として PUT
  3. 200 → state.json の revision を更新
  4. 409 → 応答の current_body で写しを更新し、非ゼロ終了。
          「pull し直したので、同じ編集を当て直して再度 push せよ」と出力する
```

**写しのヘッダ**（各ファイル先頭）:

```
<!-- AgentOrchestrator: これは写しです。正本はサーバ側 DB にあります。
     revision=7 / doc=context / pulled=2026-07-26T04:00:00Z
     編集しても `ao push` するまで正本に反映されません。`ao pull` で失われます。 -->
```

`pull` はローカルの未 push 編集を破棄しうる。**写しの内容が state.json 記録時から変わっていたら、
`--force` が無い限り中断する。**

### 5.2 ボールの導出

参加者 P が作業 W でボールを持つのは、次のいずれかが成り立つとき。

**導出ボール（サーバが判定。宣言では消せない）**

> `type=question`、`closed_at IS NULL` のメッセージ M があり、
> P が M の宛先に含まれ、かつ P が「`type=answer` かつ `reply_to_seq = M.seq`」のメッセージを
> まだ書いていない。

**宛先ごとに独立して判定すること。** 宛先が `["impl-a","impl-b"]` の question に `impl-a` が
答えても、`impl-b` のボールは残る。「誰かが答えた」を全員の免責にしてはならない。
残りを免責したい場合は、質問者が明示的に `close` する。

**宣言ボール**

> 作業 W の中で、`ball_declaration` を伴う**最新の**メッセージの宣言集合に P が含まれる。

宣言は上書き式である（過去の宣言は現在の状態に影響しない）。
現在のボール集合 = 導出ボール ∪ 宣言ボール。

### 5.3 心拍と離脱

- `GET /projects/:project/works/:work/poll?as=P` を受けるたびに、P の `last_heartbeat_at` を現在時刻で更新する
- **離脱**: P がボールを持ち、かつ `last_heartbeat_at` が **3分**より古い（ポーリング間隔10秒に対し
  18回分の欠落。瞬断では誤検知しない）。`role='owner'` は判定対象外（人間はポーリングしない）
- 離脱は他の参加者の `poll` 応答の `abandoned` に載る。サーバから外へ通知はしない（受動サーバ）

### 5.4 手空き通知

- **手空き**: P がボールを持たず、かつ作業 W の最新メッセージが **5分**より古い
- 手空きが検出されたら、P の `poll` 応答の `idle_nudge` に文言を入れる
- **スレッドには書き込まない。** その参加者にだけ届く
- P が何か書けば「最新メッセージが5分より古い」が偽になるので、通知は連続で暴発しない
- 設計者にも実装者にも同じ条件で出す（どちらの側でも同じ思い込みが起きる）

### 5.5 resolve

- `POST /projects/:project/works/:work/resolve` で `state='resolved'` にする
- **スレッドは閉じない。メッセージの投稿は resolve 後も受け付ける**
- **resolve 済みの作業でも、離脱判定と手空き通知は動き続ける。**
  resolve を根拠に離脱したエージェントは、そのまま `abandoned` に載る
- 状態は `open` / `resolved` の2つだけ。`closed` を持たない
  （「resolve は終了ではない」という規定と衝突するため）

### 5.6 期待バージョンの照合

メッセージの `expects` は保存するだけで、投稿時には何も検査しない。
検査は `poll` 応答の `stale_expectations` で行う: 参加者が直近に宣言した期待バージョンが
現在のリビジョンより古ければ、そこに載せて pull を促す。

**期待バージョンは拒否を起こさない。拒否を起こすのは文書 PUT の `base_revision` だけ。**
この2つを混同しないこと（`CONTEXT.md` の「期待バージョン」「基底リビジョン」の項を参照）。

---

## 6. 注入とインポート

### 6.1 `ao inject <path/to/target/repo>`

対象リポジトリをサービス管理下に置く（[ADR 0008](../adr/0008-injection-into-target-repositories.md)）。

1. サーバにプロジェクトを登録（既にあれば再利用）
2. `<repo>/.ao/config.json` を書く — サーバ URL、プロジェクト slug、参加者識別子、ロール
3. **サービス版の手順を4箇所すべてへ配置**（[ADR 0008](../adr/0008-injection-into-target-repositories.md)）。
   参加者のランタイムは Claude Code とは限らないため（本 MVP の実装者は Codex Desktop 上にいる）:

   | 配置先 | 形 | 注意 |
   |---|---|---|
   | `<repo>/.claude/skills/<name>/` | 手順一式 | 既存を黙って上書きしない |
   | `<repo>/.agents/skills/<name>/` | 同じ内容 | 同上 |
   | `<repo>/CLAUDE.md` | **追記のみ** | 全置換しない。マーカーで挟み、再注入で重複させない |
   | `<repo>/AGENTS.md` | **追記のみ** | 同上 |

   **同じ内容を複数箇所へ配るので、必ず単一のソースから生成すること。**
   手で複製すると片方だけ更新されて必ず食い違う
4. `<repo>/.gitignore` に `/.ao/` を追記（既にあれば何もしない）
5. 文書の写しを `<repo>/.ao/docs/` へ pull
6. 対象リポジトリに既存のファイルベース文書があればインポート候補として提示する（実行はしない）

**注入は追記のみで、既存の内容を破壊しない。** これはオーナーが前提としている保証であり、
実装が満たしていることを実測で確認済み（既存 `CLAUDE.md` の内容とオーナー自作の
`.claude/skills/my-own-skill/` が2回注入後も無傷）。

- `CLAUDE.md` / `AGENTS.md` — マーカーで挟んだブロックを**追記**。全置換しない
- `.gitignore` — `/.ao/` の行を**追記**（既にあれば何もしない）
- スキルファイル — 既存を黙って上書きしない。差分を示して確認を取るか `.bak` へ退避する。
  オーナーが手で育てたスキルを消してはならない

この保証があるため、**移植元のリポジトリに注入しても安全**である
（アーカイブ済みのリポジトリから履歴を移す場合も、既存の内容は失われない）。

### 6.2 サービス版の手順に書き換える内容

配置先は §6.1 の4箇所。**内容は単一のソースから生成する。**

現行スキル（`design-handoff` / `session-chat` / `grill-with-docs`）から、
**廃止される前提を残らず除去**し、`ao` の手順に差し替える。除去対象:

| 現行の記述 | 差し替え後 |
|---|---|
| `jq -nc` で1行 JSON を組み立てる | `ao post --type ... --body ...` |
| `msg-%04d` を末尾行 +1 で採番 | サーバ採番。クライアントは ID を計算しない |
| ID 衝突時は `msg-0024/designer` と書いて区別（SESSION-PROTOCOL §2.5） | **節ごと削除**（衝突は起きない） |
| `wc -l` の行数ポーリング / `tail -F` 禁止 | `ao watch`（10秒ポーリング） |
| `docs/session/<作業名>.jsonl` を読む | `ao messages` / `ao watch` |
| CONTEXT / ADR / handoff をファイルとして編集 | `ao pull` → 写しを編集 → `ao push`。409 の手順を明記 |
| 「ポーリングのたびにボール所在を自問せよ」 | `poll` 応答の `your_ball` を読む（自問は補助に降格） |
| 「実装者の沈黙を待ちと解釈しない」ための差分監視手順 | `abandoned` と `idle_nudge` を読む |

**残すもの**（サービス化で不要にならない規律）:

- 文書の役割分担（CONTEXT は用語集、ADR はなぜ、HANDOFF は何を・どう）
- 文書先行（決定はチャットで終わらせず、先に文書を更新してから返す）
- 判断の三分類（設計者が決める / オーナーに聞く / 実装者に委ねる）
- マイルストーン報告の独立検証、「テスト通過を完了の証拠にしない」「成果物をディスク上に実見する」
- **resolve は終了ではない。離脱の許可を出せるのはオーナーだけ**
- シークレットを書かない

### 6.3 `ao import <path>` — 既存ファイルの取り込み

現行の規約に従ったリポジトリから取り込む。

| 取り込み元 | 取り込み先 |
|---|---|
| `CONTEXT.md` | `kind=context` の文書、revision 1 |
| `docs/adr/NNNN-*.md` | `kind=adr`。**ファイル名の番号をそのまま `adr_number` に使う**（採番し直さない） |
| `docs/handoff/<作業名>.md` | `kind=handoff`。作業を `<作業名>` で作成 |
| `docs/session/<作業名>.jsonl` | 同名の作業のメッセージ |

jsonl の変換規則:

- `id`（`msg-0001`）は**捨てる**。`seq` はファイル内の行順で振り直す
- **元 ID を `message_ref` に `imported-id:msg-0001` として残す。**
  現行運用は同時書き込みで ID が重複することを許容しており（SESSION-PROTOCOL §2.5）、
  `id` を一意キーとして扱うとインポートが落ちる。**行を落としてはならない**
- `reply_to` は元 ID から新 `seq` へ引き直す。**元 ID が重複していて解決できない場合は、
  `reply_to` を NULL にし、`message_ref` に `unresolved-reply-to:msg-0024` を残す**
  （黙って捨てず、後から追える形にする）
- `ts` はそのまま `created_at` に入れる。タイムゾーン付きなら UTC に正規化する
- `from` はそのまま識別子とする。ロールは `from` の文字列から推定し、
  判定できないものは `implementer` にして**インポート結果に一覧で出す**
- 存在しない type は `message` に落とし、同じく一覧で出す

**インポートは冪等でなくてよい**（同じディレクトリを2回入れれば2つ入る）。
ただし**実行前に取り込む件数の内訳を表示し、確認を取ること**。

---

## 7. 要検証事項

グリルで確定できなかった外部事実。**結果を `status` で報告すること。**
設計と食い違う事実が出たら、実装を進める前に `question` を立てること。

> **訂正（2026-07-26、設計者）**: 本節は当初「実装前の要検証事項」とし、4件すべてを
> 着手前のゲートとして書いていた。これは設計者の誤りである。§7.2 と §7.4 は
> **動くコードが無ければ検証できない**ため、字義通りに守ると実装が始まらない。
> 下記の通り、着手前ゲートと「スパイクで確認するもの」に分類し直した。

| | 内容 | いつ確認するか |
|---|---|---|
| §7.1 | ssh 先の Node バージョン | **着手前**（オーナーへの確認。コード不要） |
| §7.2 | Monitor が `ao watch` の出力を拾えるか | **最小スパイクで**（本実装より前、ただしコードは書く） |
| §7.3 | docker の 127.0.0.1 バインドと port forward の疎通 | **着手前**（既製イメージで確認できる。コード不要） |
| §7.4 | WAL での同時アクセス | **本実装の途中**（サーバが動いてから。設計の見直しが要る場合のみ question） |

**スパイクは使い捨てでよい。** §7.2 は「10秒ごとに1行吐くだけのスクリプト」で足りる。
`ao watch` の本実装を待つ必要はない。§7.4 も同様に、スキーマだけ作って
並行読み書きを叩くだけでよく、API 一式を待たなくてよい。

**§7.1 の回答待ちで手を止めないこと。** Node バージョンが効くのはサーバ側の
SQLite ドライバ選定だけであり、CLI・API 設計・スキーマ・web はどれも先に進められる。

### 7.1 実行環境（クローズ: 2026-07-26 実測）

実測結果:

| | ssh 先 (`ssh i-sugita`) | ローカル (Mac) |
|---|---|---|
| Node | **v22.22.0** | **v22.14.0** |
| npm | 10.9.4 | 10.9.2 |
| OS | Ubuntu 24.04.3 LTS | macOS 26.5.2 |
| arch | **x86_64** | **arm64** |
| shell | bash | zsh |
| Docker | 29.1.5 | （未確認） |

`node:sqlite` は ssh 先の v22.22.0 で**フラグ無しで動作する**
（`DatabaseSync, StatementSync, constants, backup` が取得でき、`ExperimentalWarning` が出る）。

> **訂正（設計者）**: 本項は当初「ホストの Node バージョンが SQLite ドライバの選択に効く」と
> 書いていたが、これは誤りである。**サーバは docker の中で動くため、コンテナの Node は
> 実装者がイメージで選べる。ホストの Node は制約にならない。**
> ホストの Node が縛るのは CLI だけであり、CLI は SQLite を触らない。

**この実測から確定する制約:**

1. **CLI は Node 22.14 以上で動くこと**（ローカル Mac が下限。ssh 先は 22.22）。
   22.14 に無い API を使わない
2. **CLI は arm64（Mac）と x86_64（Linux）の両方で動くこと。**
   ネイティブアドオンを含めると2アーキテクチャ分の配布が必要になるので、
   **CLI は純 JS で書くことを強く推奨する**（依存に native binding を持ち込まない）
3. サーバ側の SQLite ドライバは**実装者の判断に委ねる**。
   `node:sqlite`（Experimental 警告が出る／ビルド不要）でも
   `better-sqlite3`（安定／イメージにビルド環境が必要）でもよい。
   選んだ理由を `status` で報告すること
4. docker イメージは **x86_64 向けでよい**（ssh 先が x86_64）。マルチアーキテクチャ対応は不要

- **調整した節**: §8（配布）に上記1・2・4を反映済み

### 7.2 Claude Code の Monitor ツールが `ao watch` の出力を拾えるか

- **確認すること**: **使い捨てのスパイクで足りる。** 10秒ごとに1行を標準出力へ吐くだけの
  スクリプトを background bash で走らせ、その1行が Monitor 経由でエージェントに届くことを
  **実機で**確認する。`ao watch` の本実装を待たない
- **なぜ**: これが動かないと、サービス化の中心的な利点（通知駆動）が成立しない。
  現行の行数ポーリングに戻すことになる
- **結果次第で調整する節**: §3.1 と §6.2。届かない場合は
  `watch` の出力形式（1行 JSON か人間可読か）を変える余地がある。
  **どちらが拾われやすいか実測して報告すること**

### 7.3 docker の 127.0.0.1 バインドと ssh port forward の疎通

**クローズ（2026-07-26、実装者が実測）。** 経路は成立し、**設計が1つ変わった**（§2 の訂正注記）。

実測:

| | 結果 |
|---|---|
| `i-sugita` 上で `nginx:alpine` を `-p 127.0.0.1:28080:80` で起動 | `docker port` が `80/tcp -> 127.0.0.1:28080`。リモート内 `curl` が exit 0 / HTTP 200 |
| ローカルから `ssh -N -L 127.0.0.1:28081:127.0.0.1:28080 i-sugita` | `lsof` が `TCP 127.0.0.1:28081 (LISTEN)`。ローカル `curl` が exit 0 / HTTP 200 |
| **失敗系**: コンテナ内 bind を `127.0.0.1` に変更（host publish は同じ） | `curl` が exit 52 / `Empty reply from server` |

- **接続先**: `ssh i-sugita`（Ubuntu 24.04.3 / x86_64 / Docker 29.1.5）
- **この検証から出た設計変更**: 失敗系が示す通り、**コンテナ内部 bind を `127.0.0.1` に
  固定すると docker publish が届かない。** 露出の境界は bind ではなく host publish 側にある。
  §2 の表と受け入れ基準18を差し替え済み

### 7.4 WAL モードで web と CLI の同時アクセスが問題ないか

- **確認すること**: **本実装の途中でよい。** §4 のスキーマだけ作り、
  読み取りを複数本走らせながら書き込みを叩いて `SQLITE_BUSY` で落ちないことを確認する。
  API 一式や web の完成を待たない
- **なぜ**: 10秒ポーリングが N 本走る。読み取りが多く書き込みが少ない形なので
  WAL で足りる想定だが、実測していない
- **結果次第で調整する節**: §4。落ちるなら書き込みを直列化するか busy_timeout を設定する

---

## 8. 配布と設定

### サーバ

- docker イメージ1つ。SQLite の DB ファイルはボリュームで永続化する
- **x86_64 向けでよい**（デプロイ先 `i-sugita` は Ubuntu 24.04.3 / x86_64 / Docker 29.1.5）。
  マルチアーキテクチャビルドは不要
- コンテナ内の Node バージョンとサーバ側 SQLite ドライバは**実装者が選ぶ**。
  ホストの Node に縛られない（§7.1）
- **コンテナ内の bind は `0.0.0.0`。ホスト側の publish は `127.0.0.1:PORT:PORT` に限定する**
  （§2 の表を参照）。compose を同梱するなら `host_ip: 127.0.0.1` を固定で書く
- 起動手順・`docker run` の実例・ボリュームの場所を README に書く。
  **オーナーが手作業でデプロイするので、コピペで動く形にすること**

### CLI

- **Node 22.14 以上で動くこと**（ローカル Mac が v22.14.0 で下限。ssh 先は v22.22.0）
- **arm64（Mac）と x86_64（Linux）の両方で動くこと。**
  ネイティブアドオンを含めると2アーキテクチャ分の配布が要るため、
  **純 JS で書くこと**（依存に native binding を持ち込まない）を強く推奨する
- **追加のランタイム導入なしに ssh 先へ置けること。** 配布方法（単一ファイル / npm / tarball）は実装者に委ねる
- 接続先は `.ao/config.json`。環境変数で上書きできてよい

### 対象リポジトリに置かれるもの

```
<repo>/
├── .ao/
│   ├── config.json        サーバ URL / プロジェクト / 参加者識別子 / ロール
│   ├── state.json         写しの pull 時リビジョン
│   └── docs/              写し（CONTEXT / ADR / HANDOFF）
├── .claude/skills/        サービス版スキル
└── .gitignore             `/.ao/` を追記
```

---

## 9. UI / 出力要件

### web ビューア（オーナーの endpoint）

**必須**:

1. プロジェクト一覧 → プロジェクト詳細（文書一覧・作業一覧）
2. 文書の現在状態の表示（Markdown レンダリング）と、**リビジョン履歴・任意リビジョンの表示**
   （git 履歴を捨てた代替なので、これが無いと変更の追跡手段が消える）
3. スレッドの会話履歴（type・from・宛先・reply_to の関係が読み取れること）
4. **プロジェクト横断の「オーナー宛の未回答 question」一覧**と、そこからの `answer` 投稿
5. **オーナー起点の入力** — 任意の作業へ `message` / `decision` を投稿できる
6. 各作業の**参加者一覧とその状態**（ボール有無・心拍・離脱）

**必須ではない**: 検索、リビジョン間の差分表示、文書編集、リアルタイム更新（リロードでよい）

#### 表示言語（2026-07-26、オーナー指示で追加）

**web ビューアの UI は日本語にする。** 唯一の利用者であるオーナーが日本語話者であり、
文書もスレッドも日本語で書かれているため、UI だけ英語だと視線が行き来する。

対象は画面上の固定文言すべて — ナビゲーション、見出し、テーブルのヘッダ、ボタン、
状態ラベル（ボール有無・心拍・離脱・手空き）、空状態のメッセージ、日時の書式（JST 表示）。
`type`（`question` / `answer` / `status` など）のような**データの値は翻訳しない**
（`CONTEXT.md` の用語と1対1で対応させる必要があるため）。

**CLI の出力は英語のままでよい。** 主な読み手がエージェントであり、
終了コードとエラー文言を README の表と一致させておくほうが追跡しやすい。
これを変えたい場合はオーナーに確認すること。

### CLI の出力

- `ao watch` は新着・手空き通知・離脱警告を**1行ずつ**出す。行の頭で種別が判別できること
- **エラーを黙って握りつぶさない。** 失敗は標準エラーへ理由を出し、非ゼロ終了する。
  `watch` は再試行を続けるが、連続失敗は出力に出す
  （サーバが落ちたまま静かに待ち続ける状態を作らない）

**終了コード（実装済み・実測でクローズ）**。エージェントが `ao push && ao post` のように
連鎖させるため、これは仕様である。値の意味を変えないこと。

| コード | 意味 | 呼び出し側がすべきこと |
|---|---|---|
| `0` | 成功 | 次へ進む |
| `1` | リクエスト不正（HTTP 400）、サーバ到達不能、その他の非衝突エラー | **止まる。** 設計者へ報告するか、入力を直す |
| `2` | 人の判断が要る: リビジョン衝突（409）、未 push 保護による pull 中断、未確認の import | **読み直して編集を当て直し、再試行する** |

> 実装当初、409 が `exit 0` を返す経路があった（top-level await の実行形態に依存していた）。
> `ao push && ao post` が衝突を素通りして次へ進むため、**静かに壊れる**類の欠陥だった。
> 明示的な `process.exit(code)` で曖昧さごと解消済み。

---

## 10. 受け入れ基準

「動く」系:

1. `ao inject <repo>` の実行後、対象リポジトリに `.ao/config.json`・`.ao/docs/` の写し・
   サービス版スキルが存在し、`.gitignore` に `/.ao/` がある
2. 設計者が `ao push` した文書が、実装者側の `ao pull` で取得できる（別マシンでも）
3. `ao watch` が新着を10秒以内に1行として出力する
4. web でプロジェクトの文書・リビジョン履歴・会話履歴が閲覧できる
5. web からオーナーが投稿したメッセージが、CLI 側の `ao watch` に現れる
6. docker で起動したサーバへ、ssh local port forward 経由で CLI が疎通する

ドメイン固有の正しさ（**ここが本質。「動く」だけでは受け入れない**）:

7. **同一文書へ2つのクライアントが同じ `base_revision` で同時に PUT すると、
   片方が 200、もう片方が必ず 409 になる。両方成功することがない**
8. **メッセージを N 本同時に POST しても `seq` が重複せず、欠番も出ない**
9. **同じ `idempotency_key` で2回 POST しても、メッセージは1件しか作られない**
10. **宛先が2人の question に1人が answer しても、もう1人のボールは消えない。
    質問者が `close` すると両方消える**
11. **導出ボール（未回答 question）は、宣言ボールでは消せない**
12. **ボールを持つ参加者の `poll` が3分途絶えると、他の参加者の `poll` 応答の
    `abandoned` にその参加者が現れる**
13. **`resolve` した後も、離脱判定と手空き通知が動き続ける。
    resolve を根拠に離脱した参加者は `abandoned` に載る**
14. **ボールが無い参加者が5分沈黙すると `idle_nudge` が返る。
    その参加者が何か書くと、次のポーリングでは `idle_nudge` が消える**
15. **`ao pull` は、未 push の写しの編集を `--force` 無しに破棄しない**
16. **写しを編集しただけでは正本のリビジョンが上がらない**
17. **重複した `id` を含む jsonl をインポートしても行が1つも失われず、
    元 ID が `message_ref` に残る。解決できない `reply_to` は NULL になり、
    その旨が `message_ref` に残る**
18. **露出の境界が配布形態ごとに正しい**（当初の「`0.0.0.0` 経路を一切含めない」は
    docker 配布と両立しないため差し替えた。§2 の訂正注記を参照）。内訳:
    - a. **直接起動で引数・環境変数を何も与えないとき、bind は `127.0.0.1`**。`0.0.0.0` にならない
    - b. **docker の起動手順・スクリプト・compose のすべてで host_ip が `127.0.0.1` に固定されている。**
      `-p PORT:PORT`（host_ip 省略）の例がリポジトリ内のどこにも存在しない
    - c. 起動ログに `listening on <addr>:<port>` が出る。`0.0.0.0` のときは警告が添う
    - d. docker で起動したサーバへ、**ホストの外部インタフェース**（`ホストのLAN IP:PORT`）から
      到達**できない**ことを実測で確認する。ループバックからは到達できる
19. **サービス版の手順に、廃止された記述（`jq -nc` での採番、`wc -l` ポーリング、
    `msg-NNNN` の手採番、ID 衝突時の回避手順）が1つも残っていない**
20. **注入が §6.1 の4箇所すべてへ配る。`CLAUDE.md` と `AGENTS.md` は追記のみで
    既存内容を壊さず、同じリポジトリへ2回注入しても記述が重複しない**
21. **`.claude/skills/` と `.agents/skills/` の内容が完全に一致する**
    （単一ソースから生成されていることの確認。片方だけ更新される事故を防ぐ）

---

## 11. リポジトリ現状

- 着手時点で、このリポジトリには `.claude/skills/`（現行スキル4本）、`CONTEXT.md`、
  `docs/adr/0001`〜`0008`、本文書のみが存在する。**実装コードは1行も無い**
- **git / GitHub は準備済み**（2026-07-26、オーナーの指示により設計者が実施）。
  リモートは `github.com:dermasugita/agents-chat-room`、既定ブランチは `main`。
  `main` には README と設計文書のコミットのみが載っている

  > 注記（撤回済みの前提）: 本節は当初「git リポジトリではないので git 操作を行うな」と
  > 規定していた。オーナーから手順が渡されたため撤回し、下記に差し替えた。

- **リポジトリ名は `agents-chat-room`**（ローカルのディレクトリ名 `AgentOrchestrator` とは異なる）。
  §1 の注記の通り、サーバはエージェントをオーケストレーションしない。
  GitHub 側の名前のほうが実態に近い

- **ブランチとコミットの分担**:
  - 実装は **`work/orchestrator-mvp` ブランチ**で行う。`main` へ直接コミットしない
  - **実装コードのコミットと push は実装者が行ってよい。** 進捗報告・レビュー依頼のたびに push し、
    スレッドへ `status` を書いてコミットハッシュを `refs` に添える。設計者はそれを取得してレビューする
  - **設計文書（`CONTEXT.md` / `docs/adr/` / `docs/handoff/`）のコミットは設計者が行う。**
    実装者はこれらを編集しない（指摘は `question` で上げる）
  - **PR の作成はオーナーの指示を待つ。** 実装者・設計者ともに勝手に作らない

- シークレットは無い。認証を持たない設計なので、トークン類は発生しない。
  発生した場合は `.env` に置き `.gitignore` する
