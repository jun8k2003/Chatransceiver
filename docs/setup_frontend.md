# フロントエンド開発環境の構築手順 (docs/setup_frontend.md)

このファイルは、本アプリケーションのフロントエンド（Vite + TypeScript + Vanilla CSS + Supabase Web SDK）のローカル開発環境を構築し、デバッグ実行するための手順書です。Windows と Linux の両環境に対応しています。

## 1. 前提条件のインストール (Node.js & npm)

本プロジェクトでは、Node.jsのバージョンを柔軟に管理するため、**nvm (Node Version Manager)** を使用して Node.js をインストールします。

### 1.1. Windows 環境の場合

Windowsでは、パッケージマネージャー `winget` と Windows用nvm (`nvm-windows`) を使用します。

1. **nvm-windows のインストール**
   PowerShellまたはコマンドプロンプトを**管理者権限で実行**し、以下のコマンドを入力します。
   ```powershell
   winget install CoreyButler.NVMforWindows
   ```
   *(※インストール完了後、環境変数を反映させるため、PowerShell等のターミナルを一度閉じて再起動してください)*

2. **Node.js LTS (推奨版) のインストールと選択**
   再びターミナルを開き、以下のコマンドを順に実行します。
   ```powershell
   # nvmのバージョン確認（インストール成功の確認）
   nvm version

   # 最新のLTS (長期サポート) バージョンをインストール
   nvm install lts

   # インストールしたLTSバージョンを使用するように設定（管理者権限が必要な場合があります）
   nvm use lts
   ```

3. **インストール確認**
   ```powershell
   node -v
   npm -v
   ```

---

### 1.2. Linux 環境 (Ubuntu / Debian系) の場合

Linuxでは、公式のnvmインストールスクリプトを使用します。

1. **nvm のインストール**
   ターミナルを開き、以下のコマンドを実行してnvmをインストールします。
   ```bash
   # curl がインストールされていない場合は先にインストール
   sudo apt update && sudo apt install -y curl

   # nvm インストールスクリプトの実行
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
   ```
   *(※インストール完了後、`~/.bashrc` や `~/.zshrc` を反映させるため、ターミナルを再起動するか `source ~/.bashrc` を実行してください)*

2. **Node.js LTS のインストールと選択**
   ```bash
   # nvmの動作確認
   nvm --version

   # 最新のLTSバージョンをインストール
   nvm install --lts

   # インストールしたLTSバージョンを使用するように設定
   nvm use --lts
   ```

3. **インストール確認**
   ```bash
   node -v
   npm -v
   ```

---

## 2. プロジェクトの初期化

Viteの提供する「Vanilla TS (フレームワークなしの純粋なTypeScript)」の公式テンプレートを使用して、プロジェクトをセットアップします。

### 2.1. プロジェクトの初期化コマンドの実行
リポジトリのルートディレクトリ（`c:\DATA\git\jun8k2003\Chatransceiver`）に移動し、以下のコマンドを実行します。

* **Windows (PowerShell)**:
  ```powershell
  npx -y create-vite@latest ./ --template vanilla-ts
  ```
* **Linux (bash)**:
  ```bash
  npx -y create-vite@latest ./ --template vanilla-ts
  ```

### 2.2. 初期依存パッケージのインストール
展開された `package.json` に基づき、必要なnpmパッケージをインストールします。

```bash
npm install
```

---

## 3. 追加パッケージのインストール

リアルタイム通信およびユーザー認証に Supabase を使用するため、Supabase のWeb向けJavaScript SDKをインストールします。

```bash
npm install @supabase/supabase-js
```

---

## 4. 推奨するフォルダ・ファイル構成

Vite + TypeScriptの基本構造と、クラス設計（`docs/class_design.md`）に基づき、以下の構成でファイルを配置します。

```text
Chatransceiver/
├── index.html            # メインのHTMLエントリーポイント
├── package.json          # 依存パッケージ定義
├── tsconfig.json         # TypeScriptコンパイル設定
├── vite.config.ts        # Viteの設定ファイル（必要に応じて追加）
├── docs/                 # 設計・ドキュメントフォルダ
└── src/                  # ソースコードフォルダ
    ├── main.ts           # アプリの開始点（Appクラスのインスタンス化）
    ├── style.css         # アプリ全体のグローバルスタイル
    ├── app.ts            # Appクラス (全体統合・状態管理)
    ├── services/         # 外部通信サービス
    │   └── supabase.ts   # SupabaseServiceクラス
    ├── audio/            # 音声・メディア制御
    │   ├── manager.ts    # AudioManagerクラス
    │   └── queue.ts      # AudioPlaybackQueueクラス
    └── ui/               # UIコンポーネント (DOM操作とレンダリング)
        ├── controller.ts # UIControllerクラス
        ├── community.ts  # CommunitySelectorUIクラス
        ├── users.ts      # UserListUIクラス
        ├── groups.ts     # GroupListUIクラス
        └── chat.ts       # ChatWindowUIクラス
```

---

## 5. ローカル開発サーバーの起動とデバッグ

### 5.1. 開発サーバーの起動
ローカルでコードを動かすための高速な開発サーバーを立ち上げます。

```bash
npm run dev
```

起動に成功すると、ターミナルに以下のようなURLが表示されます。
```text
  VITE v5.x.x  ready in xxx ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```
ブラウザで `http://localhost:5173/` にアクセスすると、アプリが立ち上がります。

### 5.2. TypeScriptでのデバッグ方法
Viteは自動で**ソースマップ**を生成するため、ブラウザ上で直接TypeScriptファイルをデバッグできます。

1. Chrome等でアプリを開き、**F12キー** を押してデベロッパーツールを開きます。
2. **Sources** (ソース) タブを選択します。
3. `Page` ツリーの `file://` または `localhost:5173` -> `src/` の下にある `.ts` ファイル（例: `app.ts` や `manager.ts`）を直接開きます。
4. 行番号をクリックしてブレークポイントを置き、アプリを操作することで、TSコードのステップ実行や変数の値（ホバー確認）が行えます。

---

## 6. 本番用のビルド手順

本番環境（Supabase HostingやVercelなど）にデプロイするために、ブラウザが理解できる最適化されたプレーンなHTML/CSS/JSにコンパイル・バンドルします。

```bash
npm run build
```

* 実行が成功すると、ルート配下に **`dist/`** ディレクトリが作成され、その中に公開用のファイルが出力されます。
* `dist/` フォルダの中身だけで完全に静的サイトとして機能するため、どこにでもホスティング可能です。

---

## 7. Firebase Hosting へのデプロイ手順

本プロジェクトをFirebase Hosting（無料枠あり）へデプロイし、公開するまでの手順です。ワークスペース内のローカルインストールされたFirebase CLIを利用するため、環境を汚さずに実行できます。

### 7.1. Firebase CLIのインストール
ワークスペースの開発依存パッケージとして `firebase-tools` をインストールします。

```bash
npm install -D firebase-tools
```

### 7.2. Firebaseへのログイン
以下のコマンドを実行するとブラウザが起動します。Googleアカウントでログインし、CLIからのアクセスを許可してください。

```bash
npx firebase login
```

### 7.3. Firebaseプロジェクトの作成（CLIから）
Webコンソールを開かずに、コマンドラインから新しいFirebaseプロジェクトを作成します。

```bash
npx firebase projects:create
```
* **Project ID:** 世界で一意のID（例: `chatransceiver-yourname`）を入力します。
* **Display Name:** 任意の表示名を入力します。

### 7.4. Hostingの初期化設定
プロジェクトを指定し、Hostingの設定を行います。

```bash
npx firebase init hosting
```
以下の質問には次のように答えてください：
1. **What do you want to use as your public directory?**
   * `dist` と入力してEnter（Viteの出力先）
2. **Configure as a single-page app (rewrite all urls to /index.html)?**
   * `Yes` または `y` と入力（SPAとしてルーティングを有効化）
3. **Set up automatic builds and deploys with GitHub?**
   * `No` または `N` と入力（今回は手動デプロイを想定）

### 7.5. 本番ビルドとデプロイの実行

```bash
# 1. アプリを本番用にビルド（環境変数を反映し、distフォルダを生成）
npm run build

# 2. 生成されたdistフォルダをFirebaseにアップロード
npx firebase deploy --only hosting
```

### 7.6. 【重要】Supabase側のリダイレクトURL追加
デプロイが完了すると、`https://<project-id>.web.app` または `https://<project-id>.firebaseapp.com` という公開URLが表示されます。
Google認証の完了後にこのURLに正常に戻れるようにするため、**Supabaseのダッシュボード**で以下の設定を行ってください。

1. Supabaseダッシュボード > **Authentication** > **URL Configuration** を開く。
2. **Site URL** を Firebaseの公開URL（例: `https://chatransceiver-yourname.web.app`）に変更する。
3. または、**Redirect URLs** に Firebaseの公開URL を追加登録する。
