# Chatransceiver

> **15秒トランシーバー！文字起こし付きチャット**

![Chatransceiver Screenshot](./README_img/Chatransceiver.gif_1280x546.gif)

## 📖 概要 (What is this?)

トランシーバーアプリ<br>
Google Chromeで動作（PWA対応）<br>
１メッセージあたり最大15秒の音声録音<br>
音声は文字おこししてチャットテキスト化<br>
文字入力は音声読み上げ（TTS）<br>
アプリを閉じても通知（PC,Android）<br>
チャット履歴から何度もリプレイ可<br>
DiscordのWebhookに通知機能あり（上級者向け）<br>

### ✨ 主な機能 (Features)

* **音声PTT送信**: 最大15秒の音声録音。発話内容は自動で文字おこし（Web Speech API）。
* **テキスト送信＆読み上げ**: テキスト入力での送信も可能。受信側では音声合成（TTS）で自動読み上げ。
* **録音モードの選択**: 「両方（音声＋文字おこし）」「録音のみ」「文字おこしのみ」から選択可能。
* **グローバル自動再生**: 表示中・未接続を問わず、着信メッセージを再生キューで順次自動再生。
* **TTT (Trigger word To Talk) ハンズフリー**: ウェイクワード（合言葉）を音声検知して自動で録音・送信するハンズフリーモード。
* **常時表示 (Screen Wake Lock)**: 画面の自動ロック・消灯を抑止し、受信待ち中もアプリを動かし続ける。
* **メディアボタンPTT**: イヤフォン等の再生/停止ボタンで録音開始・停止＋送信を操作。
* **発言の取り消し**: 自分が送ったメッセージを取り消し（音声ファイル削除＋テキストクリア）。
* **グループチャット**: 複数人選択でグループを自動作成。グループ名（あだ名）はメンバーなら誰でも編集可能。
* **疑似コールサイン音**: 再生の前後に効果音を鳴らすトランシーバー風の演出（ON/OFF可）。
* **外観カスタマイズ**: ダーク／ライトテーマ、背景画像（ぼかし対応）の設定。
* **バックグラウンド通知**: Webプッシュ（FCM）／Discord Webhook 通知。
* **2種類のログイン**: Googleログイン、または Magic Link（メールリンク）認証。

---

## 🚀 使い方 (How to Use)

**1. ログインとコミュニティ参加**
* アプリのURLにアクセスし、「Googleでログイン」または「Magic Link（メールリンク）」でログインします。<br>
  ※案内される権限は与えてください
* 招待リンクからアクセスするか、コミュニティ名ピルのメニューからコミュニティIDを入力して参加します。
* メンバー／グループは1つの統合リストに表示され、フィルタチップ（すべて／個別／グループ）で絞り込めます。
* 行をタップ／クリックすると、その相手とのチャットがすぐ開きます。
* 「＋新規グループ」ボタンから複数人を選択すると、グループが作成されます。

**2. 音声の送信 (PTT)**
* 画面下部の大きなマイクボタンをクリックして話し始めます（PCではフッター左端の控えめなボタン）。
* 停止ボタンクリックか15秒経過すると録音が止まります。
* 発話内容は文字おこしされます。（現状はPCのみ）
* 送信クリックで音声とテキストが送信されます。
* 停止ボタンを使わずに送信クリックでも音声と文字起こしデータが送信されます。
* テキスト入力欄からのテキスト送信も可能です（受信側はTTSで自動読み上げ）。

**3. ハンズフリー操作（任意）**
* **TTT (Trigger word To Talk)**: 環境設定でウェイクワード（正規表現）を登録し、チャット画面下部のTTTスイッチをONにすると、合言葉の発話で録音が自動起動します。
* **常時表示 (☀️)**: ヘッダーの☀️ボタンで画面の自動ロックを抑止します（受信待ち向け、電池消耗に注意）。
* **メディアボタンPTT (🎧)**: ヘッダーの🎧ボタンをONにすると、イヤフォン等の再生/停止ボタンで録音開始・停止＋送信を操作できます。

**4. 音声の再生と確認**
* 新着メッセージは自動的に再生されます（複数同時着信は順次再生）。
* 再生されなかった過去のメッセージも、チャット画面の再生ボタンを押すことで聞き直すことができます。

**5. 設定（環境設定 ⚙️）**
* ニックネーム変更、自動再生／疑似コールサイン音のON/OFF、録音モード、ウェイクワード設定。
* カラーテーマ（ダーク／ライト）、背景画像・ぼかしの設定。
* プッシュ通知（FCM）の許可、Discord Webhook URL の登録。

**6. 注意点**
* グループやチャット履歴は誰でも削除できます。
* あくまでトランシーバのような半二重非同期通信を実現することで連絡のきっかけツールとして使うことが想定されています。
* 重要な情報や永続化必要な情報の保存には向いていません。

---

## 🛠 開発者向け：技術スタック (Tech Stack)

* **Frontend**: HTML / Vanilla CSS / TypeScript (Vite) / PWA (Service Worker, Web App Manifest)
* **Backend**: Supabase (Auth, PostgreSQL, Storage, Realtime, Edge Functions)
* **Web標準API**: Web Speech API (音声認識/合成) / Screen Wake Lock API / Media Session API / IndexedDB (背景画像のローカル保存)
* **通知**: Firebase Cloud Messaging (FCM) / Discord Webhook
* **Hosting**: Firebase Hosting

## 💻 開発者向け：ローカル環境の構築手順 (Getting Started)

### 前提条件
* Node.js (v20以上推奨)
* npm または yarn
* Supabase CLI (任意: Edge Functionのローカルテストやデプロイ用)

### セットアップ
1. リポジトリのクローン
   ```bash
   git clone <repository-url>
   cd Chatransceiver
   ```
2. 依存関係のインストール
   ```bash
   npm install
   ```
3. 環境変数の設定
   * リポジトリ直下に `.env` ファイルを作成し、Supabaseの接続情報を記載します（`.env.example` を参照してください）。
4. ローカル開発サーバーの起動
   ```bash
   npm run dev
   ```

### デプロイ
* フロントエンド: `npm run deploy` (Firebase Hosting)
* バックエンド (Edge Functions): 以下の3つの関数をデプロイします。
  ```bash
  supabase functions deploy send-push-notification        # 新着メッセージのFCM/Discord通知
  supabase functions deploy register-fcm-token            # FCMデバイストークン登録
  supabase functions deploy delete-audio-on-message-delete # メッセージ削除時の音声ファイル削除
  ```

---

## 📚 プロジェクトドキュメント (Documentation)

開発に関わる設計や仕様については、`docs/` ディレクトリを参照してください。
* [コンテキスト・プロジェクト概要 (context.md)](./docs/context.md)
* [機能仕様書 (specifications.md)](./docs/specifications.md)
* [データベース設計 (database_design.md)](./docs/database_design.md)
* [意思決定ログ (decisions.md)](./docs/decisions.md)

---

## 🤖 AI Assistant Guidelines (AIへの指示)

このプロジェクトでは、AIアシスタントと共同で仕様を議論しながら開発を進めています。
**セッションがリセットされた際や、新しく開発に参加したAIは、まず以下の手順でコンテキストを復元してください。**

### 1. 復元手順
1. `docs/context.md` を読み込み、プロジェクトの目的と全体像を把握する。
2. `docs/discussion.md` を読み込み、現在議論中のトピックや次に話すべきアジェンダを確認する。
3. `docs/specifications.md` と `docs/decisions.md` を読み込み、これまでに確定した仕様と決定経緯を把握する。
4. 復元が完了したら、ユーザーに「ここまでの文脈を理解しました。現在議論中の〇〇について話を進めましょう」と提案する。

### 2. ドキュメント運用のルール
議論が進む中で、仕様や状況に変化があった場合は、AIが責任を持って以下のファイルを更新してください。
* `docs/context.md`: 全体像や技術スタックの更新
* `docs/specifications.md`: 確定した仕様の追記・整理
* `docs/decisions.md`: 決定した事項とその理由のログ追加
* `docs/discussion.md`: 議論中・未解決事項のアップデート
.
