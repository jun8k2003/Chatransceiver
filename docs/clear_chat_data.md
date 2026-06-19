# データベースリセット SQL

チャット履歴（メッセージ、未読管理データ）と、グループ・個別チャットのルームデータをすべて初期化するためのSQLです。
以下のSQLを Supabase ダッシュボードの **SQL Editor** に貼り付けて実行（Run）してください。

```sql
-- 1. メッセージデータを全消去
TRUNCATE TABLE messages CASCADE;

-- 2. 未読管理（インボックス）データを全消去
TRUNCATE TABLE user_inboxes CASCADE;

-- 3. チャットルームの参加者紐付けデータを全消去
TRUNCATE TABLE chat_room_members CASCADE;

-- 4. グループおよび個別チャットのルーム自体を全消去
TRUNCATE TABLE chat_rooms CASCADE;
```

> [!TIP]
> `CASCADE` オプションをつけているため、もしテーブル間で外部キー制約（Foreign Key）が設定されている場合でも安全に紐づくデータごと消去されます。
> （個別チャットのルームは、次回ユーザー同士がチャットを開いた際に自動で再作成される仕様になっているため、ここで全消去しても問題ありません。）

> [!WARNING]
> **音声ファイルの削除について**
> 通常のアプリ操作（メッセージ削除・コミュニティ退出など）でメッセージ行が削除された場合は、Database Webhook → Edge Function (`delete-audio-on-message-delete`) により Storage 上の音声ファイル（.webm）も自動削除されます（setup_backend.md §7）。
> ただし、上記の `TRUNCATE` による一括初期化は **Webhook（行トリガー）を発火させない**ため、**Supabase Storage に保存された実際の音声ファイルは消去されません**。
> `TRUNCATE` でリセットした場合や、過去のバグ期間中に残った孤児ファイルを完全に空にしたい場合は、Supabaseダッシュボードの **Storage** メニューから `voice-messages` バケットを開き、中のファイルを全選択して手動で削除してください。
