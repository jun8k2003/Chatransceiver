# バックエンド開発環境の構築手順 (docs/setup_backend.md)

このファイルは、Supabase (クラウド無料プラン) を使用して、本プロジェクトに必要なデータベース（PostgreSQL）、認証（Auth）、音声ストレージ（Storage）、およびリアルタイム同期（Realtime）を構築するための手順書です。

はじめて Supabase を使用する方を前提に、アカウント作成からスクリプトによる一括DB構築までを解説します。

---

## 1. アカウント作成とプロジェクトの作成

### 1.1. アカウント登録
1. [Supabase 公式サイト (https://supabase.com/)](https://supabase.com/) にアクセスします。
2. 右上の **「Start your project」** または **「Sign Up」** をクリックします。
3. GitHub アカウント連携、または Eメールアドレスを入力してアカウントを新規作成します。

### 1.2. プロジェクトの新規作成
1. ログイン後、ダッシュボード画面で **「New Project」** ボタンをクリックします。
2. 以下の項目を入力・選択します。
   * **Organization**: 自分のアカウント（デフォルト）を選択。
   * **Name**: プロジェクト名を入力（例: `Chatransceiver`）。
   * **Database Password**: データベースのパスワードを設定し、**必ず厳重にメモして保存**してください（後から確認できません）。
   * **Region**: 最寄りのリージョンを選択（日本国内であれば **`Tokyo (ap-northeast-1)`** を強く推奨）。
   * **Pricing Plan**: **`Free`** (無料枠) を選択。
3. **「Create new project」** をクリックします。
4. ※データベースの起動と準備が完了するまで、数分（2〜3分程度）かかります。画面がダッシュボードに切り替わるまでお待ちください。

---

## 2. データベースのスクリプト構築 (SQL Editor)

Supabaseでは、Webコンソール上の「SQL Editor」を使うことで、テーブル作成、インデックス、RLS、トリガー関数などの設定をSQLスクリプトで一括実行できます。

### 2.1. SQL Editor を開く
1. 画面左側のメニューにある **「SQL Editor」** アイコン（SQLマーク）をクリックします。
2. **「New query」**（または「Create a new SQL snippet」）をクリックして、新しいクエリ作成画面を開きます。

### 2.2. スクリプトの実行
以下のSQLブロックをすべてコピーし、SQL Editor の入力欄に貼り付け、右下の **「Run」** ボタンをクリックします。

```sql
-- ========================================================
-- 1. テーブルの作成 (DDL)
-- ========================================================

-- users テーブル (Supabaseの認証ユーザーテーブル auth.users と紐付け)
create table public.users (
  id uuid references auth.users on delete cascade primary key,
  name varchar not null,
  email varchar not null,
  avatar_url text,
  created_at timestamptz default now() not null
);

-- communities テーブル
create table public.communities (
  id uuid default gen_random_uuid() primary key,
  name varchar not null,
  slug varchar unique not null,
  invite_code varchar not null,
  created_at timestamptz default now() not null
);

-- community_members テーブル
create table public.community_members (
  community_id uuid references public.communities on delete cascade,
  user_id uuid references public.users on delete cascade,
  user_number int not null,
  joined_at timestamptz default now() not null,
  primary key (community_id, user_id)
);

-- chat_rooms テーブル
create table public.chat_rooms (
  id uuid default gen_random_uuid() primary key,
  type varchar not null check (type in ('individual', 'group')),
  community_id uuid references public.communities on delete cascade,
  created_at timestamptz default now() not null
);

-- chat_room_members テーブル
create table public.chat_room_members (
  room_id uuid references public.chat_rooms on delete cascade,
  user_id uuid references public.users on delete cascade,
  joined_at timestamptz default now() not null,
  primary key (room_id, user_id)
);

-- messages テーブル
create table public.messages (
  id uuid default gen_random_uuid() primary key,
  room_id uuid references public.chat_rooms on delete cascade not null,
  sender_id uuid references public.users on delete set null,
  audio_url text,
  text_content text,
  created_at timestamptz default now() not null
);

-- user_inboxes テーブル
create table public.user_inboxes (
  id bigserial primary key,
  user_id uuid references public.users on delete cascade not null,
  room_id uuid references public.chat_rooms on delete cascade not null,
  message_id uuid references public.messages on delete cascade not null,
  is_read boolean default false not null,
  created_at timestamptz default now() not null
);

-- ========================================================
-- 2. パフォーマンス向上のためのインデックス設定
-- ========================================================
create index idx_community_members_user on public.community_members(user_id);
create index idx_chat_room_members_user on public.chat_room_members(user_id);
create index idx_messages_room on public.messages(room_id);
create index idx_user_inboxes_user_unread on public.user_inboxes(user_id) where is_read = false;

-- ========================================================
-- 3. Row Level Security (RLS) の有効化とポリシー設定
-- ========================================================

alter table public.users enable row level security;
alter table public.communities enable row level security;
alter table public.community_members enable row level security;
alter table public.chat_rooms enable row level security;
alter table public.chat_room_members enable row level security;
alter table public.messages enable row level security;
alter table public.user_inboxes enable row level security;

-- 3.1. users ポリシー
create policy "Users can read all user profiles" on public.users for select using (true);
create policy "Users can update their own profile" on public.users for update using (auth.uid() = id);

-- 3.2. communities ポリシー (誰でもコミュニティを作成・検索できる)
create policy "Authenticated users can view communities" on public.communities for select using (auth.role() = 'authenticated');
create policy "Authenticated users can create communities" on public.communities for insert with check (auth.role() = 'authenticated');

-- 3.3. community_members ポリシー
create policy "Authenticated users can view community membership" on public.community_members for select using (auth.role() = 'authenticated');
create policy "Users can join a community" on public.community_members for insert with check (auth.uid() = user_id);
create policy "Users can leave a community" on public.community_members for delete using (auth.uid() = user_id);

-- 3.4. chat_rooms ポリシー
create policy "Authenticated users can view chat rooms" on public.chat_rooms for select using (auth.role() = 'authenticated');
create policy "Authenticated users can create chat rooms" on public.chat_rooms for insert with check (auth.role() = 'authenticated');

-- 3.5. chat_room_members ポリシー
create policy "Authenticated users can view room membership" on public.chat_room_members for select using (auth.role() = 'authenticated');
create policy "Authenticated users can add members to rooms" on public.chat_room_members for insert with check (auth.role() = 'authenticated');
create policy "Users can leave rooms" on public.chat_room_members for delete using (auth.uid() = user_id);

-- 3.6. messages ポリシー
create policy "Authenticated users can view messages" on public.messages for select using (auth.role() = 'authenticated');
create policy "Users can post messages" on public.messages for insert with check (auth.uid() = sender_id);

-- 3.7. user_inboxes ポリシー
create policy "Users can manage their own inbox" on public.user_inboxes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ========================================================
-- 4. 新着メッセージ自動配信用のデータベーストリガー (Fan-Out)
-- ========================================================

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
    and m.user_id != new.sender_id;

  return new;
end;
$$;

create trigger on_message_created
  after insert on public.messages
  for each row
  execute function public.handle_new_message_fanout();

-- ========================================================
-- 5. Supabase Auth 新規ユーザー登録時の自動プロフィール作成トリガー
-- ========================================================
-- Google等で初回ログインした際、auth.usersの情報を public.users に自動コピーする仕組み
create or replace function public.handle_new_user_profile()
returns trigger
security definer
set search_path = public
language plpgsql
as $$
begin
  insert into public.users (id, name, email, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', 'No Name'),
    new.email,
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user_profile();
```

貼り付けた後、画面右下の **「Run」** ボタンをクリックします。
「Success」と表示されれば、すべてのテーブル、インデックス、RLS、トリガーの構築が完了です。

---

## 3. 音声ファイル用ストレージ (Storage) の作成と権限設定

録音された音声ファイルを保存するためのバケットを作成し、アップロード権限を付与します。

1. 左側メニューの **「Storage」** アイコン（箱のマーク）をクリックします。
2. **「Create Bucket」**（または「New Bucket」）をクリックします。
3. 以下の通り設定します。
   * **Bucket Name**: `voice-messages` (必ず小文字でこの名称にしてください)
   * **Public Bucket**: **ON** にします（音声URLをフロントエンドから直接再生できるようにするため）。
4. **「Save」** をクリックします。

**【重要】アップロード権限（Storage RLS）の追加**
バケットを作成しただけでは書き込み（アップロード）がブロックされてしまうため、以下のSQLを「SQL Editor」で実行してアップロードを許可してください。

```sql
-- ログイン済みユーザーに音声ファイルのアップロードを許可する
create policy "Authenticated users can upload voice messages"
  on storage.objects for insert
  with check ( bucket_id = 'voice-messages' and auth.role() = 'authenticated' );

-- 誰でも音声ファイルを読み取れるようにする
create policy "Anyone can view voice messages"
  on storage.objects for select
  using ( bucket_id = 'voice-messages' );
```

---

## 4. Supabase Realtime の有効化

チャットメッセージと `user_inboxes` をリアルタイムで常時リッスンするため、Realtime機能をデータベーステーブルに対して有効化します。以下のいずれかの方法で設定を行ってください。

### 方法A. SQL Editor で SQL を実行する (最も簡単・推奨)
SQL Editor を開き、新しいクエリ（New Query）で以下の SQL コマンドを実行（Run）します。
```sql
alter publication supabase_realtime add table public.user_inboxes;
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.community_members;
```

### 方法B. Webコンソール (GUI) から設定する
1. 画面左側メニューの「DATABASE MANAGEMENT」内にある **「Publications」** をクリックします。
2. 表示されたリスト内の **`supabase_realtime`** の行の「Edit」ボタン（または Active tables の数値部分）をクリックします。
3. 以下の対象テーブルにチェックを入れて、またはスイッチを **ON** にして保存します。
   * **`user_inboxes`** (新着自動再生のトリガー監視用、必須)
   * **`messages`** (表示中のチャット履歴更新用)
   * **`community_members`** (オンライン状態やメンバーの追加監視用)

---

## 5. APIキーと接続URLの取得（フロントエンドとの接続設定）

SupabaseのAPIキーシステムが新しくアップデートされたため、案内表示やキーの形式が従来のドキュメントと異なっています。以下の手順で最新の情報を取得してください。

### 5.1. APIキー (Publishable key) の取得
1. 左側メニュー最下部の **「Project Settings」** (歯車マーク) ➜ **「API Keys」** を選択します（送信いただいた画面です）。
2. **「Publishable key」** セクションの `default` 行にある **`sb_publishable_...`** で始まるキーのコピーボタンをクリックしてコピーします。
   * ※これが従来の「`anon` (public) キー」に相当し、ブラウザ（フロントエンド）から安全にアクセスするために使用するキーです。

### 5.2. 接続URL (Project URL) の取得
1. 左側メニューの「INTEGRATIONS」セクションにある **「Data API」**（API Keys の少し下にあります）をクリックします。
2. 画面内に表示されている **「Project URL」**（`https://xxxxxxxx.supabase.co` 形式のURL）のコピーボタンをクリックしてコピーします。

### 5.3. `.env` ファイルの作成
フロントエンドのプロジェクトのルートディレクトリ（`c:/DATA/git/jun8k2003/Chatransceiver/`）に **`.env`** というファイルを新規作成し、以下のようにコピーした内容を定義します。

```env
# Vite で環境変数を読み込むためのプレフィックス (VITE_) を付けて保存します
VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_fG7wP6rTR...
```
※注意: `VITE_SUPABASE_URL` の末尾に `/rest/v1/` などを付けたり、改行を入れたりするとエラーになります。必ず1行で正確にコピーしてください。

Vite環境では、これらの変数を `import.meta.env.VITE_SUPABASE_URL` などの形式でTSコードから安全に取得できます。

---

## 6. Google OAuthログイン設定 (Google連携)

本アプリはGoogleアカウントによる認証を使用します。以下の設定を行わないとログインができません。

### 6.1. Google Cloud Console の設定
1. [Google Cloud Console](https://console.cloud.google.com/) にアクセスし、プロジェクトを作成します。
2. 左側メニュー（≡）から **「API とサービス」 > 「OAuth 同意画面」** を開き、外部向けに同意画面を作成します。
3. **「API とサービス」 > 「認証情報」** を開き、「＋ 認証情報を作成」から **「OAuth クライアント ID」** を選びます。
4. 以下の通りに入力します：
   * アプリケーションの種類: **ウェブ アプリケーション**
   * 承認済みの JavaScript 発生元: **`http://localhost:5173`** (ローカル開発時)
   * 承認済みのリダイレクト URI: **`https://[あなたのSupabase_URLホスト名]/auth/v1/callback`**
5. 作成後、**「クライアント ID」** と **「クライアント シークレット」** が表示されるのでコピーします。

### 6.2. Supabase ダッシュボードへの登録
1. Supabaseの左側メニューから **「Authentication」**（鍵アイコン）を開きます。
2. その横に表示されるサブメニュー内の **「Configuration」 > 「Providers」** をクリックします。
3. リストから **「Google」** を選び、スイッチを **ON (Enabled)** にします。
4. さきほどコピーした **Client ID** と **Client Secret** を貼り付けて **「Save」** を押します。

これでGoogle連携によるログイン準備はすべて完了です！
