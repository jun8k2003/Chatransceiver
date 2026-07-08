# カスタムWebhook通知 仕様案 (docs/custom_webhook_spec.md)

* **ステータス**: ✅ 実装済み (2026-07-08, DEC-033) — specifications.md / decisions.md / database_design.md / setup_backend.md へ反映済み
* **作成日**: 2026-07-08
* **経緯**: `bot_function_spec.md` のうちボット振る舞い（`is_bot`・自動返信・ループ防止）は**見送り**。同仕様 §1.1／§4.2 の「汎用Webhook連携」のみを、独立機能「**カスタムWebhook**」として再設計したもの。本仕様が確定した場合、`bot_function_spec.md` の該当節は本仕様に置き換えられる。

---

## 1. 概要

自分のInboxへの着信を、ユーザーが登録した任意のURLへHTTPリクエストとして通知する機能。

* ユーザーは **URL・HTTPメソッド・Bodyテンプレート** の組を複数登録できる
* Bodyテンプレートには置換変数（`{message}`, `{username}` 等）を埋め込め、着信ごとに実値へ置換して送信する
* 送信は**投げっぱなし（fire-and-forget）**。リトライ・成否のユーザー通知は行わない
* 第一の利用例は **GAS（Google Apps Script）Webアプリによるメール転送**（§7）。ただしアプリ側はあくまで汎用Webhookであり、メールという概念は持たない
* 既存の Discord Webhook（`users.discord_webhook_url`）・FCM とは**独立に併存**する（動いているものを触らない）

## 2. 設定項目

| 項目 | 必須 | 内容 |
| --- | --- | --- |
| ラベル | 任意 | 設定UIでの表示名（例: 「メール転送」）。未入力時はURLの先頭を表示 |
| URL | 必須 | 送信先。`https://` のみ許可（保存時にバリデーション） |
| メソッド | 必須 | `POST` / `PUT` / `GET` / `DELETE`（デフォルト `POST`） |
| Bodyテンプレート | 任意 | 置換変数入りの本文。`POST` / `PUT` でのみ送信される（§4.2） |
| 有効/無効 | 必須 | エントリごとのON/OFFトグル（デフォルトON） |

* 登録上限: **1ユーザーあたり5件**（フロント側で制限。DB制約は設けない）
* Content-Type: **`application/json` 固定**（テンプレートがJSONでなくてもそのまま送る。受信側の責任で解釈）

## 3. 置換変数

テンプレート例:

```json
{ "message": "{message}", "from": "{username}", "link": "{url}" }
```

| 変数 | 置換内容 |
| --- | --- |
| `{message}` | メッセージ本文。音声のみの場合は `🎤 音声メッセージ` |
| `{username}` | 送信者の表示名 |
| `{community}` | コミュニティ名 |
| `{message_type}` | `audio` または `text` |
| `{url}` | アプリを開くリンク `https://chatransceiver13162.web.app/?c={slug}&m={messageId}` |

* 未知の変数（例: `{foo}`）は**置換せずそのまま残す**（エラーにしない）
* 変数の追加は本表への追記＋Edge Functionの変数マップ追加のみで完結する構造とする

### 3.1. エスケープ規則

Content-Type がJSON固定のため、**Body内の変数値はJSON文字列として安全になるようエスケープして埋め込む**（`"` → `\"`、改行 → `\n`、`\` → `\\` 等。実装は `JSON.stringify(value).slice(1, -1)`）。

これによりユーザーは上記例のように `"{message}"` と**引用符で囲むだけ**でよく、本文に引用符や改行が含まれても壊れない。テンプレートを非JSONとして使う場合もこのエスケープは適用される（仕様として明記）。

## 4. 送信仕様

### 4.1. 起点とタイミング

既存の受信パイプラインに乗せる。**新規Edge Functionは作らない**。

```
messages INSERT
  └─ DBトリガー handle_new_message_fanout（変更なし）
       └─ user_inboxes INSERT（変更なし）
            └─ Database Webhook → send-push-notification（★拡張）
                 ├─ FCM プッシュ（既存・変更なし）
                 ├─ Discord Webhook（既存・変更なし）
                 └─ カスタムWebhook 🆕（enabled な登録すべてに送信）
```

### 4.2. メソッドごとの挙動

| メソッド | Body | URL内の変数置換 |
| --- | --- | --- |
| `POST` / `PUT` | テンプレートを置換して送信 | あり |
| `GET` / `DELETE` | **送信しない**（テンプレートは無視。fetch仕様上GETにBodyを付けられないため） | あり |

* **URL内でも置換変数が使える**（例: `https://example.com/notify?msg={message}`）。URL文脈では `encodeURIComponent` でエスケープする。GET/DELETEはこれが実質的なデータ渡し手段になる

### 4.3. エラー制御（最小限）

投げっぱなし方針のため、以下のみ行う。

* 全登録分を `Promise.allSettled` で並列送信（FCM・Discordと同列に合流）
* タイムアウト **5秒**（`AbortSignal.timeout(5000)`）— Edge Functionの実行時間を守るため
* 失敗時は `console.error` にログを残すだけ。リトライ・無効化・ユーザーへのフィードバックは**しない**

## 5. データモデル

### 5.1. `user_webhooks` テーブル（新設）

複数登録のため専用テーブルとする。用途がWebhook単一のため、`bot_function_spec.md` の `user_integrations`（タイプ＋JSONB）案は採らず、**明示カラム**のシンプルな構造にする。

```dbml
Table user_webhooks {
  id uuid [pk, default: `gen_random_uuid()`]
  user_id uuid [not null, ref: > users.id, note: 'on delete cascade']
  label text [note: '設定UI表示用の任意名']
  url text [not null, note: 'https:// のみ']
  method varchar [not null, default: 'POST', note: "check: POST | PUT | GET | DELETE"]
  body_template text [note: '置換変数入りBodyテンプレート']
  enabled boolean [not null, default: true]
  created_at timestamptz [not null, default: `now()`]
}
```

### 5.2. RLS

```sql
alter table user_webhooks enable row level security;

-- 本人のみ全操作可能（Edge Function は service_role で RLS を越えて読む）
create policy "Users can manage their own webhooks"
  on user_webhooks for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

## 6. 変更箇所一覧

| レイヤ | 変更内容 |
| --- | --- |
| DB | `user_webhooks` テーブル新設＋RLS（§5） |
| Edge Function | `send-push-notification` に「`user_webhooks` 取得 → 変数置換 → 送信」を追加（§4）。新規Secretsなし |
| `services/supabase.ts` | `user_webhooks` のCRUDメソッド追加（list / upsert / delete） |
| `ui/controller.ts` + `index.html` | 環境設定モーダルに「カスタムWebhook」セクション追加。エントリのリスト表示＋追加/編集/削除/有効トグル。編集フォームは ラベル・URL・メソッド(select)・Bodyテンプレート(textarea)。置換変数一覧をフォーム内に注記表示 |
| `app.ts` | 設定保存ハンドラの配線 |

既存の Discord Webhook UI・ロジックには**手を入れない**。

### 6.1. ついで変更: 設定画面最下部へのアプリアイコン表示

本機能とは無関係だが、設定モーダルを触るついでに行う小変更。

* **内容**: 設定モーダル最下部（`.settings-footnote` 内、ログアウト行の下）にアプリアイコン `public/chatora.png` を表示する
* **サイズ・体裁**: 幅 64px 程度・中央寄せ・角丸。装飾のみでクリック動作は持たせない（`aria-hidden` 相当の扱い）
* **変更箇所**: `index.html`（`<img>` 1行追加）＋ `style.css`（クラス1つ追加）のみ。TS変更なし

## 7. 利用例: GASによるメール転送（README向け・上級者向け）

ユーザーが自分のGoogleアカウントで以下のGASを「Webアプリ（全員がアクセス可）」としてデプロイし、`/exec` URLを登録する。

登録するテンプレート例:

```json
{ "message": "{message}", "from": "{username}", "community": "{community}", "link": "{url}" }
```

GAS側:

```javascript
function doPost(e) {
  const p = JSON.parse(e.postData.contents);
  GmailApp.sendEmail(
    'notify@example.com',
    `[Chatransceiver] ${p.community} - ${p.from}さんの投稿`,
    `${p.message}\n\n👉 アプリで開く: ${p.link}`
  );
  return ContentService.createTextOutput('OK');
}
```

* GASの `/exec` はPOSTに302を返すが、Denoの `fetch` は自動追従するため問題ない（成否は厳密に取れない前提＝投げっぱなし方針と整合）
* スクリプト更新時は「既存デプロイの更新」を使う（URLが変わらない）
* Gmail送信上限: 無料アカウント100宛先/日、Workspace 1,500宛先/日

## 8. セキュリティ・制約

* **信頼モデル**: URL自体をシークレットとする方式。既存の `discord_webhook_url` と同一の信頼レベル。堅牢化したいユーザーはテンプレートに自前の固定トークンを書けばよい（例: `{"token":"xxxx", ...}` — アプリ側の追加機能は不要）
* **SSRF**: 送信元はSupabase Edge Function。`https://` 限定のバリデーションのみ行い、宛先制限はしない（Discord Webhookと同等の扱い）
* **悪用抑制**: 登録上限5件＋タイムアウト5秒。着信1件あたり最大5リクエストで打ち止め
* **注意事項（README記載）**: 本文がそのまま外部URLへ送信されるため、登録は自己責任。信頼できる自分のエンドポイントのみ登録すること

## 9. 見送り事項（本仕様のスコープ外）

* ボット振る舞い（`is_bot`・自動返信・ループ防止）→ `bot_function_spec.md` ごと見送り
* Content-Type の指定、カスタムヘッダー（認証ヘッダー等）
* 送信結果の表示・リトライ・失敗時の自動無効化
* テスト送信ボタン（あると便利だが v1 では見送り。要望があれば追加）
* 反応条件フィルタ（正規表現マッチ時のみ送信）
* 既存 Discord Webhook の本テーブルへの統合移行
