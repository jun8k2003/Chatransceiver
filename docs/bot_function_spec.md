# ボット機能・外部連携 仕様案 (docs/bot_function_spec.md)

* **ステータス**: 🚧 議論中（ドラフト） — 確定後に specifications.md / decisions.md へ反映する
* **作成日**: 2026-07-02（同日、概念モデルを「外部連携」と「ボット振る舞い」に分離する形へ再構成）
* **ブランチ**: `2026-07-02-bot-function`

---

## 1. 概念モデル: 「外部連携」と「ボット振る舞い」は直交する

本機能は当初「ボット機能」として一体で構想したが、議論の結果、**2つの独立した概念**に分離して設計する。

### 1.1. 外部連携 (User Integrations) — 全ユーザーが使える機能

「自分のInboxへの着信を、外部チャネルへ届ける」設定。**ボット専用ではない**。

* 既存の `discord_webhook_url`（Discord Webhook通知）はまさにこれであり、すでに全ユーザーが使える
* 本仕様で **汎用 Webhook 連携** を追加する。ユーザーが用意した任意のURLへ、着信メッセージ情報のJSONをPOSTする。「ユーザーが自分で用意したURLをアプリに登録し、Edge FunctionがそこへPOSTする」という点で **Discord Webhook と完全に同型**
* メール送信はこの汎用Webhookの利用例として実現する: ボット運用者が **GAS（Google Apps Script）のWebアプリ**を自作・登録し、GAS側で `GmailApp.sendEmail()` する（§4.2）。ボット用Gmailアカウントから正真正銘のGmail送信になる（外部メールベンダー非依存・送信済みフォルダにも残る）
* 将来の LINE・Teams 対応も、アプリの機能追加ではなく **「Webhook先（GAS等）のレシピ追加」** で実現できる

| 連携チャネル | 状態 | 備考 |
| --- | --- | --- |
| FCM プッシュ通知 | ✅ 既存 | 端末単位（`fcm_tokens`）のため外部連携テーブルとは別管理を維持 |
| Discord Webhook | ✅ 既存 | `users.discord_webhook_url` → 将来 `user_integrations` へ移行 |
| **汎用 Webhook** | 🆕 本仕様で追加 | 登録URLへ着信情報のJSONをPOST。**メール送信（GAS経由）**が第一の利用例 |
| LINE / Teams / その他 | 🔮 将来 | 汎用WebhookのGASレシピとしてユーザー側で実現可能（アプリ変更不要）。専用タイプの追加は需要が出たら検討 |

### 1.2. ボット振る舞い (`is_bot`) — アカウントの「振る舞いの規定」

`users.is_bot` フラグは外部連携とは独立に、**そのアカウントがボットとして振る舞うこと**を規定する。

1. **自動返信**: 自分のInboxに着信し外部連携を実行したとき、その結果（「メールを転送しました」等）をチャットに自動返信で報告する
2. **ループ防止の遮断対象**: ボットはボットの発言に反応しない（§2.3）。ボット発言はボットのInboxに配送されない
3. **表示**: メンバーリスト等で 🤖 バッジを表示する

つまり「人間ユーザー＋外部連携」= 通知、「ボットユーザー＋外部連携」= 転送＋チャットへの報告、という**同じ仕組みの使い分け**になる。

### 1.3. 「ボット＝通常ユーザー」方針（変更なし）

ボットを特別なエンティティにせず、**通常のユーザーアカウント**とする。

* ボット用のメールアドレス（Gmail等）でアカウントを新規作成（Google / Magic Link どちらでも可）
* 招待リンク等、**既存の参加フローをそのまま使って**コミュニティ・グループに参加
* 設定は「ボットアカウント本人としてログインし、既存の環境設定画面で行う」
* 専用の参加フロー・ボット管理画面・管理者ロールは**作らない**（「メンバーなら誰でもグループ削除・名前編集可」というフラットな権限思想と一貫）

---

## 2. アーキテクチャ

### 2.1. 現状の受信パイプライン（前提知識）

```
messages INSERT
  └─ DBトリガー handle_new_message_fanout (SECURITY DEFINER)
       └─ user_inboxes INSERT（部屋メンバー全員、送信者除く）
            ├─ Realtime (subscribeInbox) → クライアントの自動再生・未読バッジ
            └─ Database Webhook → Edge Function send-push-notification
                 ├─ FCM プッシュ
                 └─ Discord Webhook
```

重要な点: **自動再生・未読・通知（＝外部連携）はすべて `user_inboxes` 起点**。チャットウィンドウの表示のみ `messages` の Realtime 購読（`subscribeRoomMessages`）で独立している。

### 2.2. 変更後のパイプライン — Edge Function は1本のまま拡張する

概念モデルの分離により、**新規Edge Functionは作らず、既存の `send-push-notification` を「Inbox処理関数」として拡張する**（Webhookは現状の1本のまま）。

```
messages INSERT
  └─ DBトリガー handle_new_message_fanout（★ループ防止条件を追加）
       └─ user_inboxes INSERT
            ├─ Realtime → 自動再生・未読（変更なし）
            └─ Webhook → send-push-notification（★拡張）
                 ├─ 受信者の外部連携を実行: FCM / Discord / メール🆕（全ユーザー共通）
                 └─ 受信者が is_bot なら🆕: 実行結果をまとめた自動返信を
                    messages に INSERT（service_role、sender_id=ボット）
                      └─ 通常のファンアウトが走り、人間メンバーに自動再生・通知が届く
```

1本化の利点:

* 自動返信が「実際に何の連携を実行し、成功/失敗したか」を**その場で知っている**ため、正確な報告ができる
* Webhook追加・Function間の責務調整が不要。Inbox INSERTごとの起動回数も増えない

> 関数名が実態（Inbox着信処理全般）と乖離していくため、将来的なリネーム（例: `process-inbox-event`）は検討事項。ただしリネームはWebhook再設定を伴うため v1 では行わない。

### 2.3. ループ防止設計

**ルール: 「ボットはボットの発言に反応しない」**（2026-07-02 合意済み）

「ボット返信はファンアウト対象外」とはしない。自動再生・未読・外部連携がすべて `user_inboxes` 起点のため、ファンアウトを丸ごと止めると人間メンバーがボット返信を耳で受け取れなくなる。ファンアウトは通常どおり行い、以下の二重防御でループを断つ。

1. **ファンアウトトリガー（1次防御）**: `handle_new_message_fanout` を修正し、**送信者がボットの場合、受信者がボットの行を作らない**。

   ```sql
   -- 修正後のファンアウト条件（概略）
   insert into public.user_inboxes (user_id, room_id, message_id, is_read)
   select m.user_id, new.room_id, new.id, false
   from public.chat_room_members as m
   join public.users as sender on sender.id = new.sender_id
   join public.users as recipient on recipient.id = m.user_id
   where m.room_id = new.room_id
     and m.user_id != new.sender_id
     and not (sender.is_bot and recipient.is_bot);  -- ★ ボット→ボットの配送を遮断
   ```

2. **Edge Function（2次防御）**: 自動返信の投稿は、処理中のメッセージの送信者が `is_bot = true` の場合は行わない。トリガー修正の漏れ・巻き戻しがあっても無限ループに至らない保険。

この方式の帰結（意図した制約）:

* ボット→ボットの連鎖（自分自身への反応を含む）は**構造的に不可能**
* 複数ボットが同じグループにいる場合、人間の発言には**全ボットがそれぞれ反応**する（これは正しい挙動）
* ボット同士を連携させるパイプラインは**明示的に非対応**と割り切る

#### 動作トレース（2026-07-02 議論で確認済み）

ボットの外部連携（Discord転送・メール送信）は「ボットのInboxに行が入ること」が起点である点がポイント。

1. **① 人間Aが投稿** → 送信者が人間なので遮断条件は働かず、ボット含む全メンバーのInboxに行が入る
2. **② ボットが反応** → ボットのInbox行を起点に外部連携（Discord転送・メール送信）が実行される
3. **③ ボットが「転送したよ」と自動返信** → 送信者がボットのため、**ボットのInbox行は一切作られない**（人間の行は作られる）→ Inbox行がないので②は発動しない。**③はDiscordにもメールにも送られない**
4. 人間メンバーには③のInbox行が入るため、自動再生（TTS）・未読・FCM・**人間自身の外部連携（Discord等）**は通常どおり届く

複数ボット（B1・B2）が同居する場合:

| イベント | B1 | B2 |
| --- | --- | --- |
| ① Aの投稿 | Inbox行あり → 反応（転送＋返信③₁) | Inbox行あり → 反応（転送＋返信③₂） |
| ③₁ B1の返信 | （送信者なので対象外） | **Inbox行なし → 反応しない** |
| ③₂ B2の返信 | **Inbox行なし → 反応しない** | （送信者なので対象外） |

副次的な帰結: **ボットの外部連携チャネル（Discord転送先・メール宛先）には人間の投稿だけが流れる**（自分・他ボットの返信は転送されない）。転送チャンネルがボットの報告でノイズ化しない反面、「ボット返信も含む全ログを外部へ」という用途には合わない。

---

## 3. データモデル変更

### 3.1. `users.is_bot` フラグの追加

```sql
alter table users add column is_bot boolean not null default false;
```

* **設定方法**: 環境設定画面に「ボットモード」トグルを追加し、本人（そのアカウントでログインした人）が自分で ON/OFF する。自己申告制。
* 他人のアカウントをボット化することはできない（既存 RLS「自分のプロフィールのみ更新可」の範囲内）。
* `is_bot` は全ユーザーが参照可能（既存の「全プロフィール参照可」ポリシーのまま）→ UI での 🤖 バッジ表示・遮断トリガーで使う。

### 3.2. `user_integrations` テーブルの新設（外部連携の一元管理）

外部連携はボット専用ではなく全ユーザーの機能のため、テーブル名も `bot_actions` ではなく `user_integrations` とする。チャネル追加に耐える**タイプ＋JSONB設定**の構造。

```dbml
Table user_integrations {
  id uuid [pk, default: `gen_random_uuid()`]
  user_id uuid [not null, ref: > users.id]
  integration_type varchar [not null, note: 'webhook | discord | ...（拡張可能）']
  config jsonb [not null, note: 'チャネルごとの設定（POST先URL等）']
  enabled boolean [not null, default: true]
  created_at timestamptz [default: `now()`]
}
```

`config` の例:

```json
{ "url": "https://script.google.com/macros/s/xxx/exec", "label": "メール転送" } // integration_type = 'webhook'
{ "webhook_url": "https://discord..." }                                        // integration_type = 'discord'（移行後）
```

* `label` は自動返信の報告文（「メール転送に送信しました」等）と設定UIでの表示に使う任意の名前

RLS:

```sql
alter table user_integrations enable row level security;

-- 本人のみ全操作可能（Edge Function は service_role で RLS を越えて読む）
create policy "Users can manage their own integrations"
  on user_integrations for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

移行方針:

* **v1**: `email` タイプのみ `user_integrations` で新規追加。既存の `users.discord_webhook_url` と `fcm_tokens` は現状のまま併存（動いているものを触らない）
* **v2以降**: `discord_webhook_url` を `user_integrations` の `discord` タイプへ移行し、列を廃止。FCM は端末単位（device_uuid）の性質が異なるため `fcm_tokens` のまま維持

### 3.3. 自動返信の設定

自動返信は「ボットの振る舞い」そのものなので、**v1 では `is_bot = true` なら常に有効**とする（個別のON/OFF列は設けない）。返信の粒度・抑制は課題 O-2 の議論結果で見直す。

---

## 4. Edge Function: `send-push-notification` の拡張

### 4.1. 処理フロー（拡張後）

1. `payload.type !== 'INSERT'` なら終了
2. 受信者（`record.user_id`）の `users`（`is_bot`, `discord_webhook_url`）、`fcm_tokens`、`user_integrations`（enabled のみ）を取得
3. メッセージ詳細と送信者を取得
4. **外部連携の実行**（全ユーザー共通、Promise.allSettled）:
   * FCM プッシュ（既存ロジックそのまま）
   * Discord Webhook（既存ロジックそのまま）
   * `user_integrations` の各行を `integration_type` で分岐して実行（v1: `webhook`）
5. **自動返信**（`受信者.is_bot = true` かつ **送信者.is_bot = false**（2次防御）の場合のみ）:
   * 手順4の実行結果をまとめた返信を 1 通、`messages` に INSERT（service_role、`sender_id = ボットのuser_id`、`text_content` のみ・`audio_url` は NULL）
   * 例: `📧 メールに転送しました` ／ 複数実行時は `📧 メール・💬 Discord に転送しました` のように集約
   * 失敗時の文言（`⚠️ メール転送に失敗しました`）を返すかは課題 O-4

### 4.2. `webhook` 連携の内容（O-1 で決定）

Edge Function は `config.url` へ以下のJSONを `fetch` で POST するだけ（Discord 連携とほぼ同型の実装）。**アプリ側に外部メールベンダーの API キーは不要**（新規 Secrets の追加なし）。

```json
{
  "communityName": "...",
  "senderName": "...",
  "text": "...",            // 音声のみの場合は "🎤 音声メッセージ"
  "messageType": "audio | text",
  "url": "https://chatransceiver13162.web.app/?c=slug&m=messageId"
}
```

#### メール送信の実現方法: GAS（Google Apps Script）Webアプリ

ボット運用者が、ボット用 Gmail アカウント上で以下のような GAS を「Webアプリ（全員がアクセス可）」としてデプロイし、その `/exec` URL を `webhook` 連携として登録する。

```javascript
const SECRET = 'ランダムな文字列'; // 任意の堅牢化（URLの秘匿がDiscord Webhookと同じ信頼モデルなので必須ではない）

function doPost(e) {
  const p = JSON.parse(e.postData.contents);
  if (SECRET && p.token !== SECRET) return ContentService.createTextOutput('NG');
  GmailApp.sendEmail(
    'notify@example.com', // 転送先（複数可）
    `[Chatransceiver] ${p.communityName} - ${p.senderName}さんの投稿`,
    `${p.text}\n\n👉 アプリで開く: ${p.url}`
  );
  return ContentService.createTextOutput('OK');
}
```

* **送信元がボットのGmailそのもの**になる（外部ベンダーの「via」表記なし、送信済みフォルダにも記録が残る）
* **レートリミット**: 無料Gmailアカウントは **100宛先/日**（宛先数カウント: 1通×10宛先=10消費。初回送信から24hでリセット。`MailApp.getRemainingDailyQuota()` で残量確認可）。Google Workspace アカウントなら1,500宛先/日
* **運用上の注意**:
  * GAS の `/exec` は POST に 302 を返すが、Deno の `fetch` は自動追従するため実装上は問題なし。成否は厳密に取れない前提で設計する（→ O-4）
  * スクリプト更新時は「新しいデプロイ」ではなく**既存デプロイの更新**を使う（URLが変わらない）
  * 初回実行時に GmailApp スコープの OAuth 同意が必要
* **セキュリティモデル**: URL自体をシークレットとする方式で、既存の `discord_webhook_url` と同一の信頼レベル。堅牢化したい場合はペイロードに `token` を含める（`config.token` を設けて Edge Function が付与）

### 4.3. 将来拡張（v2 以降、本仕様では実装しない）

* **LINE / Teams / その他への転送**: 汎用 `webhook` のGAS（または任意のエンドポイント）レシピとしてユーザー側で実現可能（アプリ変更不要）。専用 `integration_type` の追加は需要が出たら検討
* **非開発者向けのメール連携**: GAS方式は運用者にデプロイ作業を要求する。将来「メアド入力だけで使えるメール通知」を一般ユーザーに開放したくなった場合は、**Brevo**（無料枠 300通/日、シングルセンダー検証だけで任意宛先に送信可、REST 1本）による中央集約方式を再検討する（旧O-1の調査結果を保持）
* **ボットの反応条件フィルタ**: `config.filter_regex` — TTT のウェイクワード（正規表現）と同じ思想で、マッチした投稿にのみ反応
* チャネル追加は「`integration_type` の追加＋ Edge Function の分岐追加＋設定 UI 追加」で完結する構造とする

---

## 5. UI 変更

### 5.1. 環境設定モーダル

* **「🔗 外部連携」セクション（全ユーザー向け）**: 既存の「通知」まわりを再編
  * FCM プッシュ通知の許可（既存）
  * Discord Webhook URL（既存）
  * **Webhook 連携: POST先URL＋表示名（label）＋有効/無効** 🆕（メール転送用GASのURL等を登録）
* **「🤖 ボット」セクション**:
  * **ボットモードトグル**（`users.is_bot`）＋ 挙動の説明文（「着信に反応して外部連携を実行し、結果をチャットに自動返信します。ボットはボットの発言には反応しません」）
* 既存の設定モーダルのセクション構造・トグルスイッチの流儀（DEC-024）に従う

### 5.2. メンバーリスト・チャット表示

* `is_bot = true` のユーザーには名前の横に 🤖 バッジを表示（統合リスト・チャットバブル・再生中インジケータ）
* それ以外の表示・挙動は通常ユーザーと完全に同一（`#番号 ニックネーム` 形式、Presence など）

### 5.3. 運用フロー（画面追加なしで成立することの確認）

1. ボット用メールアドレスでアカウント作成（既存のログインフロー）
2. ボットとしてログインし、環境設定で「外部連携（メール宛先等）＋ボットモード ON」
3. 招待リンクでコミュニティ参加（既存フロー、ユーザー番号も普通に発番）
4. 人間側の操作で「＋新規グループ」からボットを含むグループを作成（既存フロー）
5. 以後、そのグループへの投稿にボットが反応する

> **注意（DEC-011 の帰結）**: グループの同一性はメンバー構成で決まるため、**既存グループにボットを後から追加することはできず、ボットを含む新しいグループを作ることになる**。既存の仕様どおりの挙動であり、ボット導入時の運用として明記しておく。

---

## 6. クリアすべき課題（Open Issues）

| # | 課題 | 論点 |
| --- | --- | --- |
| ~~O-1~~ | **✅ 決定: メール送信は汎用 Webhook 連携＋GAS 自作**（2026-07-03 改訂） | 経緯: ①Resend は独自ドメイン未検証だと送信先がアカウント所有者自身のみで、独自ドメインを取得しない方針のため不成立。②Brevo（無料枠 300通/日、シングルセンダー検証のみで任意宛先可）に一旦決定したが、③送信元がボットのGmailである以上、**GASでメール送信Webアプリを自作すれば外部ベンダー依存自体を消せる**と判断し改訂。GAS方式は Discord Webhook と同型の「URL登録＋POST」で、アプリ側に新規 Secrets 不要・汎用Webhookとして拡張性も最大。レートリミットは無料Gmailで100宛先/日（十分と判断）。詳細は §4.2。※調査記録: SendGrid は無料枠2025年5月廃止。Brevo は非開発者向け開放時の再検討候補として §4.3 に保持 |
| O-2 | **自動返信の TTS 読み上げの冗長さ** | ボット返信は人間側で毎回 TTS 読み上げされる。頻繁な投稿があるグループでは「メールに転送しました」が繰り返し流れてうるさい可能性。返信文を極力短くする／自動返信を任意設定にする／将来はフィルタ（4.3）で反応頻度自体を絞る、のどれで対処するか。人間ユーザーの外部連携（メール通知）でも、ボット返信がそのまま通知される点は同種の考慮 |
| O-3 | **レート制御** | 連投時にメールが 1 投稿=1 通で飛ぶ。プロバイダ無料枠の枯渇や宛先のメールボックス圧迫への対策（クールダウン、ダイジェスト化）を v1 で入れるか、割り切るか |
| O-4 | **連携失敗時の挙動** | ボットの場合: 失敗をチャットに返信して知らせるか（ノイズ増）、静かに失敗してログのみにするか。人間の場合: 現状の Discord 同様ログのみで良いか |
| O-5 | **is_bot 自己申告制の妥当性** | 誰でも自分のアカウントをボット化できる。影響範囲は自分のアカウントの振る舞いのみなので問題ないと考えるが、悪用シナリオ（例: ボットを装った人間／人間を装ったボット）を許容するか確認 |
| O-6 | **音声のみメッセージへの反応** | 録音モード「録音のみ」では `text_content` が空。メール本文・自動返信に内容が載らない（`🎤 音声メッセージ` ＋リンクのみ）。v1 はこれで割り切るか。将来 DEC-025 の知見（サーバー側TTS/STT）と絡めるか |
| O-7 | **ボット退会時のクリーンアップ** | 既存仕様（3.5 退出フロー）どおり、ボットが退会するとボットが含まれる全ルームと全メッセージが消える。ボット運用停止＝履歴消滅で良いか（トランシーバー思想的には一貫しているが、意識しておく） |

> **解消済み（2026-07-02 の概念モデル再構成による）**: 旧O-6「Edge Function呼び出し回数の増加」→ 1本化により消滅。旧O-7「既存通知設定との関係整理」→ 外部連携として一元化する方針に決定（`discord_webhook_url` の移行はv2）。

---

## 7. 段階的実装案

* **Phase 1（MVP）**:
  * `users.is_bot` 追加＋ファンアウトトリガーのループ防止修正
  * `user_integrations` テーブル＋ RLS
  * `send-push-notification` 拡張（`webhook` 連携＋ボット自動返信）
  * メール転送用 GAS の作成・デプロイ（アプリ外・ボット運用者の作業。サンプルは §4.2）
  * 設定 UI（外部連携セクション再編＋Webhook URL登録、ボットモードトグル）、🤖 バッジ
* **Phase 2**: ボットの反応条件フィルタ（正規表現）、失敗時挙動・レート制御の改善、`discord_webhook_url` の `user_integrations` への移行
* **Phase 3**: LINE / Teams 連携

---

## 8. 変更対象ファイル一覧（見込み）

| 対象 | 変更 |
| --- | --- |
| DB マイグレーション | `users.is_bot` 追加、`user_integrations` 新設＋RLS、`handle_new_message_fanout` 修正 |
| `supabase/functions/send-push-notification/` | 外部連携実行の一般化（`webhook` 追加）＋ボット自動返信の追加 |
| Supabase ダッシュボード | **変更不要**（新規 Secrets・Webhook 追加なし） |
| GAS（アプリ外） | メール送信 Web アプリの作成・デプロイ（ボット運用者の作業、サンプル §4.2） |
| `src/services/supabase.ts` | `is_bot`・`user_integrations` の取得/更新 API |
| `src/ui/controller.ts` ほか設定 UI | 外部連携セクション再編＋ボットセクション追加 |
| `src/ui/list.ts` / `src/ui/chat.ts` | 🤖 バッジ表示 |
| `docs/database_design.md` / `specifications.md` / `decisions.md` | 確定後に反映 |
