# UML設計書 (docs/uml_diagrams.md)

このファイルは、Mermaidによるフローチャート式のクラス構成図、およびActor（ユーザー）を含めた各主要シナリオのシーケンス図を管理します。

---

## 1. クラス構成・データフロー図 (Mermaid flowchart)

`classDiagram` よりも「データの流れ」と「制御の依存関係」を明確にするため、フローチャート（`flowchart`）形式でクラスの関係を示します。

```mermaid
flowchart TD
    subgraph UI層 (ブラウザDOM)
        Actor[Actor: ユーザー] <--> |操作・視聴| UI[UIController]
        UI --> CommUI[CommunitySelectorUI]
        UI --> UserUI[UserListUI]
        UI --> GroupUI[GroupListUI]
        UI --> ChatUI[ChatWindowUI]
    end

    subgraph コントロール層 (ビジネスロジック)
        UI <--> |イベント通知 / 描画要求| App[App]
        App <--> |録音・再生・音声認識/合成| Audio[AudioManager]
        App <--> |再生スタック管理| Queue[AudioPlaybackQueue]
    end

    subgraph サービス層 (データアクセス)
        App <--> |データCRUD / リアルタイムリッスン| DB[SupabaseService]
    end

    subgraph バックエンド (クラウド)
        DB <--> |SSL / WebSocket| Supabase[(Supabase / Postgres / Storage)]
    end

    Queue --> |順次再生命令| Audio
```

---

## 2. シナリオ別シーケンス図 (Mermaid sequenceDiagram)

### 2.1. 使用開始フロー (ログイン・初期設定〜接続)
ユーザーがアプリを立ち上げ、Googleログインと設定を行ってメイン画面に入るまでの流れです。

```mermaid
sequenceDiagram
    autonumber
    actor User as ユーザー
    participant App as App (Mediator)
    participant DB as SupabaseService
    participant UI as UIController
    participant Audio as AudioManager

    User->>App: アプリ起動
    App->>DB: ログイン状態確認 (auth.onAuthStateChange)
    alt 未ログイン
        DB->>User: Googleログインポップアップ表示
        User->>DB: ログイン実行 (認証完了)
    end
    DB->>App: ログイン成功 (Userオブジェクト)

    App->>UI: 初期設定ダイアログを表示
    UI->>User: 画面表示 (音声設定、接続ボタン)
    User->>UI: 「接続する」ボタンをクリック (User Interaction)
    
    critical 自動再生ロックの解除 (ブラウザのセキュリティ制限クリア)
        UI->>Audio: AudioContext の初期化/開始 (resume)
        Audio-->>UI: 音声出力の有効化完了
    end

    UI->>App: 接続シグナル送信
    App->>DB: 選択されたコミュニティの入室確認 ＆ 自分のInboxのリアルタイム監視開始 (subscribeInbox)
    DB-->>App: 監視開始完了
    App->>UI: メイン3ペイン画面の描画 (Render)
    UI->>User: チャット画面表示 (準備完了)
```

---

### 2.2. 発話送信フロー (録音〜文字起こし〜送信)
ユーザーが発話ボタンを押し、録音し、文字起こしを伴ってメッセージを送信するまでの流れです。

```mermaid
sequenceDiagram
    autonumber
    actor User as ユーザー
    participant UI as UIController
    participant App as App (Mediator)
    participant Audio as AudioManager
    participant DB as SupabaseService

    User->>UI: 送信先をチェックし、「発話」ボタンをクリック
    UI->>Audio: 録音の開始を要求 (startRecording)
    Audio->>UI: リアルタイム音量レベルをコールバック (onLevelUpdate)
    loop 録音中
        UI->>User: マイク入力レベルメーターをアニメーション描画
    end

    User->>UI: 「送信」ボタンをクリック (録音終了)
    UI->>Audio: 録音停止を要求 (stopRecording)
    Audio-->>UI: 音声データ (Blob) を返却
    UI->>App: メッセージ送信命令 (audioBlob, 入力テキスト)

    par 音声ファイルのアップロード ＆ メッセージの仮登録
        App->>DB: 音声ファイルのアップロード (Supabase Storage)
        DB-->>App: 音声ファイルURL
        App->>DB: メッセージレコードの仮登録 (audio_url)
        DB-->>App: メッセージID確定
    and 音声認識 (ディクテーション) の実行
        App->>Audio: ディクテーションの開始 (startDictation)
        Audio-->>App: 文字起こしテキスト (SpeechRecognitionResult)
    end

    App->>DB: メッセージレコードに文字起こしテキストを紐づけて更新 (UPDATE messages)
    DB-->>App: 送信完了
    App->>UI: チャットウィンドウの再描画 (送信メッセージのバブル表示)
    UI->>User: 画面に表示
```

---

### 2.3. 受信自動再生フロー (Inbox監視〜順次再生〜既読化)
待機中に新着メッセージを受信し、自動再生（音声/TTS）を行い、画面表示によって既読化されるまでの流れです。

```mermaid
sequenceDiagram
    autonumber
    actor User as ユーザーB (受信側)
    participant DB as Supabase (Realtime)
    participant Service as SupabaseService
    participant App as App (Mediator)
    participant Queue as AudioPlaybackQueue
    participant Audio as AudioManager
    participant UI as UIController

    DB->>Service: リアルタイムイベント検知 (user_inboxes へのインサート)
    Service->>App: 新着メッセージ通知 (message_id)
    App->>Queue: メッセージアイテムをエンキュー (enqueue)
    
    activate Queue
    Queue->>Queue: 再生状態チェック (isPlaying = false)
    
    alt 音声メッセージの場合 (audio_url が存在)
        Queue->>Audio: 音声ファイルの再生を指示 (playAudio)
        Audio->>User: スピーカーから音声を再生
    else テキストメッセージの場合 (audio_url が空)
        Queue->>Audio: テキストの読み上げを指示 (speakText)
        Audio->>User: 音声合成 (SpeechSynthesis) で読み上げ
    end
    
    UI->>User: 送信元ユーザー/グループの横に「🔊 再生中」インジケータを表示
    
    Audio-->>Queue: 再生終了イベント (ended / onend)
    deactivate Queue
    
    UI->>User: 「🔊 再生中」インジケータを非表示
    UI->>User: 該当チャット一覧の横に「未読バッジ」を表示したままにする
    
    User->>UI: 未読バッジのあるチャットルームをクリック (画面表示)
    UI->>App: チャットルーム選択イベント
    App->>Service: 該当メッセージの既読化 (user_inboxes の is_read = true / 削除)
    Service->>DB: DB更新
    App->>UI: 未読バッジの消去 ＆ 過去ログのバブル描画 (▶再生ボタン付き)
    UI->>User: 画面に既読状態が反映される
```

---

### 2.4. 招待リンクからの参加フロー
招待URLからアクセスし、同意ダイアログを経てコミュニティに参加するまでの流れです。

```mermaid
sequenceDiagram
    autonumber
    actor User as 招待されたユーザー
    participant App as App (Mediator)
    participant DB as SupabaseService
    participant UI as UIController

    User->>App: 招待URLアクセス (/?c=slug&code=invite_code)
    App->>DB: 認証チェック ＆ コミュニティ情報 (表示名など) の取得
    DB-->>App: コミュニティ情報

    App->>UI: 参加同意ダイアログの表示要求 (ニックネーム未設定ならニックネーム入力も含む)
    UI->>User: 画面表示 (「〇〇コミュニティに参加しますか？」)
    
    User->>UI: 「参加する」ボタンをクリック (同意)
    UI->>App: 同意シグナル
    
    App->>DB: コミュニティへのメンバー登録 (INSERT community_members)
    DB->>DB: 参加順ユーザー番号を自動発行 (+1)
    DB-->>App: 登録完了 (ユーザー番号確定)
    
    App->>App: ローカルストレージ (LocalStorage) にコミュニティIDを保存
    App->>UI: メイン画面の描画 (該当コミュニティをアクティブ化)
    UI->>User: コミュニティに参加したチャット画面を表示
```
