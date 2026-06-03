import { AudioManager } from './audio/manager';
import { AudioPlaybackQueue } from './audio/queue';
import { UIController } from './ui/controller';
import type { UIState } from './ui/controller';
import { supabase, SupabaseService } from './services/supabase';

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

  // Realtime 監視サブスクリプションの参照
  private inboxSubscription: any = null;
  private roomSubscription: any = null;
  private presenceSubscription: any = null;

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
    isRecording: false,
    mobileChatForceOpen: false
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

    // UIController の初期化とコールバック登録
    this.uiController = new UIController(
      (slug) => this.handleConnectCommunity(slug),
      () => this.handleDisconnectCommunity(),
      () => this.handleLeaveCommunity(),
      (userIds) => this.handleUserCheckChange(userIds),
      (groupId) => this.handleGroupSelect(groupId),
      (text) => this.handleSendText(text),
      () => this.handleStartTalk(),
      () => this.handleStopTalk(),
      () => this.handleSendAudio(),
      () => this.handleCancelTalk(),
      (msgId) => this.handlePlayMessage(msgId),
      () => this.handleMobileGoToChat(),
      () => this.handleSignInWithGoogle(),
      () => this.handleSignOut(),
      () => this.handleBackToSidebar(),
      (nickname, autoplay) => this.handleSaveSettings(nickname, autoplay)
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

    // URL パラメータによる直接接続チェック (DEC-017)
    const urlParams = new URLSearchParams(window.location.search);
    let communitySlug = urlParams.get('c');
    if (!communitySlug) {
      // URLパラメータがない場合は、ローカルストレージから直前の接続コミュニティを読み込む
      const savedCommunity = localStorage.getItem('chatransceiver_current_community');
      if (savedCommunity) {
        try {
          const community = JSON.parse(savedCommunity);
          communitySlug = community?.slug || null;
        } catch (e) {
          console.error('Failed to parse current community from LocalStorage:', e);
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
        } else {
          this.updateUI();
        }
      } else {
        this.updateUI();
      }
    } catch (e) {
      console.error('Failed to restore user session:', e);
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
    // リダイレクト時にURLパラメータ（接続コミュニティ情報）を維持するが、ハッシュ(#)は除外する
    const redirectUrl = window.location.origin + window.location.pathname + window.location.search;
    await this.supabaseService.signInWithGoogle(redirectUrl);
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

    try {
      const comm = await this.supabaseService.connectCommunity(this.state.currentUser.id, slug);
      this.state.currentCommunity = comm;
      localStorage.setItem('chatransceiver_current_community', JSON.stringify(comm));

      // リアルタイムインボックスの購読
      if (this.inboxSubscription) {
        this.inboxSubscription.unsubscribe();
      }
      this.inboxSubscription = this.supabaseService.subscribeInbox(
        this.state.currentUser.id,
        (inboxItem) => this.handleNewInboxItem(inboxItem)
      );

      // Presenceの購読開始 (オンライン状況同期)
      if (this.presenceSubscription) {
        this.presenceSubscription.unsubscribe();
      }
      this.presenceSubscription = this.supabaseService.subscribeCommunityPresence(
        slug,
        this.state.currentUser.id,
        (onlineUserIds) => {
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
      });

      this.state.members = members;

      const groups = await this.supabaseService.getCommunityGroups(commId, myId);
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
    }

    this.state.currentCommunity = null;
    localStorage.removeItem('chatransceiver_current_community');

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
      } catch (e) {
        console.error('Failed to leave community in Supabase:', e);
      }
    }

    await this.handleDisconnectCommunity();

    // UIに退出した履歴削除を通知
    if (slug) {
      this.uiController.handleCommunityLeave(slug);
    }
  }

  /**
   * 個別チャットチェック変更 (左ペイン連動)
   */
  private async handleUserCheckChange(userIds: string[]): Promise<void> {
    this.state.selectedUserIds = userIds;

    if (userIds.length === 0) {
      this.state.activeChatHistoryId = null;
      this.state.messages = [];
      if (this.roomSubscription) {
        this.roomSubscription.unsubscribe();
        this.roomSubscription = null;
      }
      this.updateUI();
    } else if (userIds.length === 1) {
      if (!this.state.currentUser || !this.state.currentCommunity) return;

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

        this.updateUI();
      } catch (e) {
        console.error('Failed to select individual chat:', e);
      }
    } else {
      // 複数人選択 (新規グループの自動判定)
      const matchedGroup = this.state.groups.find((group) => {
        const members = this.groupMembersMap[group.id] || [];
        return (
          members.length === userIds.length &&
          members.every((m) => userIds.includes(m))
        );
      });

      if (matchedGroup) {
        this.state.activeChatHistoryId = matchedGroup.id;
        const messages = await this.supabaseService.getRoomMessages(matchedGroup.id);
        this.state.messages = messages;
        await this.supabaseService.markAsRead(matchedGroup.id, this.state.currentUser!.id);
        this.subscribeRoomMessages(matchedGroup.id);
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
      const members = this.groupMembersMap[groupId] || [];
      this.state.selectedUserIds = [...members];
      
      const messages = await this.supabaseService.getRoomMessages(groupId);
      this.state.messages = messages;
      
      await this.supabaseService.markAsRead(groupId, this.state.currentUser!.id);
      this.subscribeRoomMessages(groupId);
      
      // 未読バッジクリア用のローカル状態反映
      const targetGroup = this.state.groups.find(g => g.id === groupId);
      if (targetGroup) targetGroup.unreadCount = 0;
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
   * ルームのメッセージのリアルタイム購読
   */
  private subscribeRoomMessages(roomId: string): void {
    if (this.roomSubscription) {
      this.roomSubscription.unsubscribe();
    }

    this.roomSubscription = this.supabaseService.subscribeRoomMessages(roomId, (msg) => {
      if (!this.state.messages.some(m => m.id === msg.id)) {
        this.state.messages.push(msg);
        this.updateUI();
      }
    });
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
   * 録音状態のリセット
   */
  private clearRecordingState(): void {
    if (this.recordingTimerId) { clearTimeout(this.recordingTimerId); this.recordingTimerId = null; }
    if (this.recordingCountdownId) { clearInterval(this.recordingCountdownId); this.recordingCountdownId = null; }
    this.state.isRecording = false;
    this.playbackQueue.resume();
  }

  /**
   * 音声発話開始 (録音開始ボタン)
   */
  private handleStartTalk(): void {
    this.state.isRecording = true;
    this.playbackQueue.pause();
    this.recordedAudioBlob = null;
    this.recordedDictationText = '';

    this.uiController.showRecordingModal();
    
    // 録音と同時に音声認識（ディクテーション）も開始する
    this.audioManager.startDictation();
    
    this.audioManager.startRecording((level) => {
      this.uiController.updateMicLevel(level);
    }).catch((err) => {
      console.error('Microphone recording error:', err);
      this.uiController.showMicError(window.location.origin);
      this.clearRecordingState();
      this.uiController.hideRecordingModal();
    });

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
      this.recordedAudioBlob = await this.audioManager.stopRecording();
      
      // 音声認識を停止し、結果を受け取る
      const recognizedText = await this.audioManager.stopDictation();
      this.recordedDictationText = recognizedText || '（音声メッセージ）';
      
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

    if (!this.recordedAudioBlob) return;

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

      await this.supabaseService.sendMessage(roomId, this.state.currentUser.id, this.recordedDictationText, this.recordedAudioBlob);
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
  private handlePlayMessage(messageId: string): void {
    const msg = this.state.messages.find((m) => m.id === messageId);
    if (!msg) return;

    if (msg.audioUrl) {
      this.audioManager.playAudio(msg.audioUrl).catch(console.error);
    } else {
      this.audioManager.speakText(msg.textContent).catch(console.error);
    }
  }

  /**
   * モバイル用: 手動でチャットペインへスライドする
   */
  private handleMobileGoToChat(): void {
    this.state.mobileChatForceOpen = true;
    this.updateUI();
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
  private async handleSaveSettings(nickname: string, autoplay: boolean): Promise<void> {
    if (this.state.currentUser) {
      try {
        await this.supabaseService.updateNickname(this.state.currentUser.id, nickname);
        this.state.currentUser.name = nickname;
      } catch (e) {
        console.error('Failed to update nickname in Database:', e);
      }
    }
    
    this.state.autoplayEnabled = autoplay;
    localStorage.setItem('chatransceiver_autoplay_enabled', autoplay ? 'true' : 'false');
    
    if (!autoplay) {
      this.playbackQueue.clear();
      this.audioManager.stopAllPlayback();
      this.state.playingGroupId = undefined;
      this.state.playingUserId = undefined;
    }
    
    // 設定変更に伴い、ヘッダー等の表示名や状態を更新するためリロード
    await this.loadCommunityData();
    this.updateUI();
  }
}
