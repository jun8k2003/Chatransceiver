import { AudioManager } from './audio/manager';
import { AudioPlaybackQueue } from './audio/queue';
import { UIController } from './ui/controller';
import type { UIState } from './ui/controller';
import { supabase, SupabaseService } from './services/supabase';
import { FCMService } from './services/FCMService';
import { WakeLockService } from './services/wakelock';
import pttStartUrl from './assets/ptt-start.wav';

/**
 * App (src/app.ts)
 * アプリ全体のMediatorおよびステートホルダーです。
 * 本物の Supabase クラウドサービスに接続し、リアルタイムの同期通信を行います。
 */
export class App {
  private audioManager: AudioManager;
  private playbackQueue: AudioPlaybackQueue;
  private uiController: UIController;
  private supabaseService: SupabaseService;
  private fcmService: FCMService;
  private wakeLockService: WakeLockService;

  // Realtime 監視サブスクリプションの参照
  private inboxSubscription: any = null;
  private roomSubscription: any = null;
  private presenceSubscription: any = null;
  private communityMembersSubscription: any = null;
  private currentOnlineUserIds: string[] = [];

  // アプリケーション・グローバルステート
  private state: UIState = {
    currentUser: null,
    currentCommunity: null,
    activeChatHistoryId: null,
    selectedUserIds: [],
    members: [],
    groups: [],
    messages: [],
    playingUserId: undefined,
    playingGroupId: undefined,
    autoplayEnabled: true,
    recordMode: 'both' as 'both' | 'audio_only' | 'text_only',
    isRecording: false,
    mobileChatForceOpen: false,
    theme: 'dark',
    fcmIsIOS: false,
    fcmRegistered: false,
    callSignEnabled: true,
    isLoading: true,
    loadingMessage: '初期化中...'
  };

  private groupMembersMap: { [groupId: string]: string[] } = {}; // roomId -> userIds

  // 録音モーダル関連の状態
  private recordingTimerId: number | null = null;
  private recordingCountdownId: number | null = null;
  private recordedAudioBlob: Blob | null = null;
  private recordedDictationText: string = '';

  constructor() {
    this.audioManager = new AudioManager();
    this.playbackQueue = new AudioPlaybackQueue(this.audioManager);
    this.supabaseService = new SupabaseService();
    this.fcmService = new FCMService(this.supabaseService);
    this.wakeLockService = new WakeLockService();

    // UIController の初期化とコールバック登録
    this.uiController = new UIController(
      (slug: string) => this.handleConnectCommunity(slug),
      () => this.handleDisconnectCommunity(),
      () => this.handleLeaveCommunity(),
      (userId: string) => this.handleOpenUser(userId),
      (groupId: string) => this.handleOpenGroup(groupId),
      (userIds: string[]) => this.handleCreateGroup(userIds),
      (userId: string, userName: string) => this.handleUserChatClear(userId, userName),
      (groupId: string, groupName: string) => this.handleGroupDelete(groupId, groupName),
      (newName: string) => this.handleRenameGroup(newName),
      (text: string) => this.handleSendText(text),
      () => this.handleStartTalk(),
      () => this.handleStopTalk(),
      () => this.handleSendAudio(),
      () => this.handlePreviewAudio(),
      () => this.handleCancelTalk(),
      (msgId: string) => this.handlePlayMessage(msgId),
      () => this.audioManager.stopAllPlayback(),
      (msgId: string) => this.handleRevokeMessage(msgId),
      () => this.handleSignInWithGoogle(),
      () => this.handleSignOut(),
      () => this.handleBackToSidebar(),
      (nickname: string, autoplay: boolean, recordMode: 'both'|'audio_only'|'text_only', theme: 'light' | 'dark', callSignEnabled: boolean, discordWebhookUrl?: string) => this.handleSaveSettings(nickname, autoplay, recordMode, theme, callSignEnabled, discordWebhookUrl),
      async () => await this.handleRegisterNotification(),
      async () => await this.handleUnregisterNotification(),
      async () => await this.handleToggleWakeLock()
    );
  }

  /**
   * アプリケーション初期化
   */
  async init(): Promise<void> {
    // 自動再生設定の読み込み
    const savedAutoplay = localStorage.getItem('chatransceiver_autoplay_enabled');
    if (savedAutoplay !== null) {
      this.state.autoplayEnabled = savedAutoplay === 'true';
    }

    // 録音設定の読み込み
    const savedRecordMode = localStorage.getItem('chatransceiver_record_mode');
    if (savedRecordMode === 'both' || savedRecordMode === 'audio_only' || savedRecordMode === 'text_only') {
      this.state.recordMode = savedRecordMode;
    }

    // コールサインフォン設定の読み込み
    const savedCallSign = localStorage.getItem('chatransceiver_callsign_enabled');
    if (savedCallSign !== null) {
      this.state.callSignEnabled = savedCallSign === 'true';
    }
    this.playbackQueue.callSignEnabled = this.state.callSignEnabled;

    // テーマ設定の読み込み
    const savedTheme = localStorage.getItem('chatransceiver_theme') as 'light' | 'dark';
    if (savedTheme === 'light' || savedTheme === 'dark') {
      this.state.theme = savedTheme;
    }
    this.applyTheme(this.state.theme);

    // FCM初期状態のセットアップ
    this.state.fcmIsIOS = this.fcmService.isIOSTerminal();
    this.state.fcmRegistered = localStorage.getItem('chatransceiver_fcm_registered') === 'true';
    this.fcmService.setupIfRegistered();

    // URL フラグメントまたはパラメータによる直接接続チェック (DEC-017)
    let communitySlug = '';
    const hash = window.location.hash.replace('#', '');
    if (hash.startsWith('community=')) {
      communitySlug = hash.replace('community=', '');
    }
    
    const urlParams = new URLSearchParams(window.location.search);
    if (!communitySlug) {
      communitySlug = urlParams.get('c') || '';
    }

    if (!communitySlug) {
      // URLパラメータがない場合は、ローカルストレージから直前の接続コミュニティを読み込む
      const savedCommunity = localStorage.getItem('chatransceiver_current_community');
      if (savedCommunity) {
        try {
          // JSONパースを試みる
          const community = JSON.parse(savedCommunity);
          // slugがあれば優先し、無ければidを使用するフォールバック
          communitySlug = community?.slug || community?.id || null;
        } catch (e) {
          // JSONパースに失敗した場合、単一の文字列（IDやSlug）として保存されていた可能性を考慮
          if (typeof savedCommunity === 'string' && !savedCommunity.startsWith('{')) {
            communitySlug = savedCommunity;
          } else {
            console.error('Failed to parse current community from LocalStorage:', e);
          }
        }
      }
    }
    
    // Supabase Auth から現在のログインセッションを確認
    try {
      const user = await this.supabaseService.getCurrentUser();
      if (user) {
        this.state.currentUser = user;
        
        if (communitySlug) {
          await this.handleConnectCommunity(communitySlug);
          
          const targetMessageId = urlParams.get('m');
          if (targetMessageId) {
            await this.handleDirectMessageLink(targetMessageId, communitySlug);
          }
        } else {
          this.updateUI();
        }
      } else {
        this.updateUI();
      }
    } catch (e) {
      console.error('Failed to restore user session:', e);
      this.updateUI();
    } finally {
      this.state.isLoading = false;
      this.updateUI();
    }

    // OAuthリダイレクト後の遅延セッション確立をキャッチするためのリスナー
    supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        // すでにログイン処理済みの場合はスキップ
        if (this.state.currentUser && this.state.currentUser.id === session.user.id) return;
        
        try {
          const user = await this.supabaseService.getCurrentUser();
          if (user) {
            this.state.currentUser = user;
            if (communitySlug && !this.state.currentCommunity) {
              await this.handleConnectCommunity(communitySlug);
            } else {
              this.updateUI();
            }
          }
        } catch (e) {
          console.error('Failed to load user on auth change:', e);
        }
      }
    });
  }

  /**
   * UIの更新要求
   */
  private updateUI(): void {
    this.uiController.render(this.state);
  }

  /**
   * 本物のサインイン（Google OAuth）
   */
  private async handleSignInWithGoogle(): Promise<void> {
    this.state.isLoading = true;
    this.state.loadingMessage = '認証画面へ移動中...';
    this.updateUI();
    // リダイレクト時にURLパラメータの接続コミュニティ情報を維持するが、ハッシュ(#)は除外する
    const redirectUrl = window.location.origin + window.location.pathname + window.location.search;
    await this.supabaseService.signInWithGoogle(redirectUrl);
    // リダイレクトされるので finally で戻す必要は基本的にありません
  }

  /**
   * ログアウト処理
   */
  private async handleSignOut(): Promise<void> {
    try {
      await this.handleLeaveCommunity();
      await this.supabaseService.signOut();
      this.state.currentUser = null;

      // URLのハッシュ（アクセストークン等）を完全に消去して綺麗な状態にする
      const cleanUrl = window.location.origin + window.location.pathname + window.location.search;
      window.history.replaceState({}, '', cleanUrl);

      this.updateUI();
    } catch (e) {
      console.error('Failed to sign out:', e);
      alert('ログアウトに失敗しました。');
    }
  }

  /**
   * コミュニティ接続 (入室)
   */
  private async handleConnectCommunity(slug: string): Promise<void> {
    if (!this.state.currentUser) return;

    // ブラウザの自動再生ロックを解除 (ユーザーインタラクションを契機にする)
    this.audioManager.unlockAudio();

    this.state.isLoading = true;
    this.state.loadingMessage = 'コミュニティへ接続中...';
    this.updateUI();

    try {
      const comm = await this.supabaseService.connectCommunity(this.state.currentUser.id, slug);
      this.state.currentCommunity = comm;
      localStorage.setItem('chatransceiver_current_community', JSON.stringify(comm));

      // パラメタやフラグメント部分を消去したシンプルなURLにする
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, '', cleanUrl);

      // リアルタイムインボックスの購読
      if (this.inboxSubscription) {
        this.inboxSubscription.unsubscribe();
      }
      this.inboxSubscription = this.supabaseService.subscribeInbox(
        this.state.currentUser.id,
        (inboxItem) => this.handleNewInboxItem(inboxItem)
      );

      // コミュニティメンバー増減の監視開始
      if (this.communityMembersSubscription) {
        this.communityMembersSubscription.unsubscribe();
      }
      this.communityMembersSubscription = this.supabaseService.subscribeCommunityMembers(
        comm.id,
        () => {
          // メンバーの追加・削除があった場合はデータを再読み込みしてUIを更新
          this.loadCommunityData().then(() => this.updateUI());
        }
      );

      // Presenceの購読開始 (オンライン状況同期)
      if (this.presenceSubscription) {
        this.presenceSubscription.unsubscribe();
      }
      this.presenceSubscription = this.supabaseService.subscribeCommunityPresence(
        slug,
        this.state.currentUser.id,
        (onlineUserIds) => {
          this.currentOnlineUserIds = onlineUserIds;
          this.state.members.forEach(m => {
            m.isOnline = onlineUserIds.includes(m.id);
          });
          this.updateUI();
        }
      );

      // コミュニティデータのロード
      await this.loadCommunityData();

      this.state.activeChatHistoryId = null;
      this.state.selectedUserIds = [];
      this.state.messages = [];

      this.updateUI();
    } catch (e: any) {
      console.error('Failed to connect community:', e);
      alert('コミュニティへの接続に失敗しました。\nエラー詳細: ' + (e.message || JSON.stringify(e)));
      this.handleLeaveCommunity();
    } finally {
      this.state.isLoading = false;
      this.updateUI();
    }
  }

  /**
   * コミュニティデータの取得と内部キャッシュの構築
   */
  private async loadCommunityData(): Promise<void> {
    if (!this.state.currentUser || !this.state.currentCommunity) return;

    try {
      const commId = this.state.currentCommunity.id;
      const myId = this.state.currentUser.id;

      const members = await this.supabaseService.getCommunityMembers(commId, myId);
      
      // 個別チャットの未読件数の取得と反映
      const unreadIndividual = await this.supabaseService.getUnreadIndividualCounts(myId);
      members.forEach(m => {
        const info = unreadIndividual[m.id];
        m.unreadCount = info?.count || 0;
        m.latestUnreadTime = info?.latestTime || 0;
        m.isOnline = this.currentOnlineUserIds.includes(m.id);
      });

      // members をソート (未読優先・新しい順)
      members.sort((a, b) => {
        const aUnread = a.unreadCount || 0;
        const bUnread = b.unreadCount || 0;
        if (aUnread > 0 && bUnread > 0) {
          return (b.latestUnreadTime || 0) - (a.latestUnreadTime || 0);
        }
        if (aUnread !== bUnread) {
          return bUnread - aUnread;
        }
        return a.userNumber - b.userNumber;
      });
      this.state.members = members;

      const groups = await this.supabaseService.getCommunityGroups(commId, myId);
      
      // groups をソート (未読優先・新しい順)
      groups.sort((a, b) => {
        const aUnread = a.unreadCount || 0;
        const bUnread = b.unreadCount || 0;
        if (aUnread > 0 && bUnread > 0) {
          return (b.latestUnreadTime || 0) - (a.latestUnreadTime || 0);
        }
        return bUnread - aUnread;
      });
      this.state.groups = groups;

      // 各グループの構成メンバーIDをキャッシュ
      for (const group of groups) {
        const { data } = await supabase
          .from('chat_room_members')
          .select('user_id')
          .eq('room_id', group.id);
        
        if (data) {
          this.groupMembersMap[group.id] = data.map((item: any) => item.user_id);
        }
      }
    } catch (e) {
      console.error('Failed to load community data:', e);
    }
  }

  /**
   * コミュニティ切断 (一時的)
   */
  private async handleDisconnectCommunity(): Promise<void> {
    if (this.inboxSubscription) {
      this.inboxSubscription.unsubscribe();
      this.inboxSubscription = null;
    }
    if (this.roomSubscription) {
      this.roomSubscription.unsubscribe();
      this.roomSubscription = null;
    }
    if (this.presenceSubscription) {
      this.presenceSubscription.unsubscribe();
      this.presenceSubscription = null;
      this.currentOnlineUserIds = [];
    }
    if (this.communityMembersSubscription) {
      this.communityMembersSubscription.unsubscribe();
      this.communityMembersSubscription = null;
    }

    this.state.currentCommunity = null;
    localStorage.removeItem('chatransceiver_current_community');

    // URLフラグメント/パラメータの削除
    const url = new URL(window.location.href);
    url.searchParams.delete('c');
    url.hash = '';
    window.history.replaceState({}, '', url.toString());

    this.state.activeChatHistoryId = null;
    this.state.selectedUserIds = [];
    this.state.members = [];
    this.state.groups = [];
    this.state.messages = [];
    this.playbackQueue.clear();

    this.updateUI();
  }

  /**
   * コミュニティ退出 (脱退・履歴削除)
   */
  private async handleLeaveCommunity(): Promise<void> {
    const slug = this.state.currentCommunity?.slug;
    const commId = this.state.currentCommunity?.id;
    
    // DBから自分を削除
    if (this.state.currentUser && commId) {
      try {
        await this.supabaseService.leaveCommunity(this.state.currentUser.id, commId);
      } catch (e: any) {
        console.error('Failed to leave community in Supabase:', e);
        alert('退会処理に失敗しました。データベースエラー: ' + (e.message || JSON.stringify(e)));
        return; // エラー時はローカルの切断処理を中断し、画面に留まる
      }
    }

    await this.handleDisconnectCommunity();

    // UIに退出した履歴削除を通知
    if (slug) {
      this.uiController.handleCommunityLeave(slug);
    }
  }

  /**
   * 統合リスト: 個別チャットを開く (タップで即オープン) (DEC-024)
   */
  private async handleOpenUser(userId: string): Promise<void> {
    this.state.mobileChatForceOpen = true;
    await this.handleUserCheckChange([userId]);
  }

  /**
   * 統合リスト: グループチャットを開く (タップで即オープン) (DEC-024)
   */
  private async handleOpenGroup(groupId: string): Promise<void> {
    this.state.mobileChatForceOpen = true;
    await this.handleGroupSelect(groupId);
  }

  /**
   * 統合リスト: 複数メンバー選択からの新規グループ開始 (DEC-024)
   * 既存グループとメンバー構成が一致すればそれを開き、無ければ新規作成プレースホルダーへ
   */
  private async handleCreateGroup(userIds: string[]): Promise<void> {
    this.state.mobileChatForceOpen = true;
    await this.handleUserCheckChange(userIds);
  }

  /**
   * グループ名（表示上のあだ名）の変更 (DEC-023)
   */
  private async handleRenameGroup(newName: string): Promise<void> {
    const roomId = this.state.activeChatHistoryId;
    if (!roomId) return;

    try {
      await this.supabaseService.updateRoomName(roomId, newName);

      // ローカル状態へ即時反映
      const group = this.state.groups.find(g => g.id === roomId);
      if (group) {
        group.customName = newName.trim() || undefined;
        group.name = group.customName || group.memberNames;
      }
      this.updateUI();
    } catch (e) {
      console.error('Failed to rename group:', e);
      alert('グループ名の変更に失敗しました。');
    }
  }

  /**
   * 個別チャットチェック変更 (左ペイン連動)
   */
  private async handleUserCheckChange(userIds: string[]): Promise<void> {
    this.state.selectedUserIds = userIds;

    if (userIds.length === 0) {
      this.handleBackToSidebar();
    } else if (userIds.length === 1) {
      if (!this.state.currentUser || !this.state.currentCommunity) return;

      this.state.isLoading = true;
      this.updateUI();

      try {
        const commId = this.state.currentCommunity.id;
        const myId = this.state.currentUser.id;
        const targetId = userIds[0];

        const roomId = await this.supabaseService.getOrCreateIndividualRoom(commId, myId, targetId);
        this.state.activeChatHistoryId = roomId;

        const messages = await this.supabaseService.getRoomMessages(roomId);
        this.state.messages = messages;

        await this.supabaseService.markAsRead(roomId, myId);
        this.subscribeRoomMessages(roomId);

        // 未読バッジクリア用のローカル状態反映
        const targetMember = this.state.members.find(m => m.id === targetId);
        if (targetMember) targetMember.unreadCount = 0;
      } catch (e) {
        console.error('Failed to select individual chat:', e);
      } finally {
        this.state.isLoading = false;
        this.updateUI();
      }
    } else {
      // 複数人選択 (既存グループの自動判定)
      const expectedMembers = [...userIds, this.state.currentUser!.id];
      const matchedGroup = this.state.groups.find((group) => {
        const members = this.groupMembersMap[group.id] || [];
        return (
          members.length === expectedMembers.length &&
          members.every((m) => expectedMembers.includes(m))
        );
      });

      if (matchedGroup) {
        this.state.isLoading = true;
        this.updateUI();
        try {
          this.state.activeChatHistoryId = matchedGroup.id;
          const messages = await this.supabaseService.getRoomMessages(matchedGroup.id);
          this.state.messages = messages;
          await this.supabaseService.markAsRead(matchedGroup.id, this.state.currentUser!.id);
          this.subscribeRoomMessages(matchedGroup.id);
        } finally {
          this.state.isLoading = false;
        }
      } else {
        this.state.activeChatHistoryId = null;
        this.state.messages = [];
        if (this.roomSubscription) {
          this.roomSubscription.unsubscribe();
          this.roomSubscription = null;
        }
      }
      this.updateUI();
    }
  }

  /**
   * グループチャット選択 (中央ペイン連動)
   */
  private async handleGroupSelect(groupId: string | null): Promise<void> {
    this.state.activeChatHistoryId = groupId;

    if (groupId) {
      this.state.isLoading = true;
      this.updateUI();

      try {
        const members = this.groupMembersMap[groupId] || [];
        this.state.selectedUserIds = members.filter(id => id !== this.state.currentUser!.id);
        
        const messages = await this.supabaseService.getRoomMessages(groupId);
        this.state.messages = messages;
        
        await this.supabaseService.markAsRead(groupId, this.state.currentUser!.id);
        this.subscribeRoomMessages(groupId);
        
        // 未読バッジクリア用のローカル状態反映
        const targetGroup = this.state.groups.find(g => g.id === groupId);
        if (targetGroup) targetGroup.unreadCount = 0;
      } finally {
        this.state.isLoading = false;
      }
    } else {
      this.state.selectedUserIds = [];
      this.state.messages = [];
      if (this.roomSubscription) {
        this.roomSubscription.unsubscribe();
        this.roomSubscription = null;
      }
    }

    this.updateUI();
  }

  /**
   * グループの削除処理
   */
  private async handleGroupDelete(groupId: string, groupName: string): Promise<void> {
    if (!window.confirm(`グループ「${groupName}」とそのチャット履歴をすべて削除しますか？`)) {
      return;
    }

    this.state.isLoading = true;
    this.updateUI();

    try {
      await this.supabaseService.deleteGroup(groupId);
      if (this.state.activeChatHistoryId === groupId) {
        this.state.activeChatHistoryId = null;
        this.state.selectedUserIds = [];
        this.state.messages = [];
        if (this.roomSubscription) {
          this.roomSubscription.unsubscribe();
          this.roomSubscription = null;
        }
      }
      await this.loadCommunityData();
    } catch (err) {
      console.error('Failed to delete group:', err);
      alert('グループの削除に失敗しました。');
    } finally {
      this.state.isLoading = false;
      this.updateUI();
    }
  }

  /**
   * 個別チャットの履歴削除処理
   */
  private async handleUserChatClear(userId: string, userName: string): Promise<void> {
    if (!window.confirm(`メンバー「${userName}」とのチャット履歴内容をすべて削除しますか？\n（※メンバーは削除されません）`)) {
      return;
    }

    this.state.isLoading = true;
    this.updateUI();

    try {
      const roomId = await this.supabaseService.getOrCreateIndividualRoom(
        this.state.currentCommunity!.id,
        this.state.currentUser!.id,
        userId
      );
      
      await this.supabaseService.deleteMessages(roomId);

      if (this.state.activeChatHistoryId === roomId) {
        this.state.messages = [];
      }
      await this.loadCommunityData();
    } catch (err) {
      console.error('Failed to clear individual chat history:', err);
      alert('チャット履歴の削除に失敗しました。');
    } finally {
      this.state.isLoading = false;
      this.updateUI();
    }
  }

  /**
   * ルームのメッセージのリアルタイム購読
   */
  private subscribeRoomMessages(roomId: string): void {
    if (this.roomSubscription) {
      this.roomSubscription.unsubscribe();
    }

    this.roomSubscription = this.supabaseService.subscribeRoomMessages(
      roomId,
      (msg) => {
        if (!this.state.messages.some(m => m.id === msg.id)) {
          this.state.messages.push(msg);
          this.updateUI();
        }
      },
      (updatedMsg) => {
        const index = this.state.messages.findIndex(m => m.id === updatedMsg.id);
        if (index !== -1) {
          this.state.messages[index] = updatedMsg;
          this.updateUI();
        }
      }
    );
  }

  /**
   * 発言の取り消し (送信者自身による)
   */
  private async handleRevokeMessage(messageId: string): Promise<void> {
    if (!this.state.currentUser) return;
    try {
      await this.supabaseService.revokeMessage(messageId, this.state.currentUser.id);
    } catch (e) {
      console.error('Failed to revoke message:', e);
      alert('メッセージの取り消しに失敗しました。');
    }
  }

  /**
   * テキストメッセージ送信 (打鍵) (DEC-018)
   */
  private async handleSendText(text: string): Promise<void> {
    if (!this.state.currentUser || !this.state.currentCommunity) return;

    try {
      let roomId = this.state.activeChatHistoryId;

      if (!roomId && this.state.selectedUserIds.length === 0) {
        alert('送信先を選択してください。');
        return;
      }

      if (!roomId) {
        // 新規グループの自動作成 (最初の送信時) (DEC-011)
        roomId = await this.supabaseService.createGroupRoom(
          this.state.currentCommunity.id,
          this.state.currentUser.id,
          this.state.selectedUserIds
        );
        this.state.activeChatHistoryId = roomId;
        // ルームメッセージの購読を開始
        this.subscribeRoomMessages(roomId);
        // サイドバーに新規グループを反映させるためデータをロード
        await this.loadCommunityData();
      }

      await this.supabaseService.sendMessage(roomId, this.state.currentUser.id, text);
    } catch (e) {
      console.error('Failed to send text message:', e);
    }
  }

  /**
   * 常時表示 (Screen Wake Lock) のON/OFFトグル (DEC-026)
   * @returns トグル後の状態 (true = ON)
   */
  private async handleToggleWakeLock(): Promise<boolean> {
    try {
      if (this.wakeLockService.isActive) {
        await this.wakeLockService.disable();
      } else {
        await this.wakeLockService.enable();
      }
    } catch (e) {
      console.error('Failed to toggle wake lock:', e);
      alert('常時表示の切り替えに失敗しました。');
    }
    const isActive = this.wakeLockService.isActive;
    this.uiController.updateWakeLockState(isActive);
    return isActive;
  }

  /**
   * 録音状態のリセット
   */
  private clearRecordingState(): void {
    if (this.recordingTimerId) { clearTimeout(this.recordingTimerId); this.recordingTimerId = null; }
    if (this.recordingCountdownId) { clearInterval(this.recordingCountdownId); this.recordingCountdownId = null; }
    this.state.isRecording = false;
  }



  /**
   * 音声発話開始 (録音開始ボタン)
   */
  private handleStartTalk(): void {
    this.state.isRecording = true;
    this.playbackQueue.pause();
    this.recordedAudioBlob = null;
    this.recordedDictationText = '';

    this.uiController.showRecordingModal(this.state.recordMode);
    
    // recordMode に応じて処理を分岐
    if (this.state.recordMode === 'both' || this.state.recordMode === 'text_only') {
      this.audioManager.startDictation();
    }
    
    if (this.state.recordMode === 'both' || this.state.recordMode === 'audio_only') {
      this.audioManager.startRecording((level) => {
        this.uiController.updateMicLevel(level);
      }).catch((err) => {
        console.error('Microphone recording error:', err);
        this.uiController.showMicError(window.location.origin);
        this.clearRecordingState();
        this.uiController.hideRecordingModal();
      });
    } else if (this.state.recordMode === 'text_only') {
      // 録音しない場合はマイクレベルを0固定で進める
      this.uiController.updateMicLevel(0);
    }

    let timeLeft = 15;
    this.uiController.updateRecordingTimer(`00:${timeLeft.toString().padStart(2, '0')}`);
    
    this.recordingCountdownId = window.setInterval(() => {
      timeLeft--;
      if (timeLeft >= 0) {
        this.uiController.updateRecordingTimer(`00:${timeLeft.toString().padStart(2, '0')}`);
      }
    }, 1000);

    this.recordingTimerId = window.setTimeout(() => {
      if (this.state.isRecording) {
        this.handleStopTalk();
      }
    }, 15000);
  }

  /**
   * 音声発話停止 (録音を停止し、送信待機)
   */
  private async handleStopTalk(): Promise<void> {
    if (!this.state.isRecording) return;
    this.clearRecordingState();
    
    try {
      if (this.state.recordMode === 'both' || this.state.recordMode === 'audio_only') {
        this.recordedAudioBlob = await this.audioManager.stopRecording();
      } else {
        this.recordedAudioBlob = null;
      }
      
      let recognizedText = '';
      if (this.state.recordMode === 'both' || this.state.recordMode === 'text_only') {
        // 音声認識を停止し、結果を受け取る
        recognizedText = await this.audioManager.stopDictation();
      }

      if (this.state.recordMode === 'audio_only') {
        this.recordedDictationText = '🎤 音声メッセージ';
      } else {
        this.recordedDictationText = recognizedText || (this.state.recordMode === 'text_only' ? '（テキスト化できませんでした）' : '（音声メッセージ）');
      }
      
      this.uiController.updateDictationPreview(this.recordedDictationText);
      this.uiController.hideRecordingStopButton();
    } catch (error) {
      console.error('Failed to stop recording:', error);
      this.uiController.hideRecordingModal();
    }
  }

  /**
   * 音声メッセージの送信
   */
  private async handleSendAudio(): Promise<void> {
    if (!this.state.currentUser || !this.state.currentCommunity) return;

    let roomId = this.state.activeChatHistoryId;
    if (!roomId && this.state.selectedUserIds.length === 0) {
      alert('送信先を選択してください。');
      this.clearRecordingState();
      this.uiController.hideRecordingModal();
      return;
    }

    // もしまだ録音中であれば、強制的に録音を終了させてから送信へ進む
    if (this.state.isRecording) {
      await this.handleStopTalk();
    }

    this.uiController.hideRecordingModal();
    this.playbackQueue.resume();

    if (!this.recordedAudioBlob && this.state.recordMode !== 'text_only') return;
    if (this.state.recordMode === 'text_only' && !this.recordedDictationText) return;

    try {
      if (!roomId) {
        // 新規グループの自動作成
        roomId = await this.supabaseService.createGroupRoom(
          this.state.currentCommunity.id,
          this.state.currentUser.id,
          this.state.selectedUserIds
        );
        this.state.activeChatHistoryId = roomId;
        this.subscribeRoomMessages(roomId);
        await this.loadCommunityData();
      }

      await this.supabaseService.sendMessage(roomId, this.state.currentUser.id, this.recordedDictationText, this.recordedAudioBlob || undefined);
    } catch (e) {
      console.error('Failed to send audio message:', e);
    }
  }

  /**
   * 録音キャンセル
   */
  private handleCancelTalk(): void {
    this.clearRecordingState();
    this.uiController.hideRecordingModal();
    this.audioManager.stopRecording().catch(() => {});
    this.audioManager.stopDictation().catch(() => {});
    this.playbackQueue.resume();
  }

  /**
   * 録音した音声のプレビュー再生
   */
  private async handlePreviewAudio(): Promise<void> {
    if (this.recordedAudioBlob) {
      try {
        await this.audioManager.playBlob(this.recordedAudioBlob);
      } catch (err) {
        console.error('Failed to play preview audio:', err);
      }
    }
  }

  /**
   * 自分宛の新着インボックスメッセージ検知時の自動再生処理 (Realtime)
   */
  private handleNewInboxItem(inboxItem: any): void {
    const senderName = inboxItem.senderName;
    const roomId = inboxItem.roomId;
    const senderId = inboxItem.senderId;

    if (this.state.autoplayEnabled) {
      this.playbackQueue.enqueue({
        id: inboxItem.id,
        type: inboxItem.audioUrl ? 'audio' : 'text',
        content: inboxItem.audioUrl || inboxItem.textContent,
        senderName: senderName,
        roomId: roomId,
        onPlayStart: () => {
          if (this.groupMembersMap[roomId] && this.groupMembersMap[roomId].length >= 2) {
            this.state.playingGroupId = roomId;
          } else {
            this.state.playingUserId = senderId;
          }
          this.updateUI();
        },
        onPlayEnd: () => {
          this.state.playingGroupId = undefined;
          this.state.playingUserId = undefined;
          this.updateUI();
        }
      });
    }

    if (this.state.activeChatHistoryId === roomId) {
      this.supabaseService.markAsRead(roomId, this.state.currentUser!.id);
    } else {
      this.loadCommunityData().then(() => this.updateUI());
    }
  }

  /**
   * バブルの「▶」再生ボタンクリック時の処理 (手動再再生)
   */
  private async handlePlayMessage(messageId: string): Promise<void> {
    const msg = this.state.messages.find((m) => m.id === messageId);
    if (!msg) return;

    try {
      if (this.state.callSignEnabled) {
        try {
          await this.audioManager.playAudio(pttStartUrl, 0.3);
        } catch (error) {
          console.warn('Failed to play ptt-start before:', error);
        }
      }

      if (msg.audioUrl) {
        await this.audioManager.playAudio(msg.audioUrl);
      } else {
        await this.audioManager.speakText(msg.textContent);
      }

      if (this.state.callSignEnabled) {
        try {
          await this.audioManager.playAudio(pttStartUrl, 0.3);
        } catch (error) {
          console.warn('Failed to play ptt-start after:', error);
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * モバイル用: サイドバー（リスト）へ戻る
   */
  private handleBackToSidebar(): void {
    this.state.mobileChatForceOpen = false;
    this.state.activeChatHistoryId = null;
    this.state.selectedUserIds = [];
    this.state.messages = [];
    if (this.roomSubscription) {
      this.roomSubscription.unsubscribe();
      this.roomSubscription = null;
    }
    this.updateUI();
  }

  /**
   * 環境設定の保存
   */
  private async handleSaveSettings(nickname: string, autoplay: boolean, recordMode: 'both'|'audio_only'|'text_only', theme: 'light' | 'dark', callSignEnabled: boolean, discordWebhookUrl?: string): Promise<void> {
    if (this.state.currentUser) {
      try {
        await this.supabaseService.updateNickname(this.state.currentUser.id, nickname);
        this.state.currentUser.name = nickname;
        
        if (discordWebhookUrl !== undefined) {
          await this.supabaseService.updateDiscordWebhook(this.state.currentUser.id, discordWebhookUrl);
          this.state.currentUser.discord_webhook_url = discordWebhookUrl;
        }
      } catch (e) {
        console.error('Failed to update user settings in Database:', e);
      }
    }
    
    this.state.autoplayEnabled = autoplay;
    localStorage.setItem('chatransceiver_autoplay_enabled', autoplay ? 'true' : 'false');

    this.state.recordMode = recordMode;
    localStorage.setItem('chatransceiver_record_mode', recordMode);

    this.state.callSignEnabled = callSignEnabled;
    localStorage.setItem('chatransceiver_callsign_enabled', callSignEnabled ? 'true' : 'false');
    this.playbackQueue.callSignEnabled = callSignEnabled;
    
    if (!autoplay) {
      this.playbackQueue.clear();
      this.audioManager.stopAllPlayback();
      this.state.playingGroupId = undefined;
      this.state.playingUserId = undefined;
    }
    
    // 設定変更に伴い、ヘッダー等の表示名や状態を更新するためリロード
    await this.loadCommunityData();
    
    // テーマの保存と適用
    this.state.theme = theme;
    localStorage.setItem('chatransceiver_theme', theme);
    this.applyTheme(theme);
    
    this.updateUI();
  }
  
  /**
   * テーマ（Light/Dark）を画面に適用
   */
  private applyTheme(theme: 'light' | 'dark'): void {
    if (theme === 'light') {
      document.body.classList.add('theme-light');
    } else {
      document.body.classList.remove('theme-light');
    }
  }

  /**
   * メッセージのダイレクトリンク起動処理
   */
  private async handleDirectMessageLink(messageId: string, expectedSlug: string): Promise<void> {
    try {
      const info = await this.supabaseService.getMessageInfo(messageId);
      if (!info) {
        console.warn('Direct link message not found or access denied.');
        return;
      }
      if (info.communitySlug !== expectedSlug) {
        console.warn('Direct link message does not belong to the current community.');
        return;
      }

      // UI描画時にフォーカスするメッセージIDをセット
      this.state.targetMessageIdToFocus = messageId;
      this.state.mobileChatForceOpen = true; // モバイルでダイレクトリンクを開いた際にチャット画面を強制表示

      // 該当のルームを開く (内部で updateUI() が呼ばれる)
      if (info.roomType === 'group') {
        await this.handleGroupSelect(info.roomId);
      } else if (info.roomType === 'individual') {
        const members = this.groupMembersMap[info.roomId] || [];
        const otherUserIds = members.filter(id => id !== this.state.currentUser!.id);
        if (otherUserIds.length > 0) {
          await this.handleUserCheckChange(otherUserIds);
        } else {
          // メンバーマップにない場合はルームのメンバーを再取得して開く
          const { data } = await supabase.from('chat_room_members').select('user_id').eq('room_id', info.roomId);
          if (data) {
             const others = data.map((d: any) => d.user_id).filter((id: string) => id !== this.state.currentUser!.id);
             await this.handleUserCheckChange(others);
          }
        }
      }

      // 描画後、フラグをクリア
      setTimeout(() => {
        this.state.targetMessageIdToFocus = undefined;
      }, 1000);

      // オーディオ再生を試みる (TTSまたは録音)
      // UI描画とスクロールが完了するのを少し待ってから再生
      setTimeout(async () => {
        try {
          await this.handlePlayMessage(messageId);
        } catch (e: any) {
          if (e.name === 'NotAllowedError') {
            console.warn('Autoplay blocked by browser. User interaction required.');
          } else {
            console.error('Failed to auto-play message:', e);
          }
        }
      }, 300);

    } catch (e) {
      console.error('Failed to handle direct message link:', e);
    }
  }

  private async handleRegisterNotification(): Promise<void> {
    const success = await this.fcmService.registerNotification();
    if (success) {
      this.state.fcmRegistered = true;
      this.updateUI();
      alert('プッシュ通知の登録が完了しました。');
    }
  }

  private async handleUnregisterNotification(): Promise<void> {
    const success = await this.fcmService.unregisterNotification();
    if (success) {
      this.state.fcmRegistered = false;
      this.updateUI();
      alert('プッシュ通知の解除が完了しました。');
    } else {
      alert('プッシュ通知の解除に失敗しました。');
    }
  }
}
