# Incoming Webhook（外部からのメッセージ投稿）仕様案 (docs/incoming_webhook_spec.md)

* **ステータス**: ✅ コード実装済み (2026-11-15, DEC-039) — `specifications.md` / `decisions.md` / `database_design.md` / `setup_backend.md` へ反映済み。Supabase SQL Editor での DDL 実行および Edge Function デプロイはユーザー手作業（§12.3 参照）
* **作成日**: 2026-11-15
* **経緯**: 既存の「カスタムWebhook通知（[custom_webhook_spec.md](./custom_webhook_spec.md) / `DEC-033`）」は着信を外部URLへ通知する **Outgoing Webhook** である。これとは逆方向の、外部システム（監視ツール・CI/CD・GAS・IoT・自動化スクリプト等）からHTTP POSTを受け取ってチャットルームへメッセージを投稿し、メンバーの端末で自動音声読み上げ（TTS）・プッシュ通知を行わせる **Incoming Webhook** を新設する。

---

## 1. 概要

* チャットルーム（`chat_rooms`）単位で、推測困難なトークンを含む **Webhook URL** を発行できる。
* 外部システムがそのURLへJSONを `POST` すると、対象ルームにテキストメッセージとして投稿され、ルームメンバー全員（Webhook作成者自身を含む）の受信箱（`user_inboxes`）へ配信される。
* 配信後は既存の受信パイプライン（Supabase Realtime による即時TTS読み上げ・未読バッジ更新、および `send-push-notification` によるFCMプッシュ通知・Android DeepSleep起床読み上げ `DEC-038`）がそのまま動作する。
* **信頼モデル**: URL自体をシークレットとする方式（Discord Incoming Webhook や既存 `DEC-033` と同等）。万一URLが漏洩してスパムが発生した場合は、ルームメンバーの操作で即座に一時停止または削除（完全失効）できる。
* **Discord Webhook 簡易互換**: 自作スクリプトだけでなく、外部ツールの「Discord Webhook通知機能」の出力先としても極力そのまま流用できるよう、ペイロードのキー解釈に互換性を持たせる（§3）。
* **無料枠保護**: Supabase 無料枠（Edge Functions 呼び出し回数・DB容量・Realtime）を踏み抜かないよう、DB接続前の入口検証・行が増えない固定ウィンドウレートリミット・ファンアウト人数を加味した月間サーキットブレーカーを設ける（§6）。

---

## 2. URL設計と失効制御

### 2.1. エンドポイントURL構成

```text
POST https://<project-ref>.supabase.co/functions/v1/incoming-webhook/<secret_token>
```

| 要素 | 内容 |
| --- | --- |
| `/functions/v1/incoming-webhook` | 新設する Supabase Edge Function（`verify_jwt = false`）の固定パス |
| `<secret_token>` | 発行時に生成する推測困難なトークン（`ctw_` + 24バイト乱数のBase64urlエンコード＝計36文字、`[A-Za-z0-9_-]`） |

* **主キー `id` と `secret_token` の分離（セキュリティ要件）**:
  * テーブル主キー `id`（UUID）はUI上の一覧取得・ON/OFF切替・削除操作の識別子として使い、URLパスには一切使用しない。
  * URLには別カラムの `secret_token` のみを使用することで、画面表示やログから `id` が見えてもURLを推測できない構造とする。
* **認証ヘッダー不要**: 外部サービスが `Authorization` ヘッダー（Supabase `anon` キー等）を付与できないケースに対応するため、`verify_jwt = false` としてパス内の `secret_token` のみで認証する。

### 2.2. 設定項目と上限

| 項目 | 必須 | 内容 |
| --- | --- | --- |
| ラベル (`label`) | 任意 | 用途の識別名兼、POST時に `username` が省略された場合の既定送信者名（例: `自宅センサー`, `監視Bot`）。最大30文字。未入力時は `'Webhook'` として扱う |
| 有効/無効 (`is_active`) | 必須 | 一時停止／再開トグル（デフォルト `true`） |
| トークン (`secret_token`) | 自動 | 作成時にフロント側（`crypto.getRandomValues`）またはDBデフォルトで自動生成。後からコピー可能 |

* **登録上限**: **1チャットルームあたり最大5件**（フロント側での制限＋DBトリガーまたはRPCでのガード）。
* **対象ルーム**: DB上に実体が存在するルーム（`activeChatHistoryId !== null`）のみ。新規グループ作成中（最初のメッセージ送信前で `chat_rooms` 行が未生成の状態）は設定ボタンを非表示または無効化する。

### 2.3. 権限モデルと失効方法（ルームメンバー全員によるフラット管理）

本アプリのフラットな権限思想（`DEC-023`「メンバーなら誰でもグループ削除・名前編集可」）に合わせ、**対象ルーム（`chat_room_members`）に所属するメンバーなら誰でも**以下を行える。

1. **作成**: 新規Webhookを発行する（作成者の `user_id` を `created_by` に記録し、一覧に「作成者: 〇〇」と表示して透明性を確保する）。
2. **一時停止 / 再開 (`is_active` トグル)**: URLを維持したまま一時的にPOST受付を遮断・再開する。
3. **完全失効（削除 / `DELETE`）**: レコードを物理削除する。同じURLは二度と復活できず、以後のPOSTは即座に拒否される。
   * 特に1対1の個別チャット等で、相手が作成したWebhookから不要な通知が届く場合でも、受信側メンバー自身の操作でいつでも停止・削除できる。
4. **退会時の自動消滅**: `room_id` の外部キーを `ON DELETE CASCADE` とするため、メンバー退会時のクリーンアップ（`leave_community_and_cleanup` による `chat_rooms` 削除）に伴って該当ルームのWebhookも自動的に完全消去される。

---

## 3. リクエスト・レスポンス仕様（POSTエンティティ）

### 3.1. リクエスト形式

* **HTTPメソッド**: `POST` のみ許可（それ以外は `405 Method Not Allowed`）
* **Content-Type**: `application/json`（文字コード UTF-8）
* **最大ボディサイズ**: **8,192 bytes (8KB)**
  * ※`Content-Length` ヘッダーの事前チェックに加え、チャンク転送によるメモリ枯渇を防ぐため実ストリーム読み取り時にもバイト長上限を適用し、超過時はDBに接続せず `413 Payload Too Large` を返す。

### 3.2. JSONペイロード構造（Discord簡易互換）

基本形（推奨）:
```json
{
  "content": "サーバーのCPU使用率が90%を超えました",
  "username": "監視Bot"
}
```

外部ツールの Discord / Slack Webhook 出力や自作スクリプトの双方から認知ノイズなく使えるよう、以下の優先順でフィールドを解釈する。

| 論理項目 | 優先解釈順（フォールバック） | バリデーション・正規化仕様 |
| --- | --- | --- |
| **本文**（必須） | 1. `body.content`（Discord互換）<br>2. `body.text`（Slack互換）<br>3. `body.message`（内部互換）<br>4. `body.embeds[0]` の `title` と `description` を改行結合（Discord Embed互換） | ・文字列化し、NULLバイト（`\u0000`）および制御文字（`\n`, `\r`, `\t` 以外）を除去後 `trim()` する<br>・結果が空文字の場合は `400 Bad Request`<br>・**最大500文字**: 500文字を超える場合はエラーにせず **先頭500文字＋`…` に自動切り詰め** する（※外部監視ツール等が長文スタックトレースを送った際に `400` で通知ごとロストするのを防ぎ、かつTTS読み上げが長時間占有されるのを防ぐため） |
| **送信者名**（任意） | 1. `body.username`（Discord / Slack / `DEC-033` 互換） | ・文字列化・制御文字除去・`trim()`<br>・未指定または空文字の場合は Webhook 登録時の `label`（それも空なら `'Webhook'`）を使用<br>・**最大30文字**（超過分は切り詰め） |
| **その他のキー** | `avatar_url`, `tts`, `embeds`（2件目以降）, `allowed_mentions` 等 | **すべて無視する**（未知のフィールドがあってもエラーにしない） |

> **音声URL (`audio_url`) を受け付けない理由**: 外部指定URLの音声再生は SSRF・悪意ある大容量ファイルによる通信量枯渇・CORS不整合の原因となるため、Incoming Webhook は**テキスト専用**とする。テキストとして登録すれば Web / Android 双方の既存 TTS で安全に自動読み上げされる。

### 3.3. レスポンス形式

| 状態 | ステータス | レスポンスボディ例 | 備考 |
| --- | --- | --- | --- |
| 投稿成功 | `201 Created` | `{ "ok": true, "message_id": "uuid" }` | |
| メソッド不正 | `405 Method Not Allowed` | `{ "ok": false, "error": "method_not_allowed" }` | `Allow: POST` ヘッダー付与 |
| サイズ超過 | `413 Payload Too Large` | `{ "ok": false, "error": "payload_too_large" }` | 8KB超過時 |
| JSON/本文不正 | `400 Bad Request` | `{ "ok": false, "error": "invalid_payload", "message": "..." }` | JSONパース失敗、本文が空など |
| トークン無効・停止中・削除済み | `404 Not Found` | `{ "ok": false, "error": "webhook_not_found" }` | **重要**: 「元々存在しないURL」と「一時停止中（`is_active = false`）」を外部から判別させないため、同一の `404` レスポンスに統一する |
| レートリミット超過 | `429 Too Many Requests` | `{ "ok": false, "error": "rate_limit_exceeded" }` | `Retry-After: <秒>` ヘッダーを付与 |

---

## 4. データモデル設計と「`sender_id = NULL` 問題」の解決

### 4.1. 課題：`messages.sender_id = NULL` の意味衝突とファンアウト欠落

1. **既存の意味との衝突**: 既存設計（[database_design.md](./database_design.md)）では、`messages.sender_id` の `NULL` は **「アカウント削除等で `users` から消えた元メンバー（`ON DELETE SET NULL`）」** を意味する。Webhook投稿を単に `sender_id = NULL` だけで表現すると、元メンバーの過去発言とWebhook投稿が区別できなくなる。
2. **ファンアウトトリガーの `NULL` 罠**: 既存の `handle_new_message_fanout` トリガーは `WHERE m.room_id = new.room_id AND m.user_id != new.sender_id` となっている。PostgreSQLでは `new.sender_id` が `NULL` のとき `m.user_id != NULL` が `UNKNOWN`（偽）となり、**誰の `user_inboxes` にも入らず、自動再生もプッシュ通知も一切動作しなくなる**。
3. **作成者本人への配信**: 仮に `sender_id` にWebhook作成者の `user_id` を入れると、`m.user_id != new.sender_id` により**作成者本人の `user_inboxes` に入らず、自分が仕掛けたWebhook通知を自分の耳（TTS/FCM）で受け取れない**。

### 4.2. 解決策：`sender_type` による明示的分離

`messages` テーブルに送信元種別 `sender_type` 等を追加し、「退会済み人間ユーザー（`sender_type = 'user' AND sender_id IS NULL`）」と「Webhook投稿（`sender_type = 'webhook' AND sender_id IS NULL`）」を構造的に分離する。

```dbml
Table incoming_webhooks {
  id uuid [pk, default: `gen_random_uuid()`]
  community_id uuid [not null, ref: > communities.id, note: 'on delete cascade']
  room_id uuid [not null, ref: > chat_rooms.id, note: 'on delete cascade']
  created_by uuid [ref: > users.id, note: 'on delete set null']
  label varchar(30) [not null, default: 'Webhook']
  secret_token varchar(64) [unique, not null, note: 'URLパス用の推測困難トークン。idとは別管理']
  is_active boolean [not null, default: true]
  last_used_at timestamptz
  created_at timestamptz [not null, default: `now()`]
}

Table incoming_webhook_rate_limits {
  webhook_id uuid [pk, ref: - incoming_webhooks.id, note: 'on delete cascade。1 Webhookにつき1行のみ']
  minute_window timestamptz [not null, default: `date_trunc('minute', now())`]
  minute_count int [not null, default: 0]
  day_window date [not null, default: `(now() at time zone 'utc')::date`]
  day_count int [not null, default: 0]
}

Table incoming_webhook_monthly_usage {
  month_key varchar(7) [pk, note: "例: '2026-11' (UTC月)。月1行のみ"]
  request_count int [not null, default: 0, note: '成立したPOST回数']
  fanout_units int [not null, default: 0, note: '累計 (1 + ルーム人数)。Edge Function消費量の目安']
  updated_at timestamptz [not null, default: `now()`]
}

Table messages {
  ...（既存カラム）
  sender_type varchar(16) [not null, default: 'user', note: "check: 'user' | 'webhook'"]
  incoming_webhook_id uuid [ref: > incoming_webhooks.id, note: 'on delete set null。削除後も履歴のsender_typeと表示名は維持']
  webhook_sender_name varchar(30) [note: 'Webhook投稿時の表示名スナップショット']
}
```

* **CHECK制約**:
  ```sql
  alter table public.messages
    add constraint messages_sender_type_check
    check (
      (sender_type = 'user')
      or (sender_type = 'webhook' and sender_id is null and webhook_sender_name is not null)
    );
  ```
* **Webhook削除（失効）後の履歴保全**: `incoming_webhook_id` は `ON DELETE SET NULL` とし、Webhook削除後も `messages.sender_type = 'webhook'` と `messages.webhook_sender_name` がそのまま残るため、過去のチャットバブルが「元メンバー」に化けたり消えたりしない。

### 4.3. ファンアウトトリガー `handle_new_message_fanout` の改修

```sql
create or replace function public.handle_new_message_fanout()
returns trigger
security definer
language plpgsql
as $$
begin
  insert into public.user_inboxes (user_id, room_id, message_id, is_read)
  select
    m.user_id,
    new.room_id,
    new.id,
    false
  from public.chat_room_members as m
  where m.room_id = new.room_id
    and (
      new.sender_type = 'webhook'        -- ★ Webhook投稿は作成者を含むルーム全員に配信
      or m.user_id != new.sender_id      -- 通常投稿は送信者本人以外に配信
    );

  return new;
end;
$$;
```

---

## 5. パイプラインと無限ループ防止・仕様上の不具合対策

### 5.1. 全体パイプラインと1トランザクションRPC

Edge Function から DB への通信往復を **1回（1トランザクション）** に抑えてレイテンシと実行時間を最小化するため、検証・レートリミット・メッセージ挿入を一括で行う PostgreSQL RPC `post_via_incoming_webhook`（`SECURITY DEFINER`）を定義する。

```text
外部システム POST /functions/v1/incoming-webhook/<secret_token>
  └─ Edge Function: incoming-webhook 🆕
       ├─ 1. 入口検証（POST確認・トークン形式・8KB上限・JSON解析・本文/username正規化）
       │      ※不正ならDB接続ゼロで 400 / 404 / 405 / 413 応答
       └─ 2. RPC: post_via_incoming_webhook(p_secret_token, p_content, p_username) 🆕
            ├─ incoming_webhooks を検索（無ければ not_found）
            ├─ is_active = false なら not_found（統一応答用）
            ├─ レートリミット判定＆カウンタ更新（§6）→ 超過なら rate_limited
            ├─ messages INSERT (sender_type='webhook', sender_id=NULL, ...)
            └─ トリガー on_message_created → handle_new_message_fanout
                 └─ user_inboxes INSERT（ルームメンバー全員分）
                      ├─ Realtime → クライアントで即時チャット反映＋TTS読み上げ
                      └─ Database Webhook → send-push-notification（★改修）
                           ├─ FCMプッシュ通知（Android DeepSleep起床TTS含む）
                           ├─ Discord Webhook（既存）
                           └─ カスタムWebhook (user_webhooks): ★ sender_type='webhook' の場合はスキップ！
```

### 5.2. 既存 Outgoing Webhook との無限ループ防止（セキュリティ要件）

`send-push-notification` は `user_inboxes` INSERT ごとに起動し、受信者が設定した `user_webhooks`（任意のHTTPS URL）へPOSTを行う（`DEC-033`）。
もしユーザーが誤って（または悪意をもって）自分の `user_webhooks` の送信先に同ルームの Incoming Webhook URL（またはそこへ転送するGAS）を登録すると、**Incoming → Inbox → Outgoing → Incoming の無限ループ**が発生し、無料枠を瞬時に枯渇させる。

* **対策**: [send-push-notification/index.ts](../supabase/functions/send-push-notification/index.ts) にて、`messages` から `sender_type` と `webhook_sender_name` を取得し、**`msgData.sender_type === 'webhook'` の場合は `user_webhooks`（Outgoing カスタムWebhook）への送信を一切行わない**。
* なお、FCMプッシュ通知はループの危険がなく、「スマホをポケットに入れたままWebhook通知を音声で聴く」という中核ユースケースに必要なため通常どおり送信する。

### 5.3. 仕様上の不具合対策（フロントエンド／Android 共通）

コードベース調査により判明した以下の3つの潜在不具合を、実装時に必ず併せて対処する。

1. **チャットバブルの HTML エスケープ（Stored XSS・表示崩れ防止）**
   * **現状の課題**: [src/ui/chat.ts:313-333](../src/ui/chat.ts#L313-L333) の `ChatWindowUI` は、`bubbleEl.innerHTML` に `${msg.senderName}` と `${msg.textContent}` を生で埋め込んでいる。外部Webhookから `<script>` や `<img onerror=...>`、あるいはエラーログ内の `<Component>` 等の文字列が送られると、**Stored XSS** やタグ消滅による表示崩れが起きる。
   * **対策**: `src/ui/chat.ts` で `senderName` と `textContent` を埋め込む際は必ず HTML エスケープ関数を通す（または `textContent` プロパティでDOMノードにセットする）。
2. **個別チャット（`type = 'individual'`）での未読バッジ不整合（ゴースト未読防止）**
   * **現状の課題**: `getUnreadIndividualCounts`（[src/services/supabase.ts:453-481](../src/services/supabase.ts#L453-L481) および Android版 [SupabaseClientService.cs:483-495](../android/Chatransceiver.Maui/Services/SupabaseClientService.cs#L483-L495)）は、`messages.sender_id` をキーにサイドバーの個別メンバー未読数を集計している。一方、PWAアイコンの未読バッジ（`DEC-037` の `getUnreadCount`）は `user_inboxes` の未読総数を数える。
   * そのため、個別チャットに `sender_id = NULL` のWebhook投稿が届くと、**「アプリアイコンには未読バッジが出ているのに、サイドバーの誰の行にも未読バッジが付かず、どこを開けば消えるのか分からない」** という不整合が起きる。
   * **対策**: `getUnreadIndividualCounts` のクエリで `chat_rooms!inner(type, community_id, chat_room_members(user_id))` を取得し、`messages.sender_id` が `NULL` の場合は **「その個別ルームの相手メンバー（`user_id !== currentUserId`）」のID** をキーとして未読数を加算する。これにより個別チャットでも相手行に正しく未読バッジが付き、開けば既読化される。
3. **自動再生時のハイライト処理の null ガード**
   * [src/app.ts:1353-1355](../src/app.ts#L1353-L1355) の `enqueuePlaybackItem` で、個別チャットの再生開始時に `this.state.playingUserId = item.senderId` をセットしている。`senderId` を `string | null` に拡張した際、空または `null` なら `undefined` にフォールバックさせる（全画面停止パネル `DEC-032` には `autoplaySenderName` が表示されるためUX上の問題はない）。

---

## 6. 無料枠を守るためのレートリミット設計

### 6.1. 増幅係数（Amplification Factor）の考慮

1回の Incoming Webhook POST が成功すると、ルームメンバー数を $N$ 人としたとき：
* `incoming-webhook` Edge Function 起動: **1回**
* `user_inboxes` INSERT: **$N$ 行**
* `send-push-notification` Edge Function 起動: **$N$ 回**

すなわち **1 POST あたり $(1 + N)$ 回の Edge Function 起動** が発生する。無料枠を確実に守るため、外部課金サービス（Upstash Redis 等）は使わず、**Supabase 単体で完結する3層のレートリミット**を実装する。

### 6.2. 3層レートリミット仕様

| 層 | 単位 | 上限値 | 目的・超過時の挙動 |
| --- | --- | --- | --- |
| **第1層：短期バースト制限** | 1 Webhook あたり（1分固定ウィンドウ） | **6回 / 分** | TTS読み上げキューの詰まり防止・連打抑止。超過時は `429`（`Retry-After: <次の分までの秒数>`） |
| **第2層：日次制限** | 1 Webhook あたり（UTC日次ウィンドウ） | **200回 / 日** | スクリプト暴走やURL漏洩時の夜間スパム抑止。超過時は `429`（`Retry-After: 3600`） |
| **第3層：月間サーキットブレーカー** | プロジェクト全体（UTC月次） | **累計 30,000 ユニット / 月**<br>（※1 POST ＝ `1 + ルーム人数` ユニットとして加算） | Supabase 無料枠（月50万回のEdge Function呼び出し等）の絶対死守。5人部屋なら月5,000回相当。超過時は全Webhookを `429` で安全停止し、通常チャットとFCMプッシュの稼働を守る |

* **DB容量を消費しない設計（性能要件）**:
  * `stt_usage_log`（月200件）のような毎回行を `INSERT` するログ方式は、高頻度のWebhookではテーブル肥大化を招くため採用しない。
  * `incoming_webhook_rate_limits`（Webhookごとに1行のみ）と `incoming_webhook_monthly_usage`（1ヶ月に1行のみ）を `INSERT ... ON CONFLICT DO UPDATE` でインプレース更新する方式とし、**何万回リクエストされてもDB行数が増えない**構造とする。

---

## 7. UI仕様（Web版）

### 7.1. チャットヘッダーへの導線追加

* 既存の「環境設定モーダル」は個人設定用のため、ルーム共有設定である Incoming Webhook は **チャットウィンドウ上部ヘッダー（`.chat-room-title-row`、グループ名変更ボタン `✏️` の並び）** に `🔗`（Webhook管理）ボタンを配置する。
* 選択中のルームがDB上に存在するとき（`activeChatHistoryId !== null`）のみボタンを表示する。

### 7.2. Incoming Webhook 管理モーダル

`🔗` ボタンをクリックするとモーダルを開き、現在開いているルームの `incoming_webhooks` 一覧を表示する。

* **一覧表示項目**:
  * ON / OFF トグル（`is_active`、即時保存）
  * ラベル名（`label`）＋ 作成者名（`作成: 〇〇`）＋ 最終利用日時（`last_used_at`）
  * **「📋 URLをコピー」ボタン**: `https://<project-ref>.supabase.co/functions/v1/incoming-webhook/<secret_token>` をクリップボードにコピー
  * **「🗑️ 削除（失効）」ボタン**: 確認ダイアログ（「このWebhookを削除してURLを失効させますか？」）の後に物理削除
* **新規追加ボタン（「＋ Webhookを追加」）**:
  * ラベル入力欄（任意、プレースホルダー: `例: 監視アラート、GitHub通知`）＋「作成」ボタン
  * 1ルーム5件に達している場合はボタンを無効化（「上限（5件）に達しています」表示）

### 7.3. チャットバブル・通知での表示区別

* `sender_type === 'webhook'` のメッセージは、自分の発言（右寄せ・`outgoing`）にはならず、常に受信側（左寄せ・`incoming`）として描画し、取り消しボタン（`🗑️`）は表示しない。
* 送信者名表示（`.message-sender`、自動再生停止パネル、FCM通知タイトル）では、人間メンバーの発言と一目で区別できるよう **`🔗 [送信者名]`**（またはバッジ表示）を付与する。

---

## 8. Androidネイティブアプリ版（`DEC-038`）への対応範囲

* **設定UI（作成・URLコピー・削除）**: `DEC-038` 決定5（機能スリム化）の方針に従い、**Web版のみ搭載（Android版は非搭載）**とする。
* **受信・再生・表示（必須追従）**:
  1. **バックグラウンドFCM着信再生 (`ChatFcmService.cs`)**: `send-push-notification` が送る `data.senderName`（`🔗 ...`）と `data.textContent` をそのままTTS読み上げするため、Android側のFCMコード変更なしでそのまま動作する。
  2. **履歴取得・Realtime購読 (`SupabaseClientService.cs`)**: `messages` の `select` に `sender_type,webhook_sender_name` を追加し、`sender_type == "webhook"` の場合は表示名に `🔗 {webhook_sender_name}` をセットする。
  3. **個別チャット未読集計 (`GetUnreadIndividualCounts`)**: §5.3.2 と同じく、`sender_id` が `null` の未読を相手メンバーIDに帰属させる。

---

## 9. RLS（Row Level Security）設計

```sql
alter table public.incoming_webhooks enable row level security;
alter table public.incoming_webhook_rate_limits enable row level security;
alter table public.incoming_webhook_monthly_usage enable row level security;

-- incoming_webhooks: 対象ルーム (room_id) のメンバーのみ参照・作成・更新・削除可能
create policy "Room members can view incoming webhooks"
  on public.incoming_webhooks for select
  using (
    exists (
      select 1 from public.chat_room_members crm
      where crm.room_id = incoming_webhooks.room_id
        and crm.user_id = auth.uid()
    )
  );

create policy "Room members can create incoming webhooks"
  on public.incoming_webhooks for insert
  with check (
    auth.uid() = created_by
    and exists (
      select 1 from public.chat_room_members crm
      join public.chat_rooms cr on cr.id = crm.room_id
      where crm.room_id = incoming_webhooks.room_id
        and crm.user_id = auth.uid()
        and cr.community_id = incoming_webhooks.community_id
    )
  );

create policy "Room members can update incoming webhooks"
  on public.incoming_webhooks for update
  using (
    exists (
      select 1 from public.chat_room_members crm
      where crm.room_id = incoming_webhooks.room_id
        and crm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.chat_room_members crm
      join public.chat_rooms cr on cr.id = crm.room_id
      where crm.room_id = incoming_webhooks.room_id
        and crm.user_id = auth.uid()
        and cr.community_id = incoming_webhooks.community_id
    )
  );

create policy "Room members can delete incoming webhooks"
  on public.incoming_webhooks for delete
  using (
    exists (
      select 1 from public.chat_room_members crm
      where crm.room_id = incoming_webhooks.room_id
        and crm.user_id = auth.uid()
    )
  );

-- レートリミット用2テーブルはポリシーを作成せず、anon / authenticated からは完全不可視とする
-- （SECURITY DEFINER RPC / service_role のみアクセス可能）
```

---

## 10. 変更対象ファイル一覧（実装時の見込み）

| レイヤ | 対象ファイル | 変更内容 |
| --- | --- | --- |
| DB (SQL) | マイグレーション / `docs/setup_backend.md` | `incoming_webhooks`, `incoming_webhook_rate_limits`, `incoming_webhook_monthly_usage` 新設＋RLS、`messages` カラム追加、`handle_new_message_fanout` 更新、`post_via_incoming_webhook` RPC追加 |
| Edge Function | `supabase/functions/incoming-webhook/index.ts`（新設）<br>`supabase/config.toml` | POST受付・バリデーション・Discord互換パース・RPC呼び出し・ステータス制御。`config.toml` に `verify_jwt = false` 追加 |
| Edge Function | `supabase/functions/send-push-notification/index.ts` | `sender_type`, `webhook_sender_name` 取得、通知送信者名解決、`sender_type === 'webhook'` 時の `user_webhooks` 送信スキップ |
| Web (Service) | `src/services/supabase.ts` | `incoming_webhooks` CRUD、`messages` 取得/購読クエリ拡張、`getUnreadIndividualCounts` の `sender_id = null` 対応 |
| Web (UI/App) | `index.html`<br>`src/style.css`<br>`src/ui/chat.ts`<br>`src/ui/controller.ts`<br>`src/app.ts` | チャットヘッダーの `🔗` ボタン＋管理モーダル追加、`chat.ts` のHTMLエスケープ対応＋`🔗` 表示、`enqueuePlaybackItem` の null ガード |
| Android | `android/Chatransceiver.Maui/Services/SupabaseClientService.cs`<br>`android/Chatransceiver.Maui/Models/AppModels.cs` | `sender_type`, `webhook_sender_name` の取得・表示名反映、`GetUnreadIndividualCounts` の `sender_id = null` 対応 |

---

## 11. 見送り事項（本仕様のスコープ外）

* 音声ファイルURL（`audio_url`）や画像のPOST受付（セキュリティおよび無料枠保護のためテキスト専用）
* HMAC署名検証（`X-Hub-Signature-256` 等）やIP制限（URL自体をシークレットとし、漏洩時は失効・再作成で対処する方針のため）
* Androidネイティブアプリ側でのWebhook作成・削除UI（閲覧・着信読み上げのみ対応）
* チャット画面上からのWebhook投稿メッセージの個別取り消し（ルーム退出・ルーム削除時には通常どおり一括消去される）

---

## 12. 段階的実装計画・AI実装指示書（モデル引き継ぎ・省トークン用）

このセクションは、コンテキスト圧縮（`/compact`）、別チャットセッションへの移行、または **Gemini 4 Argon から Gemini 4 Hydrogen へのモデル切り替え** が途中で発生しても、**このファイル1つを読むだけで迷わず最小トークンで実装を完遂するための指示書（兼・進捗チェックリスト）** である。

### 12.1. AIエージェントへの実装ルール（トークン消費最小化）

1. **進捗の記録**: 各フェーズの項目を完了するごとに、本セクション（§12.2）のチェックボックスを `[ ]` から `[x]` に更新すること。モデル切り替え後のエージェントは、最初の `[ ]` から作業を再開する。
2. **巨大ファイルの全文読み込み禁止**:
   * `src/app.ts`（約1,715行）、`src/ui/controller.ts`（約971行）、`src/services/supabase.ts`（約914行）、`android/Chatransceiver.Maui/Services/SupabaseClientService.cs` は全文を `read_file` しないこと。
   * 下記 §12.2 に記載された**対象行番号の前後50〜80行のみ**を `StartLine` / `EndLine` 指定で読み込むこと。
3. **ビルド実行の最小化**:
   * 1ファイル編集ごとにビルドを回さないこと。ビルド検証は **Phase 3 完了時の `npm run build`** と **Phase 4 完了時の `npm run build:android`** の計2回のみ行う。
4. **サブエージェント不使用**:
   * プロンプト複製によるクォータ消費を避けるため、サブエージェントは起動せず単一スレッドで直接編集する。
5. **Supabase DDL適用・デプロイはユーザー手作業**:
   * AIエージェントは `npx supabase` 等のデプロイコマンドやDBマイグレーションコマンドを実行しないこと。コード実装完了時に、下記 §12.3 の手順・DDL・コマンドをユーザーへ案内する。

### 12.2. フェーズ別進捗チェックリスト（ピンポイント行番号付き）

#### Phase 1：ブランチ作成・DBスキーマ・Edge Functions【Argon 優先】
- [x] **1-1. 新規ブランチ作成**: `git checkout -b feature/incoming-webhook`
- [x] **1-2. バックエンド構築手順書へのSQL追記**: [docs/setup_backend.md](./setup_backend.md)（末尾 §8 付近のみ読む）に §12.3 のマイグレーションSQLとデプロイ手順を追記
- [x] **1-3. 新規 Edge Function 作成**: `supabase/functions/incoming-webhook/index.ts` を作成し、[supabase/config.toml](../supabase/config.toml)（L415-435）に `[functions.incoming-webhook]` (`verify_jwt = false`) を追記
- [x] **1-4. 既存通知関数の更新**: [supabase/functions/send-push-notification/index.ts](../supabase/functions/send-push-notification/index.ts)（L80-105, L190-241）を更新
  - `messages` の `select` に `sender_type, webhook_sender_name` を追加
  - `senderName` を `msgData.sender_type === 'webhook' ? ('🔗 ' + (msgData.webhook_sender_name || 'Webhook')) : ((msgData.users as any)?.name || '不明なユーザー')` に変更
  - `msgData.sender_type === 'webhook'` の場合は `customWebhooks`（`user_webhooks`）ループをスキップ（§5.2）

#### Phase 2：Web サービス層・メッセージ表示改修【Argon / Hydrogen】
- [x] **2-1. SupabaseService 拡張**: [src/services/supabase.ts](../src/services/supabase.ts)
  - L15-75: `IncomingWebhook` 型定義、`SupabaseMessage` に `senderId: string | null`, `isWebhook?: boolean` を追加
  - L450-482 (`getUnreadIndividualCounts`): `chat_rooms!inner(type, community_id, chat_room_members(user_id))` を取得し、`sender_id` が `null` の場合は `chat_room_members` から `user_id !== userId` の相手IDを特定して未読加算（§5.3.2）
  - L568-590 (`getRoomMessages`), L715-800 (`subscribeInbox`, `subscribeRoomMessages`): `select` に `sender_type, webhook_sender_name` を追加し、`sender_type === 'webhook'` 時は `senderName = '🔗 ' + (webhook_sender_name || 'Webhook')`, `isWebhook = true` をセット
  - ファイル末尾付近: `getIncomingWebhooks(roomId)`, `createIncomingWebhook(communityId, roomId, createdBy, label)`, `toggleIncomingWebhook(id, isActive)`, `deleteIncomingWebhook(id)` とWebhook URL生成ヘルパーを追加（トークンは `ctw_` + 24バイト乱数のBase64url）
- [x] **2-2. チャット表示のXSS対策・Webhook表示**: [src/ui/chat.ts](../src/ui/chat.ts)
  - L1-10: `MessageItem.senderId` を `string | null`、`isWebhook?: boolean` に拡張
  - L304-365 (`renderMessages`): `msg.senderName` と `msg.textContent` に HTMLエスケープを適用（§5.3.1）。`isOutgoing` を `!msg.isWebhook && msg.senderId === currentUserId` とする
- [x] **2-3. 自動再生キューの null ガード**: [src/app.ts](../src/app.ts)（L1330-1395）
  - `enqueuePlaybackItem` の `senderId` 型を `string | null` とし、`this.state.playingUserId = item.senderId || undefined` にガード

#### Phase 3：Web Incoming Webhook 管理モーダル UI【Hydrogen 可】
- [x] **3-1. HTML・CSS 追加**:
  - [index.html](../index.html)（L150-165 の `.chat-room-title-row`、および L350 付近のモーダル群）: ヘッダーに `🔗` ボタン（`.btn-room-webhooks`）を追加し、Incoming Webhook管理モーダル（`#incomingWebhookModal`）を追加
  - [src/style.css](../src/style.css): 既存の `.webhook-list`, `.webhook-item` スタイルを流用しつつ、ヘッダーボタン等の最小限のスタイルを追加
- [x] **3-2. UIController・App 配線**:
  - [src/ui/chat.ts](../src/ui/chat.ts)（L20-90, L230-290）: `.btn-room-webhooks` のクリックハンドラと表示制御（`roomId` が存在する時のみ表示）
  - [src/ui/controller.ts](../src/ui/controller.ts)（L640-730 参照）および [src/app.ts](../src/app.ts)（L1445-1490 参照）: モーダル開閉、一覧描画、新規作成（最大5件制限）、URLコピー、ON/OFFトグル、削除（失効）の配線
- [x] **3-3. Web ビルド検証**: `npm run build` を実行し、TypeScript 型エラー・バンドルエラーが無いことを確認

#### Phase 4：Android 受信表示追従 & ドキュメント同期【Hydrogen 可】
- [x] **4-1. Android データ取得・未読集計の追従**:
  - [android/Chatransceiver.Maui/Models/AppModels.cs](../android/Chatransceiver.Maui/Models/AppModels.cs) と [SupabaseClientService.cs](../android/Chatransceiver.Maui/Services/SupabaseClientService.cs)（L480-510, L730-790）を更新し、`sender_type`, `webhook_sender_name` による `🔗` 表示名解決と、`GetUnreadIndividualCounts` の `sender_id == null` 時の相手メンバー帰属に対応
- [x] **4-2. Android ビルド検証**: `npm run build:android` を実行し、エラーが無いことを確認
- [x] **4-3. 設計ドキュメント同期**: [docs/database_design.md](./database_design.md), [docs/specifications.md](./specifications.md), [docs/decisions.md](./decisions.md) に本仕様を反映し、本ファイル冒頭のステータスを更新

### 12.3. ユーザーが手作業で実行する DB DDL・デプロイコマンド一式

#### 手順A：Supabase SQL Editor で実行する一括DDL（後方互換あり・事前実行も可）
Supabase ダッシュボードの **「SQL Editor」** で **「New query」** を開き、以下のSQLを丸ごと貼り付けて **「Run」** をクリックする。
（※既存カラムにはデフォルト値 `'user'` が入り、旧フロントエンドからの通常メッセージ送信もそのまま動くため、コード実装の前・後のどちらで実行しても安全）

```sql
-- ========================================================
-- Incoming Webhook 対応マイグレーション一式
-- ========================================================

-- 1. incoming_webhooks テーブル作成
create table if not exists public.incoming_webhooks (
  id uuid default gen_random_uuid() primary key,
  community_id uuid references public.communities(id) on delete cascade not null,
  room_id uuid references public.chat_rooms(id) on delete cascade not null,
  created_by uuid references public.users(id) on delete set null,
  label varchar(30) not null default 'Webhook',
  secret_token varchar(64) unique not null,
  is_active boolean not null default true,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint incoming_webhooks_token_format_check check (secret_token ~ '^ctw_[A-Za-z0-9_-]{32}$')
);

create index if not exists idx_incoming_webhooks_room on public.incoming_webhooks(room_id);

-- 1b. incoming_webhooks のルームあたり最大5件制限 & 不変カラム保護トリガー
create or replace function public.enforce_incoming_webhook_rules()
returns trigger
security definer
set search_path = public
language plpgsql
as $$
declare
  v_count int;
begin
  if tg_op = 'INSERT' then
    select count(*) into v_count
      from public.incoming_webhooks
     where room_id = new.room_id;
    if v_count >= 5 then
      raise exception 'Maximum of 5 incoming webhooks per room exceeded';
    end if;
  elsif tg_op = 'UPDATE' then
    if new.community_id is distinct from old.community_id
       or new.room_id is distinct from old.room_id
       or new.secret_token is distinct from old.secret_token then
      raise exception 'Cannot modify immutable incoming_webhook fields';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_incoming_webhook_rules on public.incoming_webhooks;
create trigger trg_enforce_incoming_webhook_rules
  before insert or update on public.incoming_webhooks
  for each row
  execute function public.enforce_incoming_webhook_rules();

-- 2. レートリミット用テーブル作成（行が増えないインプレース更新型）
create table if not exists public.incoming_webhook_rate_limits (
  webhook_id uuid references public.incoming_webhooks(id) on delete cascade primary key,
  minute_window timestamptz not null default date_trunc('minute', now()),
  minute_count int not null default 0,
  day_window date not null default (now() at time zone 'utc')::date,
  day_count int not null default 0
);

create table if not exists public.incoming_webhook_monthly_usage (
  month_key varchar(7) primary key,
  request_count int not null default 0,
  fanout_units int not null default 0,
  updated_at timestamptz not null default now()
);

-- 3. messages テーブル拡張（人間ユーザーとWebhook投稿の明示的分離）
alter table public.messages
  add column if not exists sender_type varchar(16) not null default 'user',
  add column if not exists incoming_webhook_id uuid references public.incoming_webhooks(id) on delete set null,
  add column if not exists webhook_sender_name varchar(30);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'messages_sender_type_check'
  ) then
    alter table public.messages
      add constraint messages_sender_type_check
      check (
        (sender_type = 'user')
        or (sender_type = 'webhook' and sender_id is null and webhook_sender_name is not null)
      );
  end if;
end $$;

-- 4. RLS 設定（対象ルームの chat_room_members 全員が管理可能）
alter table public.incoming_webhooks enable row level security;
alter table public.incoming_webhook_rate_limits enable row level security;
alter table public.incoming_webhook_monthly_usage enable row level security;

drop policy if exists "Room members can view incoming webhooks" on public.incoming_webhooks;
create policy "Room members can view incoming webhooks"
  on public.incoming_webhooks for select
  using (
    exists (
      select 1 from public.chat_room_members crm
      where crm.room_id = incoming_webhooks.room_id
        and crm.user_id = auth.uid()
    )
  );

drop policy if exists "Room members can create incoming webhooks" on public.incoming_webhooks;
create policy "Room members can create incoming webhooks"
  on public.incoming_webhooks for insert
  with check (
    auth.uid() = created_by
    and exists (
      select 1 from public.chat_room_members crm
      join public.chat_rooms cr on cr.id = crm.room_id
      where crm.room_id = incoming_webhooks.room_id
        and crm.user_id = auth.uid()
        and cr.community_id = incoming_webhooks.community_id
    )
  );

drop policy if exists "Room members can update incoming webhooks" on public.incoming_webhooks;
create policy "Room members can update incoming webhooks"
  on public.incoming_webhooks for update
  using (
    exists (
      select 1 from public.chat_room_members crm
      where crm.room_id = incoming_webhooks.room_id
        and crm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.chat_room_members crm
      join public.chat_rooms cr on cr.id = crm.room_id
      where crm.room_id = incoming_webhooks.room_id
        and crm.user_id = auth.uid()
        and cr.community_id = incoming_webhooks.community_id
    )
  );

drop policy if exists "Room members can delete incoming webhooks" on public.incoming_webhooks;
create policy "Room members can delete incoming webhooks"
  on public.incoming_webhooks for delete
  using (
    exists (
      select 1 from public.chat_room_members crm
      where crm.room_id = incoming_webhooks.room_id
        and crm.user_id = auth.uid()
    )
  );

-- 5. ファンアウトトリガー改修（Webhook投稿時はルームメンバー全員へ配信）
create or replace function public.handle_new_message_fanout()
returns trigger
security definer
set search_path = public
language plpgsql
as $$
begin
  insert into public.user_inboxes (user_id, room_id, message_id, is_read)
  select
    m.user_id,
    new.room_id,
    new.id,
    false
  from public.chat_room_members as m
  where m.room_id = new.room_id
    and (
      new.sender_type = 'webhook'
      or m.user_id != new.sender_id
    );

  return new;
end;
$$;

-- 6. 1トランザクション投稿用 RPC (post_via_incoming_webhook)
create or replace function public.post_via_incoming_webhook(
  p_secret_token text,
  p_content text,
  p_username text default null
)
returns jsonb
security definer
set search_path = public
language plpgsql
as $$
declare
  v_wh record;
  v_member_count int;
  v_units int;
  v_now timestamptz := now();
  v_min_win timestamptz := date_trunc('minute', v_now);
  v_day_win date := (v_now at time zone 'utc')::date;
  v_month_key varchar(7) := to_char(v_now at time zone 'utc', 'YYYY-MM');
  v_min_count int;
  v_day_count int;
  v_month_units int;
  v_sender_name varchar(30);
  v_msg_id uuid;
begin
  select id, room_id, label, is_active
    into v_wh
    from public.incoming_webhooks
   where secret_token = p_secret_token;

  if not found or not v_wh.is_active then
    return jsonb_build_object('ok', false, 'error', 'webhook_not_found', 'status', 404);
  end if;

  select count(*) into v_member_count
    from public.chat_room_members
   where room_id = v_wh.room_id;

  v_units := 1 + coalesce(v_member_count, 0);

  insert into public.incoming_webhook_monthly_usage (month_key, request_count, fanout_units, updated_at)
  values (v_month_key, 0, 0, v_now)
  on conflict (month_key) do nothing;

  select fanout_units into v_month_units
    from public.incoming_webhook_monthly_usage
   where month_key = v_month_key
     for update;

  if v_month_units + v_units > 30000 then
    return jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded', 'status', 429, 'retry_after', 3600);
  end if;

  insert into public.incoming_webhook_rate_limits (webhook_id, minute_window, minute_count, day_window, day_count)
  values (v_wh.id, v_min_win, 0, v_day_win, 0)
  on conflict (webhook_id) do nothing;

  select
    case when minute_window = v_min_win then minute_count else 0 end,
    case when day_window = v_day_win then day_count else 0 end
    into v_min_count, v_day_count
    from public.incoming_webhook_rate_limits
   where webhook_id = v_wh.id
     for update;

  if v_min_count >= 6 then
    return jsonb_build_object(
      'ok', false,
      'error', 'rate_limit_exceeded',
      'status', 429,
      'retry_after', greatest(1, ceil(extract(epoch from (v_min_win + interval '1 minute' - v_now)))::int)
    );
  end if;

  if v_day_count >= 200 then
    return jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded', 'status', 429, 'retry_after', 3600);
  end if;

  update public.incoming_webhook_rate_limits
     set minute_window = v_min_win,
         minute_count = v_min_count + 1,
         day_window = v_day_win,
         day_count = v_day_count + 1
   where webhook_id = v_wh.id;

  update public.incoming_webhook_monthly_usage
     set request_count = request_count + 1,
         fanout_units = fanout_units + v_units,
         updated_at = v_now
   where month_key = v_month_key;

  v_sender_name := left(coalesce(nullif(btrim(p_username), ''), nullif(btrim(v_wh.label), ''), 'Webhook'), 30);

  insert into public.messages (
    room_id,
    sender_id,
    sender_type,
    incoming_webhook_id,
    webhook_sender_name,
    text_content,
    audio_url,
    needs_transcription
  )
  values (
    v_wh.room_id,
    null,
    'webhook',
    v_wh.id,
    v_sender_name,
    p_content,
    null,
    false
  )
  returning id into v_msg_id;

  update public.incoming_webhooks
     set last_used_at = v_now
   where id = v_wh.id;

  return jsonb_build_object('ok', true, 'message_id', v_msg_id, 'status', 201);
end;
$$;

revoke all on function public.post_via_incoming_webhook(text, text, text) from public, anon, authenticated;
grant execute on function public.post_via_incoming_webhook(text, text, text) to service_role;
```

#### 手順B：Phase 1（Edge Function 実装）完了後にターミナルで実行するデプロイコマンド
Phase 1 のファイル作成完了後、プロジェクトルートで以下を実行する。

```bash
# 1. 新規 Incoming Webhook 受付関数のデプロイ (JWT検証なし)
npx supabase functions deploy incoming-webhook --no-verify-jwt

# 2. 更新した通知送信関数の再デプロイ
npx supabase functions deploy send-push-notification
```

※新規の環境変数（Secrets）登録や Database Webhook（GUI設定）の追加は**不要**です。


