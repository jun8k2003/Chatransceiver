# Androidネイティブアプリ (.NET MAUI) 実装ブループリント (`docs/android_implementation_plan.md`)

このドキュメントは、Chatransceiver の Androidネイティブ版（C# / .NET MAUI）を実装するための**完全な設計書兼・段階的実装手順書（Blueprint）**です。
上位モデル（Gemini 4 Argon）での分割実装、および軽量・高速モデル（Gemini 4 Hydrogen等）への実装委譲のどちらでも、**迷いやAPIのハルシネーションなく確実にビルドが通るコードを生成できるよう、ファイル構成・API仕様・マニフェスト定義・実装ステップを具体化**しています。

---

## 1. 全体アーキテクチャと設計原則

### 1.1. なぜこの構成にするのか（AI実装の確実性と省電力の両立）
1. **外部NuGetパッケージ依存の最小化**:
   * `supabase-csharp` などのサードパーティ製重厚SDKは、MAUIのAOT/Trimmerビルドやバージョン競合でエラーを起こしやすいため**使用しない**。
   * 代わりに、C#標準の `System.Net.Http.HttpClient` + `System.Text.Json` + `System.Net.WebSockets.ClientWebSocket` を用いて、既存の [src/services/supabase.ts](../src/services/supabase.ts) と完全に同一の Supabase REST (PostgREST) / Auth / Storage / Realtime エンドポイントを直接呼び出す。
   * ネイティブ固有のNuGetは、FCM受信用の **`Xamarin.Firebase.Messaging`**（および Google Play Services Base）のみに絞る。
2. **省電力ハイブリッド待機（DeepSleep対応）**:
   * 画面消灯（バックグラウンド）中は WebSocket や `WakeLock` を保持しない（消費電力ほぼゼロ）。
   * 着信は `send-push-notification` Edge Function からの高優先度FCM（`priority: "high"`）で `FirebaseMessagingService` を起床させ、再生中だけ `PARTIAL_WAKE_LOCK` を掴んで音声（`MediaPlayer`）またはテキスト読み上げ（`Android.Speech.Tts.TextToSpeech`）を鳴らす。
3. **マイク競合なしの端末側「録音＋文字起こし」両立**:
   * `Android.Media.AudioRecord`（16kHz, 16bit, Mono PCM）で1回だけマイクを開く。
   * 読み取ったPCMバイト列をメモリ上のWAVバッファへ書きつつ、Android 13 (API 33+) では `ParcelFileDescriptor.CreatePipe()` 経由で `Android.Speech.SpeechRecognizer` (`RecognizerIntent.ExtraAudioSource`) に流し込み、端末側で文字起こしテキストを得る。

---

## 2. ディレクトリ・ファイル構成

リポジトリ直下に `android/` フォルダを作成し、既存のWeb資産（`src/`, `public/` 等）とは完全に分離します。

```text
Chatransceiver/
├── .gitignore                          # 修正: *.sln の除外行を削除
├── package.json                        # 修正: "build:android" スクリプトを追加
├── .github/workflows/
│   ├── firebase-hosting-merge.yml      # 修正: paths-ignore: ['android/**'] を追加
│   ├── firebase-hosting-pull-request.yml # 修正: paths-ignore: ['android/**'] を追加
│   └── android-build.yml               # 新規: Android APK ビルド用ワークフロー (workflow_dispatch対応)
├── supabase/functions/
│   ├── send-push-notification/index.ts # 修正: android.priority="high" と data.audioUrl を追加
│   └── transcribe-audio-message/index.ts # 修正: .wav (LINEAR16 16kHz) のフォールバック判定を追加
└── android/                            # 新規: .NET MAUI (Android特化) プロジェクト一式
    ├── .gitignore                      # .NET / Android 固有の除外設定 (bin/, obj/, *.keystore, google-services.json 等)
    ├── Chatransceiver.sln
    └── Chatransceiver.Maui/
        ├── Chatransceiver.Maui.csproj
        ├── google-services.json        # (Git除外・ローカルまたはCIのSecretsから生成)
        ├── App.xaml / App.xaml.cs
        ├── MauiProgram.cs
        ├── Models/
        │   └── AppModels.cs            # User, Community, Member, Group, Message, QueueItem 等のデータモデル
        ├── Services/
        │   ├── AppConfig.cs            # Supabase URL / AnonKey 定数・設定管理 (Preferences保存)
        │   ├── SupabaseClientService.cs # Auth / PostgREST / Storage / Edge Function 呼び出し (HttpClient)
        │   ├── RealtimeService.cs      # フォアグラウンド時の Supabase Realtime (Phoenix WebSocket) 購読
        │   └── AudioPlaybackQueue.cs   # 前後コールサイン音＋音声/TTSの直列再生キュー (DEC-032 stopAll対応)
        ├── Views/
        │   ├── LoginPage.xaml / .cs    # Google OAuth & Magic Link ログイン画面
        │   ├── MainPage.xaml / .cs     # ヘッダー + 統合リスト / チャット画面 + PTTフッター + 停止オーバーレイ
        │   └── SettingsModalPage.xaml / .cs # ニックネーム・自動再生・コールサイン音・録音モード・テーマ・ログアウト
        ├── Resources/
        │   ├── Raw/
        │   │   └── ptt_start.wav       # 既存の src/assets/ptt-start.wav をコピーして同梱
        │   └── AppIcon/ , Splash/      # 既存の public/chatora.png をベースに配置
        └── Platforms/Android/
            ├── AndroidManifest.xml     # 権限・ForegroundService・カスタムスキーム定義
            ├── MainActivity.cs         # Activity設定
            ├── WebAuthCallbackActivity.cs # chatransceiver://auth-callback 受け取り用 Activity
            └── Services/
                ├── NativeAudioService.cs     # MediaPlayer音声再生・TextToSpeech合成・ビープ音生成・WakeLock管理
                ├── NativeRecordingService.cs # AudioRecord PCM録音 (WAV生成) ＋ SpeechRecognizer パイプ文字起こし
                ├── TransceiverForegroundService.cs # MediaSession イヤフォンPlay/Pause PTT捕捉 & 待機常駐サービス
                └── ChatFcmService.cs         # FirebaseMessagingService (DeepSleep着信起床 → AudioPlaybackQueue投入)
```

---

## 3. 既存ファイルへの変更仕様（Phase 1 で実施）

### 3.1. ルート `.gitignore` の修正
* 末尾付近の `*.sln` の1行を削除する。

### 3.2. `package.json` のスクリプト追加
`scripts` に以下を追加する（既存の `build` 等は一切変更しない）：
```json
"build:android": "dotnet publish android/Chatransceiver.Maui/Chatransceiver.Maui.csproj -f net9.0-android -c Release"
```

### 3.3. `supabase/functions/send-push-notification/index.ts` の後方互換拡張
138〜153行目の FCM HTTP v1 API 送信ペイロードに `android: { priority: 'high' }` と `audioUrl: audioUrl` を追加する。
```ts
        body: JSON.stringify({
          message: {
            token: t.fcm_token,
            android: {
              priority: 'high'
            },
            // カスタムのクリックハンドラおよびAndroidバックグラウンド自動再生で利用するデータ
            data: {
              ...badgeData,
              url: `/?c=${communitySlug}&m=${record.message_id || ''}`,
              communitySlug: communitySlug,
              messageId: record.message_id || '',
              communityName: communityName,
              senderName: senderName,
              messageType: audioUrl ? 'audio' : 'text',
              textContent: textContent,
              audioUrl: audioUrl
            }
          }
        })
```
* **後方互換性**: Web Push のトークンに対しては `android` ブロックはFCMサーバー側で無視され、Service Worker 側でも増えた `data.audioUrl` は単に無視されるため、既存のWeb版には一切影響しない。

### 3.4. `supabase/functions/transcribe-audio-message/index.ts` の `.wav` 対応
Android版が「録音のみ（`audio_only`）」モードや Android 12 以下で `needs_transcription = true` の `.wav`（16kHz / 16bit / mono LINEAR16）を送信した場合にもサーバー側事後STTが成功するよう、70〜75行目の `config` を拡張子で分岐する：
```ts
        config: {
          encoding: record.audio_url.endsWith('.wav') ? 'LINEAR16' : 'WEBM_OPUS',
          sampleRateHertz: record.audio_url.endsWith('.wav') ? 16000 : 48000,
          languageCode: 'ja-JP'
        },
```

---

## 4. Androidネイティブ (`android/Chatransceiver.Maui`) 詳細設計

### 4.1. `Chatransceiver.Maui.csproj` 定義
* **TargetFramework**: `net9.0-android`（または環境にインストールされている最新の `.NET 8 / 9` Androidワークロードに合わせて `net8.0-android` / `net9.0-android`）
* **ApplicationId**: `com.chatransceiver.app`
* **SupportedOSPlatformVersion**: `26.0` (Android 8.0+)
* **TargetSdkVersion**: `35` (Android 15) または `34` (Android 14)
* **NuGetパッケージ**:
  * `Microsoft.Maui.Controls`
  * `Xamarin.Firebase.Messaging` (Version `124.0.0` 系以上)
  * `Xamarin.GooglePlayServices.Base`
* **`google-services.json` の条件付き読み込み**:
  ローカルやCIで `google-services.json` が未配置でもC#コンパイル自体は確認できるよう、`Condition="Exists('google-services.json')"` で `<GoogleServicesJson Include="google-services.json" />` を指定する。

### 4.2. `Platforms/Android/AndroidManifest.xml` 完成形スニペット
Android 14 (API 34+) 以降では、フォアグラウンドサービスのタイプ宣言が1つでも欠けると `SecurityException` でクラッシュするため、以下の定義をそのまま使用する：

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
          package="com.chatransceiver.app">

    <!-- ネットワーク・スリープ制御・通知 -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />

    <!-- 録音・音声変更 -->
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.BLUETOOTH" />
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />

    <!-- Android 14+ フォアグラウンドサービス権限 -->
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />

    <!-- Android 11+ パッケージ可視性: SpeechRecognizer と TextToSpeech サービスへのアクセスに必須 -->
    <queries>
        <intent>
            <action android:name="android.speech.RecognitionService" />
        </intent>
        <intent>
            <action android:name="android.intent.action.TTS_SERVICE" />
        </intent>
    </queries>

    <application
        android:allowBackup="true"
        android:icon="@mipmap/appicon"
        android:roundIcon="@mipmap/appicon_round"
        android:supportsRtl="true"
        android:label="Chatransceiver">

        <!-- メディアボタンイベント受信用レシーバー -->
        <receiver android:name="androidx.media.session.MediaButtonReceiver"
                  android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MEDIA_BUTTON" />
            </intent-filter>
        </receiver>

        <!-- PTT待機・再生用フォアグラウンドサービス -->
        <service android:name=".Platforms.Android.Services.TransceiverForegroundService"
                 android:enabled="true"
                 android:exported="false"
                 android:foregroundServiceType="mediaPlayback|microphone" />

        <!-- FCM受信サービス -->
        <service android:name=".Platforms.Android.Services.ChatFcmService"
                 android:exported="false">
            <intent-filter>
                <action android:name="com.google.firebase.MESSAGING_EVENT" />
            </intent-filter>
        </service>
    </application>
</manifest>
```

---

### 4.3. Supabase 通信・認証 (`SupabaseClientService.cs`) の仕様

既存の [src/services/supabase.ts](../src/services/supabase.ts) の各メソッドを C# の `HttpClient` で1対1に移植します。

1. **共通リクエストヘッダー**:
   * `apikey`: `<SUPABASE_ANON_KEY>`
   * `Authorization`: `Bearer <access_token>`（未ログイン時は `<SUPABASE_ANON_KEY>`）
2. **認証 (`chatransceiver://auth-callback`)**:
   * **Googleログイン**:
     * URL: `{SupabaseUrl}/auth/v1/authorize?provider=google&redirect_to=chatransceiver://auth-callback`
     * MAUI標準の `WebAuthenticator.Default.AuthenticateAsync(new Uri(authUrl), new Uri("chatransceiver://auth-callback"))` を呼び出す。
     * コールバックURLのフラグメント（`#access_token=...&refresh_token=...`）からトークンを取得し、`Preferences`（または `SecureStorage`）へ保存する。
   * **Magic Link**:
     * `POST {SupabaseUrl}/auth/v1/otp?redirect_to=chatransceiver://auth-callback` に `{"email": email, "create_user": true}` を送信。
     * メール内のリンクをクリックすると `WebAuthCallbackActivity` が `chatransceiver://auth-callback#access_token=...` を受け取り、セッションを確立する。
   * **トークンリフレッシュ**:
     * 起動時や 401 応答時に `POST {SupabaseUrl}/auth/v1/token?grant_type=refresh_token` に `{"refresh_token": refreshToken}` を投げて更新する。
3. **データベース・Storage・RPC操作（PostgREST）**:
   * **ユーザー取得/修復 (`GetCurrentUserAsync`)**:
     * `GET /rest/v1/users?id=eq.{userId}&select=name` → 存在しなければ `POST /rest/v1/users` (`Prefer: resolution=merge-duplicates`) で初期作成。
   * **コミュニティ接続 (`ConnectCommunityAsync`)**:
     * 入力文字列が `http://` または `https://` で始まる場合、`Uri` としてパースしクエリ `?c=` の値を `slug` として抽出する（招待URLコピペ対応）。
     * `GET /rest/v1/communities?slug=eq.{slug}&select=*` → 無ければ自動作成。
     * `GET /rest/v1/community_members?community_id=eq.{cid}&user_id=eq.{uid}` → 無ければ最大 `user_number + 1` で `POST /rest/v1/community_members`。
   * **コミュニティ退会 (`LeaveCommunityAsync`)**:
     * `POST /rest/v1/rpc/leave_community_and_cleanup` に `{"p_user_id": userId, "p_community_id": communityId}` を送信。
   * **メンバー・グループ・未読数取得**:
     * `GetCommunityMembersAsync`: `GET /rest/v1/community_members?community_id=eq.{cid}&select=user_number,users(id,name)`（自分自身は除外）。
     * `GetCommunityGroupsAsync`: `GET /rest/v1/chat_room_members?user_id=eq.{uid}&select=room_id,chat_rooms(id,type,community_id,name)` から3人以上のグループを抽出し、未読数を集計。
     * `GetUnreadIndividualCountsAsync`: `GET /rest/v1/user_inboxes?user_id=eq.{uid}&is_read=eq.false&select=messages!inner(sender_id,created_at),chat_rooms!inner(type,community_id)&chat_rooms.type=eq.individual&chat_rooms.community_id=eq.{cid}`。
   * **既読化 (`MarkAsReadAsync`)**:
     * `PATCH /rest/v1/user_inboxes?room_id=eq.{roomId}&user_id=eq.{uid}&is_read=eq.false` に `{"is_read": true}`。
   * **メッセージ送信 (`SendMessageAsync`)**:
     * 音声バイト列（WAV）がある場合：`POST {SupabaseUrl}/storage/v1/object/voice-messages/{senderId}/{timestamp}.wav` (`Content-Type: audio/wav`) でアップロードし、公開URL `{SupabaseUrl}/storage/v1/object/public/voice-messages/{senderId}/{timestamp}.wav` を得る。
     * `POST /rest/v1/messages?select=id,sender_id,audio_url,text_content,is_revoked,created_at,users(name)` に `{"room_id": roomId, "sender_id": senderId, "audio_url": audioUrl, "text_content": text, "needs_transcription": needsTranscription}` を送信。
   * **発言取り消し (`RevokeMessageAsync`)**:
     * 音声ファイルがあれば `DELETE {SupabaseUrl}/storage/v1/object/voice-messages/{filePath}` で削除後、`PATCH /rest/v1/messages?id=eq.{messageId}` に `{"is_revoked": true, "text_content": null, "audio_url": null}` を送信。
   * **FCMトークン登録・解除 (`RegisterFcmTokenAsync` / `UnregisterFcmTokenAsync`)**:
     * `POST {SupabaseUrl}/functions/v1/register-fcm-token` に `{"action": "register" | "unregister", "device_uuid": deviceUuid, "fcm_token": token}` を送信。

---

### 4.4. Androidネイティブ音声・TTS・WakeLock (`NativeAudioService.cs`) の仕様

1. **`WakeLock` の一時保持と自動解放**:
   * `PowerManager.NewWakeLock(WakeLockFlags.Partial, "Chatransceiver::AudioWakeLock")` を使用。
   * `AcquireWakeLock(timeoutMs = 30000)` と `ReleaseWakeLock()` を用意し、再生キュー開始時・録音開始時に取得し、終了時に必ず解放する（万が一の例外でも30秒で自動解放される安全設計）。
2. **音声ファイルの再生 (`PlayAudioUrlAsync(string urlOrAsset, float volume = 1.0f)`)**:
   * `ptt_start.wav`（ローカルアセット）または Supabase Storage の `audioUrl`（`.webm` / `.wav`）を再生する。
   * リモートURLの場合は、DeepSleep復帰直後の回線揺らぎで再生が途切れないよう、`HttpClient.GetByteArrayAsync(url)` で一時ファイル（`CacheDir`）へダウンロードしてから `Android.Media.MediaPlayer` で再生し、`Completion` / `Error` イベントで `TaskCompletionSource` を完了させる。
3. **テキストのネイティブTTS合成 (`SpeakTextAsync(string text)`)**:
   * `Android.Speech.Tts.TextToSpeech` を使用。
   * まだ初期化されていない（またはDeepSleepで破棄されている）場合は、`new TextToSpeech(Platform.AppContext, listener)` で初期化完了（`OperationResult.Success`）を `await` し、`Locale.Japanese` を設定する（ウォームアップ1〜2秒を許容）。
   * `UtteranceProgressListener` をセットし、`Speak(text, QueueMode.Flush, null, utteranceId)` を呼び出し、`OnDone` / `OnError`（および最大20秒の安全タイムアウト）で `TaskCompletionSource` を resolve する。
4. **停止処理 (`StopAllPlayback()`)**:
   * 再生中の `MediaPlayer.Stop()` および `TextToSpeech.Stop()` を呼び出し、待機中の `TaskCompletionSource` を即座に resolve させる（`DEC-032` のハードストップ仕様に準拠）。
5. **PTTビープ音合成 (`BeepStart`, `BeepEnd`, `BeepError`)**:
   * [src/services/mediabutton.ts](../src/services/mediabutton.ts#L130-L186) と同じ周波数・長さのサイン波PCMをメモリ上で生成し、`Android.Media.AudioTrack`（`AudioContentType.Sonification`, `AudioUsageKind.AssistanceSonification`）で再生する：
     * `BeepStart`: 800Hz (80ms) → 1200Hz (80ms)
     * `BeepEnd`: 1200Hz (80ms) → 800Hz (80ms)
     * `BeepError`: 400Hz (120ms) → 無音 (60ms) → 400Hz (120ms)

---

### 4.5. 端末側「録音＋文字起こし」両立 (`NativeRecordingService.cs`) の仕様

1. **録音モード**:
   * `"both"`（音声＋文字起こし、デフォルト）、`"audio_only"`（録音のみ）、`"text_only"`（文字起こしのみ）の3種類。
2. **単一マイク録音 (`AudioRecord`) + パイプ文字起こし (`SpeechRecognizer`)**:
   * サンプルレート `16000Hz`、`ChannelIn.Mono`、`Encoding.Pcm16bit` で `AudioRecord` を初期化する。
   * `mode != "audio_only"` かつ Android 13 (API 33: `Build.VERSION.SdkInt >= BuildVersionCodes.Tiramisu`) の場合：
     * `ParcelFileDescriptor[] pipe = ParcelFileDescriptor.CreatePipe()` でパイプを作成する（`pipe[0]` が読み込み側、`pipe[1]` が書き込み側）。
     * メインスレッド上で `SpeechRecognizer.CreateSpeechRecognizer(context)` を生成し、`Intent` に以下を設定して `StartListening(intent)` を開始する：
       * `RecognizerIntent.ActionRecognizeSpeech`
       * `RecognizerIntent.ExtraLanguageModel` = `RecognizerIntent.LanguageModelFreeForm`
       * `RecognizerIntent.ExtraLanguage` = `"ja-JP"`
       * `RecognizerIntent.ExtraPartialResults` = `true`
       * `RecognizerIntent.ExtraAudioSource` = `pipe[0]`
       * `RecognizerIntent.ExtraAudioSourceChannelCount` = `1`
       * `RecognizerIntent.ExtraAudioSourceEncoding` = `(int)Encoding.Pcm16bit`
       * `RecognizerIntent.ExtraAudioSourceSamplingRate` = `16000`
   * バックグラウンドの録音ループ（最大15秒タイマー付き）で `AudioRecord.Read(buffer, 0, buffer.Length)` を回し、読み取ったPCMデータを：
     1. `MemoryStream`（送信用WAVデータ用）に書き込む
     2. パイプ書き込みストリーム（`pipe[1]`）にも書き込む
   * 停止ボタン押下または15秒経過時：
     * `AudioRecord.Stop()` し、`pipe[1]` をクローズする（これにより `SpeechRecognizer` が音声終端を検知して最終認識結果 `OnResults` を返す）。
     * `OnResults`（または途中認識 `OnPartialResults` の最終値）を最大1.5秒 `await` して文字起こしテキストを確定させる。
     * `MemoryStream` の先頭に44バイトのRIFF WAVヘッダー（16kHz / 16bit / Mono）を付与し、`byte[] wavBytes` として返却する。
   * **フォールバック（API 32以下で `"both"` 選択時、または認識結果が空文字だった場合）**:
     * 音声ファイル（`wavBytes`）はそのまま送信し、`textContent = "🎤 音声メッセージ"` かつ `needsTranscription = true` として送信する（サーバー側STT `DEC-036` が引き継ぐ）。

---

### 4.6. イヤフォンボタンPTT & 常駐待機 (`TransceiverForegroundService.cs`) と FCM着信 (`ChatFcmService.cs`)

1. **`TransceiverForegroundService` (イヤフォンPlay/Pause PTT)**:
   * ユーザーがヘッダーの🎧ボタンをONにしたとき（またはログイン・コミュニティ接続状態で自動待機が有効なとき）に `StartForeground` で起動する。
   * 常駐通知には現在接続中のコミュニティ名と選択中の送信先（「PTT待機中: #12 たろう」など）を表示する。
   * `MediaSession` を生成して `Active = true` にし、`PlaybackState` に `PlaybackStateCode.Playing`（アクション: `ActionPlay | ActionPause | ActionPlayPause`）を設定する。※ネイティブでは実際に無音ノイズを鳴らす必要はない（初回に100msの無音AudioTrackを1回再生してメディアボタンルーティング権を取得するだけでよい）。
   * `MediaSession.Callback` の `OnMediaButtonEvent` / `OnPlay` / `OnPause` でボタン押下を検知（600msデバウンス）：
     * **送信先未選択時**: `BeepError()` を鳴らす。
     * **1回目（未録音時）**: `WakeLock` を取得 → 再生キューを一時停止 (`queue.Pause()`) → `BeepStart()` → `NativeRecordingService.StartAsync()` で録音開始（15秒タイマー起動）。
     * **2回目（録音中）または15秒タイムアウト時**: `NativeRecordingService.StopAsync()` で録音＆文字起こし結果を取得 → `BeepEnd()` → `SupabaseClientService.SendMessageAsync(...)` で送信 → 再生キュー再開 (`queue.Resume()`) → `WakeLock` を解放。

2. **`ChatFcmService` (`FirebaseMessagingService`)**:
   * `OnNewToken(string token)`: `Preferences` に保持し、ログイン済みであれば `SupabaseClientService.RegisterFcmTokenAsync` を呼ぶ。
   * `OnMessageReceived(RemoteMessage message)`:
     * `message.Data` から `messageId`, `senderName`, `communityName`, `messageType` (`"audio"` | `"text"`), `textContent`, `audioUrl` を取得する。
     * **自動再生がON（デフォルトON）の場合**:
       * アプリがフォアグラウンドでRealtime購読中であっても、`AudioPlaybackQueue.Enqueue(item)` 内の重複IDチェック（`item.Id == messageId`）により二重再生は防止される。
       * DeepSleep（バックグラウンド）中であっても、`NativeAudioService.AcquireWakeLock()` を呼び出し、`AudioPlaybackQueue.Enqueue(item)` に投入することで、**画面ロック状態のまま「前チャイム → 音声ファイル再生（またはネイティブTTS読み上げ） → 後チャイム」が直ちにスピーカー/イヤフォンから再生される**。
     * あわせてAndroidシステムの通知領域にも新着通知を表示する（タップでアプリを開く）。

---

## 5. GitHub Actions パイプライン設計 (`.github/workflows/android-build.yml`)

既存のWeb用ワークフローとは別ファイルにし、手動起動（`workflow_dispatch`）と `android/**` 変更時の自動ビルドに対応させます。

### 必要な GitHub Secrets（リポジトリ設定に追加するもの）
| Secret名 | 内容 | 備考 |
| :--- | :--- | :--- |
| `VITE_SUPABASE_URL` | Supabase URL | 既存Secretをそのまま流用 |
| `VITE_SUPABASE_ANON_KEY` | Supabase Anon Key | 既存Secretをそのまま流用 |
| `ANDROID_GOOGLE_SERVICES_JSON` | `google-services.json` の全文（またはBase64） | 未設定でもモックJSONを生成してビルド自体は通すフェイルセーフ付き |
| `ANDROID_KEYSTORE_BASE64` | 署名用 `.keystore` をBase64エンコードした文字列 | 未設定時はデバッグ署名または一時生成キーでAPK出力可能にする |
| `ANDROID_KEYSTORE_PASSWORD` | Keystoreのパスワード | 任意（未設定時はデフォルト値） |
| `ANDROID_KEY_ALIAS` | Key Alias | 任意 |
| `ANDROID_KEY_PASSWORD` | Key Password | 任意 |

---

## 6. 段階的実装手順（Phase 1 〜 Phase 4）

実装時は一度に全ファイルを生成せず、以下の4フェーズに分けて進め、各フェーズの最後にビルド確認を行います（途中でモデルを Argon ⇄ Hydrogen に切り替える場合も、このフェーズ単位で引き継げます）。

### Phase 1: リポジトリ環境整備・Edge Function拡張・MAUIプロジェクト骨格の作成
* **作業内容**:
  1. ルート `.gitignore` から `*.sln` を削除し、`android/.gitignore` を作成。
  2. `package.json` に `"build:android"` スクリプトを追加。
  3. `.github/workflows/firebase-hosting-merge.yml` と `firebase-hosting-pull-request.yml` に `paths-ignore: ['android/**']` を追加し、新規に `.github/workflows/android-build.yml` を作成。
  4. `supabase/functions/send-push-notification/index.ts` に `android: { priority: 'high' }` と `audioUrl` を追加。
  5. `supabase/functions/transcribe-audio-message/index.ts` に `.wav` (`LINEAR16`, `16000Hz`) 判定を追加。
  6. `android/Chatransceiver.sln` と `android/Chatransceiver.Maui/Chatransceiver.Maui.csproj`、`Platforms/Android/AndroidManifest.xml`、`MainActivity.cs`、`App.xaml`、および `Resources/Raw/ptt_start.wav`（`src/assets/ptt-start.wav` のコピー）を配置。
* **完了条件**: 既存の `npm run build`（Web版）がエラーなく通ること。

### Phase 2: データモデル・Supabase通信・認証・再生キューの実装
* **作業内容**:
  1. `Models/AppModels.cs` の作成（User, Community, Member, Group, Message, QueueItem, AppSettings）。
  2. `Services/AppConfig.cs` の作成（ビルド時注入または設定からの Supabase URL / Key 読み込み、Preferencesによる設定永続化）。
  3. `Services/SupabaseClientService.cs` と `Platforms/Android/WebAuthCallbackActivity.cs` の作成（Google OAuth / Magic Link `chatransceiver://auth-callback`、コミュニティ入退室、招待URL解析、ルーム作成、メッセージ送受信、音声アップロード、発言取り消し、FCMトークン登録）。
  4. `Services/RealtimeService.cs` の作成（アプリ画面表示中のメッセージ・Inbox・Presenceのリアルタイム更新）。
  5. `Services/AudioPlaybackQueue.cs` の作成（[src/audio/queue.ts](../src/audio/queue.ts) と同等の直列再生キュー、`stopAll()` ハードストップ対応）。
* **完了条件**: サービス層のC#コードに構文エラー・型不整合がないこと。

### Phase 3: Androidネイティブ特化機能（DeepSleep音声/TTS再生・録音＋文字起こし・イヤフォンPTT・FCM）の実装
* **作業内容**:
  1. `Platforms/Android/Services/NativeAudioService.cs` の作成（`PARTIAL_WAKE_LOCK` 管理、`MediaPlayer` 再生、`Android.Speech.Tts.TextToSpeech` 読み上げ、`AudioTrack` による上昇/下降/エラービープ音生成）。
  2. `Platforms/Android/Services/NativeRecordingService.cs` の作成（`AudioRecord` 16kHz PCM録音＋WAV生成、`ParcelFileDescriptor` パイプによる `SpeechRecognizer` 端末側文字起こし）。
  3. `Platforms/Android/Services/TransceiverForegroundService.cs` の作成（常駐通知、`MediaSession` によるイヤフォンPlay/Pauseボタン捕捉、ロック中PTT録音→自動送信）。
  4. `Platforms/Android/Services/ChatFcmService.cs` の作成（`FirebaseMessagingService` 継承、DeepSleep中の高優先度FCM受信 → `WakeLock` 取得 → `AudioPlaybackQueue` 投入によるロック画面直接再生）。
* **完了条件**: Android固有API呼び出しとサービス連携がすべて実装されていること。

### Phase 4: ネイティブUI（XAML）の実装と結合検証
* **作業内容**:
  1. `Views/LoginPage.xaml` / `.cs` の作成（Googleログインボタン、Magic Linkメール入力フォーム）。
  2. `Views/MainPage.xaml` / `.cs` の作成：
     * ヘッダー（コミュニティピル＆接続/招待URLコピペ/切断/退会メニュー、🔔FCMトグル、🎧イヤフォンPTTトグル、⚙️設定ボタン）
     * 統合リスト表示＆フィルタチップ（すべて／個別／グループ、未読バッジ、オンライン緑ドット、＋新規グループ作成モード）
     * チャットビュー（ルームヘッダー＋グループ名✏️編集、メッセージバブル一覧、▶手動再生、🗑️発言取り消し）
     * 下部PTTフッター（大型円形マイクPTTボタン、15秒カウントダウン＆認識プレビュー、テキスト入力欄＋送信ボタン）
     * 自動再生中の全画面停止オーバーレイ（`DEC-032` 準拠：どこをタップしても即停止）
  3. `Views/SettingsModalPage.xaml` / `.cs` の作成（ニックネーム変更、自動再生ON/OFF、疑似コールサイン音ON/OFF、録音モード選択、ダーク/ライトテーマ切替、ログアウト）。
  4. 全体の結合とビルド確認（`npm run build` および `.NET Android` ビルド）。
* **完了条件**: Web版とAndroid版の双方がリポジトリ内で整合し、すべての機能要件を満たしていること。
