import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey);

export interface SupabaseUser {
  id: string;
  name: string;
  email: string;
  discord_webhook_url?: string;
}

export interface SupabaseCommunity {
  id: string;
  name: string;
  slug: string;
}

export interface SupabaseMember {
  id: string;
  name: string;
  userNumber: number;
  isOnline: boolean;
  unreadCount?: number;
  latestUnreadTime?: number;
}

export interface SupabaseGroup {
  id: string;
  name: string;          // 表示名 (カスタム名があればそれ、無ければメンバー名の羅列)
  customName?: string;   // chat_rooms.name のカスタム名 (DEC-023)。未設定時は undefined
  memberNames: string;   // メンバー名のカンマ羅列 (ヘッダーのサブ表示用)
  memberCount: number;
  unreadCount: number;
  latestUnreadTime?: number;
}

export interface SupabaseMessage {
  id: string;
  senderId: string;
  senderName: string;
  audioUrl?: string;
  textContent: string;
  isRevoked?: boolean;
  createdAt: Date;
}

export class SupabaseService {
  /**
   * Google でログイン (OAuth)
   * @param redirectTo リダイレクト先URL (省略可能)
   */
  async signInWithGoogle(redirectTo?: string): Promise<void> {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectTo
      }
    });

    if (error) throw error;
    // OAuthの場合、ここでリダイレクトが発生するため戻り値は通常処理されません
  }

  /**
   * Magic Link (メールリンク) でログイン (OTP)
   * メールアドレス宛にワンタイムのログインリンクを送信する。
   * 初回利用時はアカウントが自動作成される (サインアップ兼ログイン)。
   * @param email 送信先メールアドレス
   * @param redirectTo リンククリック後の戻り先URL (省略可能)
   */
  async signInWithMagicLink(email: string, redirectTo?: string): Promise<void> {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectTo
        // shouldCreateUser はデフォルト true (未登録メールは自動でサインアップ)
      }
    });

    if (error) throw error;
    // 送信成功後はメール内リンクのクリックを待つ (リダイレクトでセッション確立)
  }

  /**
   * サインアウト
   */
  async signOut(): Promise<void> {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }

  /**
   * 現在のセッションを取得
   */
  async getSession(): Promise<any> {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) throw error;
    return session;
  }

  /**
   * 現在のセッションユーザー情報を取得
   */
  async getCurrentUser(): Promise<SupabaseUser | null> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    let { data: profile, error } = await supabase
      .from('users')
      .select('name, discord_webhook_url')
      .eq('id', user.id)
      .maybeSingle();

    const fallbackName = user.user_metadata?.name || user.user_metadata?.full_name || 'No Name';

    if (error || !profile) {
      // プロフィールが存在しない場合は自動作成(Upsert)して修復する
      const { data: newProfile, error: upsertError } = await supabase
        .from('users')
        .upsert({
          id: user.id,
          name: fallbackName,
          email: user.email || '',
          avatar_url: user.user_metadata?.avatar_url || ''
        }, { onConflict: 'id' })
        .select('name, discord_webhook_url')
        .single();
        
      if (!upsertError && newProfile) {
        profile = newProfile;
      } else {
        console.error('Failed to auto-repair user profile:', upsertError);
      }
    }

    return {
      id: user.id,
      name: profile?.name || fallbackName,
      email: user.email || '',
      discord_webhook_url: profile?.discord_webhook_url || ''
    };
  }

  /**
   * ニックネームの更新
   */
  async updateNickname(userId: string, newName: string): Promise<void> {
    const { error } = await supabase
      .from('users')
      .update({ name: newName })
      .eq('id', userId);

    if (error) throw error;
  }

  /**
   * Discord Webhook URLの更新
   */
  async updateDiscordWebhook(userId: string, webhookUrl: string): Promise<void> {
    const { error } = await supabase
      .from('users')
      .update({ discord_webhook_url: webhookUrl })
      .eq('id', userId);

    if (error) throw error;
  }

  /**
   * コミュニティへの接続（参加していない場合は所属メンバーに自動追加）
   */
  async connectCommunity(userId: string, slug: string): Promise<SupabaseCommunity> {
    // 1. コミュニティが存在するか確認
    let { data: community, error: cError } = await supabase
      .from('communities')
      .select('*')
      .eq('slug', slug)
      .single();

    if (cError || !community) {
      // 無ければ自動でモック用のコミュニティを自動作成（手軽にテストできるようにするため）
      const newCommunity = {
        name: `${slug.toUpperCase()} コミュニティ`,
        slug: slug,
        invite_code: 'code_' + slug
      };
      
      const { data, error } = await supabase
        .from('communities')
        .insert(newCommunity)
        .select()
        .single();
        
      if (error) throw error;
      community = data;
    }

    // 2. コミュニティに既に参加しているか確認
    const { data: membership, error: membershipError } = await supabase
      .from('community_members')
      .select('*')
      .eq('community_id', community.id)
      .eq('user_id', userId)
      .maybeSingle();

    if (membershipError && membershipError.code !== 'PGRST116') {
      console.warn('Membership check error:', membershipError);
    }

    if (!membership) {
      // 3. 参加していない場合はメンバーに追加（user_number は自動採番または連番）
      // 退会者が出た場合の重複を防ぐため、現在の最大の user_number を取得して +1 する
      const { data: maxMember } = await supabase
        .from('community_members')
        .select('user_number')
        .eq('community_id', community.id)
        .order('user_number', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      const nextNumber = (maxMember?.user_number || 0) + 1;

      const { error: joinError } = await supabase
        .from('community_members')
        .upsert({
          community_id: community.id,
          user_id: userId,
          user_number: nextNumber
        }, {
          onConflict: 'community_id, user_id'
        });

      if (joinError) {
        throw joinError;
      }
    }

    return {
      id: community.id,
      name: community.name,
      slug: community.slug
    };
  }

  /**
   * コミュニティからの退出 (メンバーシップ削除)
   */
  async leaveCommunity(userId: string, communityId: string): Promise<void> {
    const { error } = await supabase
      .rpc('leave_community_and_cleanup', {
        p_user_id: userId,
        p_community_id: communityId
      });

    if (error) {
      console.error('Failed to leave community in DB:', error);
      throw error;
    }
  }

  /**
   * コミュニティ所属メンバーの取得
   */
  async getCommunityMembers(communityId: string, currentUserId: string): Promise<SupabaseMember[]> {
    const { data, error } = await supabase
      .from('community_members')
      .select('user_number, users(id, name)')
      .eq('community_id', communityId);

    if (error) throw error;

    // 自分自身は個別チャット一覧に表示させない（DEC-021）
    const others = (data || []).filter((item: any) => item.users.id !== currentUserId);

    return others.map((item: any) => {
      const u = item.users;
      return {
        id: u.id,
        name: u.name,
        userNumber: item.user_number,
        isOnline: false // Presenceで後から更新される
      };
    });
  }

  /**
   * コミュニティ内のグループチャット一覧を取得
   */
  async getCommunityGroups(communityId: string, userId: string): Promise<SupabaseGroup[]> {
    // 自分が参加しているグループルームを取得
    const { data, error } = await supabase
      .from('chat_room_members')
      .select('room_id, chat_rooms(id, type, community_id, name)')
      .eq('user_id', userId);

    if (error) throw error;

    const groupRooms = (data || [])
      .filter((item: any) => item.chat_rooms && item.chat_rooms.type === 'group' && item.chat_rooms.community_id === communityId)
      .map((item: any) => item.chat_rooms);

    const result: SupabaseGroup[] = [];

    for (const room of groupRooms) {
      // グループ名およびメンバー数を取得
      const { data: members, error: mErr } = await supabase
        .from('chat_room_members')
        .select('users(name)')
        .eq('room_id', room.id);

      if (mErr) continue;
      
      // メンバー数が2人以下のグループ（自分だけ、または1対1）は個別チャットと重複するため表示しない
      if (!members || members.length <= 2) {
        continue;
      }

      const memberNames = (members || []).map((m: any) => m.users?.name).join(', ');
      // カスタム名があれば優先し、無ければメンバー名の羅列を表示名とする (DEC-023)
      const groupName = room.name || memberNames;
      
      // 未読数をカウントし、最新の未読メッセージ日時を取得
      const { data: inboxData } = await supabase
        .from('user_inboxes')
        .select('messages!inner(created_at)')
        .eq('room_id', room.id)
        .eq('user_id', userId)
        .eq('is_read', false);

      const unreadCount = inboxData?.length || 0;
      let latestUnreadTime = 0;
      if (inboxData && inboxData.length > 0) {
        latestUnreadTime = Math.max(...inboxData.map((d: any) => new Date(d.messages.created_at).getTime()));
      }

      result.push({
        id: room.id,
        name: groupName || '名称未設定グループ',
        customName: room.name || undefined,
        memberNames: memberNames,
        memberCount: members?.length || 0,
        unreadCount: unreadCount,
        latestUnreadTime: latestUnreadTime || undefined
      });
    }

    return result;
  }

  /**
   * グループ名（表示上のあだ名）の更新 (DEC-023)
   * 空文字を渡すと NULL に戻し、メンバー名の羅列表示にフォールバックする
   */
  async updateRoomName(roomId: string, newName: string): Promise<void> {
    const { error } = await supabase
      .from('chat_rooms')
      .update({ name: newName.trim() || null })
      .eq('id', roomId);

    if (error) throw error;
  }

  /**
   * ユーザーの個別チャットごとの未読メッセージ数を取得します。
   */
  async getUnreadIndividualCounts(userId: string): Promise<Record<string, { count: number; latestTime: number }>> {
    const { data, error } = await supabase
      .from('user_inboxes')
      .select('messages!inner(sender_id, created_at), chat_rooms!inner(type)')
      .eq('user_id', userId)
      .eq('is_read', false)
      .eq('chat_rooms.type', 'individual');

    if (error) {
      console.error('Failed to get unread individual counts:', error);
      return {};
    }

    const result: Record<string, { count: number; latestTime: number }> = {};
    (data || []).forEach((item: any) => {
      const senderId = item.messages?.sender_id;
      const createdAt = new Date(item.messages?.created_at).getTime();
      if (senderId) {
        if (!result[senderId]) {
          result[senderId] = { count: 0, latestTime: 0 };
        }
        result[senderId].count++;
        result[senderId].latestTime = Math.max(result[senderId].latestTime, createdAt);
      }
    });

    return result;
  }

  /**
   * 特定ユーザーとの1対1チャットルームのIDを取得または作成
   */
  async getOrCreateIndividualRoom(communityId: string, currentUserId: string, targetUserId: string): Promise<string> {
    // 自分と相手の両方が含まれる individual タイプのチャットルームを検索
    const { data: myRooms, error: err1 } = await supabase
      .from('chat_room_members')
      .select('room_id, chat_rooms(id, type, community_id)')
      .eq('user_id', currentUserId);

    if (err1) throw err1;

    const indRooms = (myRooms || [])
      .filter((r: any) => r.chat_rooms && r.chat_rooms.type === 'individual' && r.chat_rooms.community_id === communityId)
      .map((r: any) => r.room_id);

    if (indRooms.length > 0) {
      // それらの部屋の中から、相手も入っている部屋を検索
      const { data: match } = await supabase
        .from('chat_room_members')
        .select('room_id')
        .in('room_id', indRooms)
        .eq('user_id', targetUserId)
        .maybeSingle();

      if (match) return match.room_id;
    }

    // 見つからなければ新規作成
    // 1. ルーム作成
    const { data: newRoom, error: err3 } = await supabase
      .from('chat_rooms')
      .insert({
        type: 'individual',
        community_id: communityId
      })
      .select()
      .single();

    if (err3) throw err3;

    // 2. メンバー追加（自分と相手）
    const { error: err4 } = await supabase
      .from('chat_room_members')
      .insert([
        { room_id: newRoom.id, user_id: currentUserId },
        { room_id: newRoom.id, user_id: targetUserId }
      ]);

    if (err4) throw err4;

    return newRoom.id;
  }

  /**
   * 複数選択されたメンバーでグループチャットを作成
   */
  async createGroupRoom(communityId: string, currentUserId: string, memberUserIds: string[]): Promise<string> {
    // 全メンバーリスト（自分を含む）
    const allUserIds = Array.from(new Set([currentUserId, ...memberUserIds]));

    // 1. ルーム作成
    const { data: newRoom, error: err1 } = await supabase
      .from('chat_rooms')
      .insert({
        type: 'group',
        community_id: communityId
      })
      .select()
      .single();

    if (err1) throw err1;

    // 2. メンバーの紐付け
    const inserts = allUserIds.map((uid) => ({ room_id: newRoom.id, user_id: uid }));
    const { error: err2 } = await supabase
      .from('chat_room_members')
      .insert(inserts);

    if (err2) throw err2;

    return newRoom.id;
  }

  /**
   * 指定したルームの過去メッセージ履歴を取得
   */
  async getRoomMessages(roomId: string): Promise<SupabaseMessage[]> {
    const { data, error } = await supabase
      .from('messages')
      .select('id, sender_id, audio_url, text_content, is_revoked, created_at, users(name)')
      .eq('room_id', roomId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    return (data || []).map((item: any) => ({
      id: item.id,
      senderId: item.sender_id,
      senderName: item.users?.name || 'No Name',
      audioUrl: item.audio_url || undefined,
      textContent: item.text_content || '',
      isRevoked: item.is_revoked || false,
      createdAt: new Date(item.created_at)
    }));
  }

  /**
   * メッセージIDから所属するルームやコミュニティ情報を取得する (ダイレクトリンク用)
   */
  async getMessageInfo(messageId: string): Promise<{ roomId: string, roomType: string, communitySlug: string, audioUrl?: string } | null> {
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('room_id, audio_url, chat_rooms(type, communities(slug))')
        .eq('id', messageId)
        .single();

      if (error || !data) return null;

      const chatRooms: any = data.chat_rooms;
      const communities: any = chatRooms?.communities;

      return {
        roomId: data.room_id,
        roomType: chatRooms?.type || '',
        communitySlug: communities?.slug || '',
        audioUrl: data.audio_url || undefined,
      };
    } catch (e) {
      console.error('Failed to getMessageInfo:', e);
      return null;
    }
  }

  /**
   * メッセージ送信（音声アップロード対応）
   */
  async sendMessage(roomId: string, senderId: string, text: string, audioBlob?: Blob): Promise<SupabaseMessage> {
    let audioUrl: string | undefined = undefined;

    if (audioBlob) {
      // 1. 音声ファイルを Storage バケット `voice-messages` にアップロード
      const fileName = `${senderId}/${Date.now()}.webm`;
      const { error: uploadError } = await supabase.storage
        .from('voice-messages')
        .upload(fileName, audioBlob, {
          contentType: 'audio/webm',
          cacheControl: '3600'
        });

      if (uploadError) throw uploadError;

      // 公開URLを取得
      const { data } = supabase.storage
        .from('voice-messages')
        .getPublicUrl(fileName);
        
      audioUrl = data.publicUrl;
    }

    // 2. メッセージを messages テーブルに挿入
    const { data: newMsg, error: insertError } = await supabase
      .from('messages')
      .insert({
        room_id: roomId,
        sender_id: senderId,
        audio_url: audioUrl || null,
        text_content: text
      })
      .select('id, sender_id, audio_url, text_content, is_revoked, created_at, users(name)')
      .single();

    if (insertError) throw insertError;

    return {
      id: newMsg.id,
      senderId: newMsg.sender_id,
      senderName: (newMsg.users as any)?.name || 'No Name',
      audioUrl: newMsg.audio_url || undefined,
      textContent: newMsg.text_content || '',
      isRevoked: newMsg.is_revoked || false,
      createdAt: new Date(newMsg.created_at)
    };
  }

  /**
   * 発言の取り消し
   */
  async revokeMessage(messageId: string, currentUserId: string): Promise<void> {
    // まず対象メッセージを取得
    const { data: msg, error: fetchError } = await supabase
      .from('messages')
      .select('audio_url, sender_id')
      .eq('id', messageId)
      .single();

    if (fetchError) throw fetchError;
    if (msg.sender_id !== currentUserId) throw new Error('Unauthorized');

    // Storageから音声ファイルの実体を削除
    if (msg.audio_url) {
      // URLからファイルパスを抽出 (例: https://.../voice-messages/USER_ID/TIME.webm -> USER_ID/TIME.webm)
      const parts = msg.audio_url.split('/voice-messages/');
      if (parts.length === 2) {
        const filePath = parts[1].split('?')[0]; // クエリパラメータがあれば除去
        const { error: removeError } = await supabase.storage
          .from('voice-messages')
          .remove([filePath]);
        if (removeError) {
          console.error('Failed to remove audio file from storage:', removeError);
        }
      }
    }

    // DBレコードを取り消し状態に更新
    const { error: updateError } = await supabase
      .from('messages')
      .update({
        is_revoked: true,
        text_content: null,
        audio_url: null
      })
      .eq('id', messageId);

    if (updateError) throw updateError;
  }

  /**
   * 自分宛てのインボックス (新着自動再生トリガー) をリアルタイム購読
   */
  subscribeInbox(userId: string, onNewInboxItem: (inboxItem: any) => void): any {
    return supabase
      .channel(`inbox:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'user_inboxes',
          filter: `user_id=eq.${userId}`
        },
        async (payload) => {
          // メッセージ詳細を取得する
          const { data: msg, error } = await supabase
            .from('messages')
            .select('id, room_id, sender_id, audio_url, text_content, users(name)')
            .eq('id', payload.new.message_id)
            .single();

          if (!error && msg) {
            onNewInboxItem({
              id: msg.id,
              roomId: msg.room_id,
              senderId: msg.sender_id,
              senderName: (msg.users as any)?.name || 'No Name',
              audioUrl: msg.audio_url,
              textContent: msg.text_content
            });
          }
        }
      )
      .subscribe();
  }

  /**
   * 特定のチャットルームの新着メッセージをリアルタイム購読
   * @param onResync 購読が「再確立」された際に呼ばれる（切断中の取りこぼし補完用）。
   *   初回の確立では呼ばれない（呼び出し側が直前に履歴を取得済みのため、二重取得を避ける）。
   */
  subscribeRoomMessages(
    roomId: string,
    onNewMessage: (msg: SupabaseMessage) => void,
    onUpdateMessage?: (msg: SupabaseMessage) => void,
    onResync?: () => void
  ): any {
    // 初回の SUBSCRIBED か、切断からの再確立かを区別するためのフラグ
    let subscribedOnce = false;

    return supabase
      .channel(`room:${roomId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages',
          filter: `room_id=eq.${roomId}`
        },
        async (payload) => {
          const recordId = payload.eventType === 'DELETE' ? payload.old.id : payload.new.id;

          // 送信者名を含むメッセージ詳細を取得
          const { data: msg, error } = await supabase
            .from('messages')
            .select('id, sender_id, audio_url, text_content, is_revoked, created_at, users(name)')
            .eq('id', recordId)
            .single();

          if (!error && msg) {
            const transformedMsg = {
              id: msg.id,
              senderId: msg.sender_id,
              senderName: (msg.users as any)?.name || 'No Name',
              audioUrl: msg.audio_url || undefined,
              textContent: msg.text_content || '',
              isRevoked: msg.is_revoked || false,
              createdAt: new Date(msg.created_at)
            };
            if (payload.eventType === 'INSERT') {
              onNewMessage(transformedMsg);
            } else if (payload.eventType === 'UPDATE' && onUpdateMessage) {
              onUpdateMessage(transformedMsg);
            }
          }
        }
      )
      .subscribe((status) => {
        // SUBSCRIBED は初回確立時と、切断後の再確立時の両方で発火する。
        // 2回目以降（=再接続）のみ、切断中に届いた可能性のあるメッセージを補完する。
        if (status === 'SUBSCRIBED') {
          if (subscribedOnce) {
            onResync?.();
          } else {
            subscribedOnce = true;
          }
        }
      });
  }

  /**
   * インボックスアイテム（未読メッセージ）を既読にする
   */
  async markAsRead(roomId: string, userId: string): Promise<void> {
    const { error } = await supabase
      .from('user_inboxes')
      .update({ is_read: true })
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) console.error('Failed to mark inbox items as read:', error);
  }

  /**
   * コミュニティメンバーの増減（参加・退出）をリアルタイム購読
   */
  subscribeCommunityMembers(communityId: string, onMemberChange: () => void): any {
    return supabase
      .channel(`community_members:${communityId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'community_members',
          filter: `community_id=eq.${communityId}`
        },
        () => {
          onMemberChange();
        }
      )
      .subscribe();
  }

  /**
   * コミュニティ内のオンラインステータスをPresenceで監視
   */
  subscribeCommunityPresence(communitySlug: string, currentUserId: string, onPresenceSync: (onlineUserIds: string[]) => void): any {
    const channel = supabase.channel(`community_presence:${communitySlug}`);
    
    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        // 各クライアントの状態を取り出し、ユニークなユーザーIDのリストを作る
        const onlineUserIds = Object.values(state).flatMap((presences: any[]) => 
          presences.map(p => p.user_id)
        );
        onPresenceSync([...new Set(onlineUserIds)]);
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ user_id: currentUserId });
        }
      });
      
    return channel;
  }

  /**
   * グループ（チャットルーム）とその関連データをすべて削除する
   */
  async deleteGroup(roomId: string): Promise<void> {
    const { error } = await supabase
      .from('chat_rooms')
      .delete()
      .eq('id', roomId);
      
    if (error) {
      console.error('Failed to delete group:', error);
      throw error;
    }
  }

  /**
   * 指定したチャットルーム内のメッセージ履歴をすべて削除する（個別チャット用）
   */
  async deleteMessages(roomId: string): Promise<void> {
    const { error } = await supabase
      .from('messages')
      .delete()
      .eq('room_id', roomId);
      
    if (error) {
      console.error('Failed to delete messages:', error);
      throw error;
    }
  }
}
