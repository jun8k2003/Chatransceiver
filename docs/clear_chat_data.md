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
> データベース上のレコード（URL）は上記のSQLで消去されますが、**Supabase Storage（ストレージ）に保存された実際の音声ファイル（.webm）はSQLでは消去されません**。
> 音声ファイル自体も完全に空にしたい場合は、Supabaseダッシュボードの **Storage** メニューから `voice-messages` バケットを開き、中に入っているファイルを全選択して手動で削除してください。
