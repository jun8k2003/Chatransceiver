# 音声メッセージの事後文字起こし（Google Speech-to-Text）仕様案 (docs/stt_transcription_spec.md)

* **ステータス**: 🛠 コード実装済み（DEC-036）。DBマイグレーション適用・Database Webhook設定・GCP APIキー発行・Edge Functionデプロイはユーザーの手作業が未実施（[setup_backend.md §8.3](./setup_backend.md#83-音声メッセージの事後文字起こし対応-2026-08-03-仕様-stt_transcription_specmd)参照）
* **作成日**: 2026-08-03
* **経緯**: Web Speech API（`SpeechRecognition`）による文字起こしは現状PCのみ対応（README）。スマホ、または環境設定で録音モードを「録音のみ (`audio_only`)」にした場合、送信された音声メッセージには実際の発話内容ではなく固定のプレースホルダー文字列（`🎤 音声メッセージ` / `（音声メッセージ）`）が入る。これをGoogle Cloud Speech-to-Textで事後的に文字起こしし、`messages.text_content` を書き換える。

---

## 1. 概要

* 対象は「音声はあるが、実際の発話内容が文字起こしされていないメッセージ」。
* メッセージ送信（`messages` INSERT）を契機に、非同期でGoogle Speech-to-Textへリクエストし、結果が届いたら該当メッセージの `text_content` を書き換える。
* **送信フローとは非同期**（メッセージ送信のレスポンスをブロックしない）。
* **月200リクエストの上限**を設け、超過したら文字起こしを静かにスキップする（エラー・警告・ユーザー通知は一切行わない）。
* **失敗時のリカバリは行わない**。一度失敗した（またはスキップされた）アイテムは、二度と文字起こしされない。

## 2. 対象メッセージのマーキング

### 2.1. 既存実装の課題

現状、`text_content` は音声のみの送信でも必ず固定文字列で埋まっており（[app.ts:1147-1150](../src/app.ts#L1147)）、`NULL`にはならない。

* `audio_only` モード → `'🎤 音声メッセージ'`
* `both` モードで音声認識が失敗（モバイル等） → `'（音声メッセージ）'`

この固定文字列との一致で対象判定を行う方法は、UI文言の変更で対象判定が壊れる脆弱な設計になるため採らない。

### 2.2. 決定：専用カラムによるマーキング

`messages` テーブルに以下のカラムを追加する。

```dbml
Table messages {
  ...（既存カラム）
  needs_transcription boolean [not null, default: false, note: '音声はあるが実発話内容が未文字起こし。事後STTの対象フラグ']
}
```

* **セット条件**: 送信時（[app.ts](../src/app.ts) の `handleStopTalk` 〜 `handleSendAudio` 相当の箇所）に、「音声Blobが存在し、かつ音声認識結果（`recognizedText`）が空だった」場合に `true` としてクライアントから送信する。
  * `audio_only` モード（そもそも認識を試みない） → 常に `true`
  * `both` モードで認識失敗（モバイル等） → `true`
  * `both` モードで認識成功、`text_only` モード → `false`
* 事後STTが完了（またはスキップ確定）したら `false` に戻し、以後の対象から外す（§4.4）。

## 3. トリガーの起点

### 3.1. 既存パイプラインとの違い

既存の通知系 Edge Function（`send-push-notification`）は `user_inboxes` INSERT を起点にしている（[send-push-notification/index.ts](../supabase/functions/send-push-notification/index.ts)）。これはメッセージ受信者の人数分ファンアウトして複数行INSERTされるため、**グループチャットでは同一メッセージに対して複数回起動する**。

文字起こしは1メッセージにつき1回で十分なため、`user_inboxes` 経由には乗せず、**`messages` テーブルのINSERTを直接起点**とする新規のDatabase Webhookで、新規Edge Function `transcribe-audio-message` を直接呼び出す。

```
messages INSERT
  └─ Database Webhook（GUI設定・条件なし。既存の delete-audio-on-message-delete と同じ手順）
       └─ transcribe-audio-message 🆕
            ├─ 対象外チェック（audio_url IS NULL または needs_transcription = false）
            │   └─ 対象外 → 何もせず正常終了
            ├─ APIキー未設定チェック（§4.0）
            │   └─ 未設定 → 何もせず正常終了（needs_transcription はtrueのまま残す）
            ├─ 月間リクエスト数チェック（§4.1）
            │   └─ 上限到達 → 何もせず終了（needs_transcription はtrueのまま残す。§4.4で再検討）
            ├─ Google Speech-to-Text 同期 recognize 呼び出し（§4.2）
            └─ messages.text_content / needs_transcription を UPDATE（§4.4）
```

> **実装メモ**: 当初案ではDBトリガーのWHEN句で対象を絞り込む想定だったが、実装時にEdge Function側の先頭で判定する方式に変更した（§4.0参照の理由と同様、サービスロールキー等の秘密情報をSQLトリガーに埋め込む必要がなく、既存のGUI手順だけで完結するため）。Webhookは `messages` への全INSERTで発火するが、対象外メッセージはEdge Function冒頭で即座に終了するためコスト増は軽微。

## 4. 処理仕様

### 4.0. APIキー未設定時の扱い（機能の未有効化）

Edge Functionの処理の**最初**に、`Deno.env.get('GOOGLE_STT_API_KEY')` が未設定・空文字でないかをチェックする。

* **未設定の場合**: 「機能が有効化されていない」通常の状態として扱い、**それ以上何もせず処理を終了する**（Google STTへのリクエストは行わない）。
  * `console.error` 等のエラーログは出さない（設定不備ではなく想定内の状態のため。デプロイ直後や、§9の手作業がまだ完了していない期間はこの状態になるのが自然）。
  * `stt_usage_log` への追記は行わない（実際にGoogleへリクエストしていないため）。
  * `messages.needs_transcription` は `true` のまま変更しない（後日APIキーが設定された場合に備え、「まだ処理されていない」状態を保持する。ただし本仕様には自動的な再処理の仕組みはないため、実際に再処理するには別途手動のバックフィルが必要）。
  * HTTPレスポンスは `200 OK` を返す（Database Webhook側からは「正常終了」として扱われるようにし、Supabase側にエラーとして記録・再試行されないようにする）。
* この挙動により、**Edge Functionのデプロイ・DBトリガーの設置は、GCP側のAPIキー発行（§9）が完了する前に行っても安全**（文字起こしが行われないだけで、エラーやアプリの動作への悪影響は生じない）。

### 4.1. 月間リクエスト数の制御（追記ログ方式）

行を競合を気にしながらインクリメント更新するのではなく、**リクエストの都度1行追記し、判定時に `COUNT(*)` で集計する**方式を採る。

```dbml
Table stt_usage_log {
  id bigint [pk, increment]
  created_at timestamptz [not null, default: `now()`]
}
```

* 判定: `SELECT count(*) FROM stt_usage_log WHERE created_at >= date_trunc('month', now() at time zone 'utc')` が **200未満** なら実行する。
* ログの記録タイミング: **Google Speech-to-Text へリクエストを送信する直前**（成否に関わらず「呼び出した事実」を記録する）。実際のGoogle側の消費実態に忠実な数値になる。
* **同時実行による多少の超過（201・202件等）は許容する**。厳密なアトミック制御（行ロック等）は行わない。素朴な「カウント→200未満なら実行→1行追記」で十分とする。
* 月をまたぐと `created_at` の範囲判定により自動的に0件からカウントが再開する。リセット用のcronジョブは不要。
* テーブルの増加は月200行ペース（年間2400行程度）で無視できる規模。`created_at` にインデックスを張っておけば集計コストも問題にならない。

**無料枠との関係**: 1リクエストあたり最大15秒、200リクエスト/月 ＝ 最大50分/月。Google Cloud Speech-to-Textの無料枠（月60分）に対して妥当なマージン。

### 4.2. Google Speech-to-Text 呼び出し

* 音声は最長15秒のため、**同期 `speech:recognize` API**（60秒未満の音声が対象）で完結させる。`LongRunningRecognize`（非同期ジョブ＋ポーリング/コールバック）のような構成は不要。
* **認証はAPIキー方式**を採用する（`?key=API_KEY` をエンドポイントに付与）。Speech-to-Text APIのみに制限したAPIキーをSupabase Edge Functionのsecret（例: `GOOGLE_STT_API_KEY`）として保持する。
  * 参考: `send-push-notification` はFirebaseサービスアカウントのJWT/OAuth2方式を使っているが、本機能ではより単純なAPIキー方式で足りると判断。
* 音声エンコーディング: アップロードされる音声は `audio/webm`（[manager.ts:98](../src/audio/manager.ts#L98) の `MediaRecorder`、Opusコーデック想定）。Google STTの `WEBM_OPUS` エンコーディング指定で扱える見込み（実装時に実際のコーデック/サンプルレートを要確認）。
* `languageCode: 'ja-JP'` を指定する。
* Edge Functionは対象メッセージの `audio_url` からStorage上の音声ファイルを取得し、Google STTへ送信する。

### 4.3. 処理対象の特定とID受け渡し

* DBトリガー（Database Webhook）のpayloadから対象メッセージの `id`（`record.id`）を取得する。
* Google STTへのリクエストとレスポンス紐付けは、Edge Function内で当該メッセージIDに対して同期的に`await`する範囲で完結するため、追加の相関ID管理は不要。

### 4.4. 結果の書き戻し

```sql
UPDATE messages
SET text_content = $recognizedText, needs_transcription = false
WHERE id = $messageId AND is_revoked = false;
```

* **取り消し（revoke）とのレース対策**: メッセージ取り消しは `text_content` / `audio_url` を `NULL` にする（[supabase.ts:699-705](../src/services/supabase.ts#L699)）。事後STTの結果書き込みが取り消しより後に届くと、取り消し済みメッセージにテキストが復活してしまう恐れがあるため、`WHERE is_revoked = false` で必ずガードする。
* **認識結果が空文字だった場合**（無音・雑音等でGoogle側が何も認識できなかった）: `text_content` は書き換えず（プレースホルダー文言のまま）、`needs_transcription = false` のみ更新して対象から外す（無限に再試行対象になり続けることを防ぐ）。

### 4.5. 失敗時の扱い

本節は「APIキーは設定済みで、実際にGoogle STTへリクエストを送った後に失敗した」場合の扱い。APIキー未設定そのものは§4.0を参照（エラー扱いにしない）。

* GCPへのリクエストが失敗（ネットワークエラー、Google側エラー等）した場合、**リトライは行わない**。
* `needs_transcription` は `true` のまま残すか `false` にするかは実装時に決定するが、**いずれにせよ再試行の仕組みは持たない**ため実質的な挙動差はない（既定は `false` にして「二度と対象にならない」ことを明確にする方向で検討）。
* エラーはEdge Functionのログ（`console.error`）にのみ残し、ユーザーへの通知・アプリ側へのエラー表示は一切行わない。

## 5. フロント側への影響

`subscribeRoomMessages` は `messages` テーブルの `event: '*'`（INSERT/UPDATE/DELETE全て）をRealtime購読しており、取り消し機能の `UPDATE` 反映にも使われている（[supabase.ts:762-789](../src/services/supabase.ts#L762)）。

Edge Functionが `text_content` を `UPDATE` すれば、**開いているチャット画面には既存の仕組みで自動的に反映される見込み**であり、フロント側（`app.ts` / `ui/*`）への追加実装は基本的に不要と想定する。

* 送信時に `needs_transcription` フラグをセットして `sendMessage()` に渡す変更のみ、フロント側（`app.ts` / `services/supabase.ts`）に必要（§2.2）。
* 事後書き換えを自動再生・TTS読み上げの対象にするかどうかは本仕様のスコープ外（見送り、§7）。

## 6. データモデル変更まとめ

| テーブル | 変更内容 |
| --- | --- |
| `messages` | `needs_transcription boolean not null default false` を追加 |
| `stt_usage_log`（新設） | `id bigint pk`, `created_at timestamptz default now()` のみ。RLSは有効化のうえservice_roleのみアクセス可（Edge Functionからのみ書き込み） |

## 7. 見送り事項（本仕様のスコープ外）

* 文字起こし失敗・上限到達時のリトライ・キューイング
* 文字起こし中であることのUI表示（「文字起こし中…」等）
* 事後書き換え結果を自動再生・TTS読み上げのトリガーにすること
* 月間上限のアトミックな厳密制御（多少の超過は許容する方針のため）
* Google STT以外のプロバイダ対応
* 上限到達を管理者・ユーザーへ通知する仕組み

## 8. 変更箇所一覧（実装時の参考）

| レイヤ | 変更内容 |
| --- | --- |
| DB | `messages.needs_transcription` カラム追加。`stt_usage_log` テーブル新設。`messages` INSERT用の新規DBトリガー（WHEN句で対象を絞り込み） |
| Edge Function | `transcribe-audio-message`（新設）。月間カウント判定 → Google STT呼び出し → `messages` UPDATE |
| `services/supabase.ts` | `sendMessage()` に `needsTranscription` 引数を追加し、INSERT時にセット |
| `app.ts` | 音声Blob送信時に「認識結果が空だったか」を判定して `needsTranscription` を渡す |
| Secrets | `GOOGLE_STT_API_KEY`（Speech-to-Text APIのみに制限したAPIキー）をSupabase Edge Functionのsecretとして追加 |

## 9. GCP環境構築手順（実装前に必要な準備）

Speech-to-Text APIをこのプロジェクトで初めて使うための手順。**すべてWebコンソール上のGUI操作またはユーザー自身のCLI操作であり、Claudeが代行できない作業**（後述の「10. ユーザーが手作業で行うべき作業」に一覧を再掲する）。

### 9.1. 使うGCPプロジェクトについて

新規にGCPプロジェクトを作る必要はない。本プロジェクトは既にFCM（プッシュ通知）用にFirebaseプロジェクト **`chatransceiver13162`**（[.firebaserc](../.firebaserc)）を保有しており、**FirebaseプロジェクトはGoogle Cloudのプロジェクトそのもの**なので、これをそのまま流用できる。

### 9.2. 課金アカウントの有効化

Speech-to-Text APIは無料枠（月60分、標準・拡張モデル問わず、毎月自動リセット、有効期限なし）があるが、**無料枠の範囲内であってもAPIを有効化するには課金アカウント（クレジットカード）の紐付けが必須**というGoogle Cloud共通の制約がある。

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセスし、プロジェクトセレクタで `chatransceiver13162` を選択する。
2. 左メニュー「お支払い」（Billing）から、課金アカウントが未リンクであれば新規作成してリンクする（クレジットカード登録が必要）。
3. **予算アラートの設定を強く推奨**: 「お支払い」→「予算とアラート」から、例えば月額 $1 などの低い閾値でメール通知が届くように設定しておくと、想定外の超過利用に早期に気づける。
4. 無料枠を超過した場合の単価は $0.006 / 15秒（標準モデル、データロギングなし）。仮に月200リクエストの上限判定が多少ずれて超過しても、数十件程度なら数十円のオーダーで収まる規模感。

> 無料枠・料金の出典: [Cloud Speech-to-Text pricing (Google Cloud公式)](https://cloud.google.com/speech-to-text/pricing)

### 9.3. Speech-to-Text APIの有効化

1. Google Cloud Console 左メニュー「APIとサービス」→「ライブラリ」を開く。
2. "Cloud Speech-to-Text API" を検索し、選択して「有効にする」をクリックする。

### 9.4. APIキーの発行と制限

1. 「APIとサービス」→「認証情報」→「認証情報を作成」→「APIキー」を選択し、新規キーを発行する。
2. 発行直後に **「キーを制限」** を必ず行う（無制限のAPIキーは事故のもとなので放置しない）。
   * **APIの制限**: 「キーを制限」を選び、"Cloud Speech-to-Text API" のみを許可リストに追加する。
   * **アプリケーションの制限**: Edge FunctionはSupabase側（Deno Deploy基盤）から動的なIPで呼び出されるため、IPアドレス制限は実用的でない。「なし」のままでよい（APIの制限のみで十分に絞り込まれている）。
3. 発行されたAPIキーの文字列を控えておく（後述 9.5 で使用。**このキーをリポジトリやチャットに直接貼り付けない**）。

### 9.5. APIキーをSupabase Edge Functionのsecretとして登録

Edge Function（`transcribe-audio-message`）からGoogle STTを呼ぶ際、APIキーはコードに埋め込まず、Supabaseのsecretとして保持する（既存の `FIREBASE_SERVICE_ACCOUNT` と同じ扱い）。

```bash
npx supabase secrets set GOOGLE_STT_API_KEY=<9.4で取得したAPIキー>
```

* Supabase CLIがプロジェクトにリンクされていない場合は、既存の手順（[setup_backend.md](./setup_backend.md)参照）と同様に `npx supabase link --project-ref <プロジェクトID>` を先に実行する。
* コマンドラインの代わりに、Supabaseダッシュボード「Edge Functions」→「Secrets」からGUIで登録することも可能。
* **このコマンドはターミナルにAPIキーの値が残る／チャット履歴にも残りうるため、ユーザー自身の手元のターミナルで実行することを推奨**する（Claudeに代行させる場合はキーの値をチャットに貼る必要があり、秘匿情報の管理として望ましくない）。

## 10. ユーザーが手作業で行うべき作業（まとめ）

実装（コード変更）に着手する前に、以下はユーザー自身が行う必要がある。いずれもGoogleアカウントへのログインや決済情報の入力を伴うため、Claudeは代行できない。

| # | 作業 | 参照 |
| --- | --- | --- |
| 1 | Google Cloud Consoleで `chatransceiver13162` プロジェクトに課金アカウント（クレジットカード）をリンクする | §9.2 |
| 2 | （推奨）予算アラートを設定する | §9.2 |
| 3 | "Cloud Speech-to-Text API" を有効化する | §9.3 |
| 4 | APIキーを発行し、「Cloud Speech-to-Text APIのみ」に制限をかける | §9.4 |
| 5 | 発行したAPIキーを控えておく（実装時にSupabase secretとして登録するために使う） | §9.4 |
| 6 | 実装後、`npx supabase secrets set GOOGLE_STT_API_KEY=...` を自分のターミナルで実行してAPIキーを登録する | §9.5 |

上記1〜5は今すぐ行うことができる（コード実装を待つ必要はない）。6は `transcribe-audio-message` Edge Functionの実装後に行う。

なお§4.0の通り、APIキー（6）が未登録の間はEdge Functionが「文字起こしを行わないだけ」で正常に動作し続ける設計のため、**実装・デプロイの順序と1〜6の完了順序は厳密に前後してもよい**（例: 先にコードを実装・デプロイしておき、後からAPIキーを登録して機能を有効化する、という進め方も可能）。

※本仕様は未実装のドラフトである。実装に着手する場合は、本ファイルの内容をレビューのうえ `specifications.md` / `decisions.md` / `database_design.md` への反映と合わせて行うこと。
