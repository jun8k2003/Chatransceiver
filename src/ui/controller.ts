import { CommunitySelectorUI } from './community';
import { UserListUI } from './users';
import type { MemberItem } from './users';
import { GroupListUI } from './groups';
import type { GroupItem } from './groups';
import { ChatWindowUI } from './chat';
import type { MessageItem } from './chat';

export interface UIState {
  currentUser: { id: string; name: string } | null;
  currentCommunity: { id: string; slug: string; name: string } | null;
  activeChatHistoryId: string | null;
  selectedUserIds: string[];
  members: MemberItem[];
  groups: GroupItem[];
  messages: MessageItem[];
  playingUserId?: string;
  playingGroupId?: string;
  autoplayEnabled: boolean;
  isRecording: boolean;
  mobileChatForceOpen: boolean;
  theme: 'light' | 'dark';
  targetMessageIdToFocus?: string;
  fcmIsIOS?: boolean;
  fcmRegistered?: boolean;
  callSignEnabled: boolean;
}

/**
 * UIController (src/ui/controller.ts)
 * 画面上のすべてのビューコンポーネント（ペイン、ヘッダー、モーダル）を統括し、
 * アプリのグローバルステートに応じたリアクティブな描画と相互同期を管理します。
 */
export class UIController {
  private communitySelector: CommunitySelectorUI;
  private userList: UserListUI;
  private groupList: GroupListUI;
  private chatWindow: ChatWindowUI;

  // ログインUIの要素
  private loginScreenEl: HTMLDivElement;
  private authErrorMessageEl: HTMLDivElement;
  private headerUserNicknameEl: HTMLSpanElement;

  // 環境設定関連の要素
  private settingsModalEl: HTMLDivElement;
  private settingsNicknameInput: HTMLInputElement;
  private settingsAutoplayCheck: HTMLInputElement;
  private settingsCallSignCheck: HTMLInputElement;
  private settingsThemeSelect: HTMLSelectElement;
  private settingsSaveBtn: HTMLButtonElement;
  private settingsCancelBtn: HTMLButtonElement;
  private settingsLeaveContainerEl: HTMLDivElement;
  private settingsCurrentCommunityNameEl: HTMLElement;

  // モバイル用 チャットへ移動ボタン
  private btnMobileGoToChat: HTMLButtonElement;

  constructor(
    onConnectCommunity: (slug: string) => void,
    onDisconnectCommunity: () => void,
    onLeaveCommunity: () => void,
    onUserCheckChange: (selectedUserIds: string[]) => void,
    onGroupSelect: (groupId: string | null) => void,
    onSendText: (text: string) => void,
    onStartTalk: () => void,
    onStopTalk: () => void,
    onSendAudio: () => void,
    onPreviewAudio: () => Promise<void>,
    onCancelTalk: () => void,
    onPlayMessage: (messageId: string) => Promise<void>,
    onStopPlayback: () => void,
    onRevokeMessage: (messageId: string) => void,
    onMobileGoToChat: () => void,
    onSignInWithGoogle: () => Promise<void>,
    onSignOut: () => Promise<void>,
    onBackToSidebar: () => void,
    onSaveSettings: (nickname: string, autoplay: boolean, theme: 'light'|'dark', callSignEnabled: boolean) => void,
    onRegisterNotification: () => Promise<void>,
    onUnregisterNotification: () => Promise<void>
  ) {
    // ログインUI
    this.loginScreenEl = document.getElementById('loginScreen') as HTMLDivElement;
    this.authErrorMessageEl = document.getElementById('authErrorMessage') as HTMLDivElement;
    this.headerUserNicknameEl = document.getElementById('userNickname') as HTMLSpanElement;
    const btnAuthGoogle = document.getElementById('btnAuthGoogle') as HTMLButtonElement;

    const showAuthError = (msg: string) => {
      this.authErrorMessageEl.textContent = msg;
      this.authErrorMessageEl.style.display = 'block';
    };

    const clearAuthError = () => {
      this.authErrorMessageEl.textContent = '';
      this.authErrorMessageEl.style.display = 'none';
    };

    const btnSignOut = document.getElementById('btnSignOut');
    if (btnSignOut) {
      btnSignOut.addEventListener('click', async () => {
        this.settingsModalEl.classList.remove('show');
        await onSignOut();
      });
    }

    const btnReloadApp = document.getElementById('btnReloadApp');
    if (btnReloadApp) {
      btnReloadApp.addEventListener('click', () => {
        window.location.reload();
      });
    }

    // ビルド番号と日時の表示
    const elBuildNumber = document.getElementById('appBuildNumber');
    const elBuildTime = document.getElementById('appBuildTime');
    if (elBuildNumber && typeof __BUILD_NUMBER__ !== 'undefined') {
      elBuildNumber.textContent = __BUILD_NUMBER__.toString();
    }
    if (elBuildTime && typeof __BUILD_TIME__ !== 'undefined') {
      elBuildTime.textContent = __BUILD_TIME__;
    }

    // Google認証ボタン押下イベント
    btnAuthGoogle.addEventListener('click', async () => {
      btnAuthGoogle.disabled = true;
      btnAuthGoogle.textContent = 'Googleへ接続中...';
      clearAuthError();

      try {
        await onSignInWithGoogle();
      } catch (err: any) {
        console.error('Google authentication error:', err);
        showAuthError(err.message || '認証に失敗しました。');
        btnAuthGoogle.disabled = false;
        btnAuthGoogle.textContent = 'Google でログイン';
      }
    });

    // 各UIパーツクラスの初期化
    this.communitySelector = new CommunitySelectorUI(
      'communityConnector',
      onConnectCommunity,
      onDisconnectCommunity
    );

    this.userList = new UserListUI('userPane', onUserCheckChange);
    this.groupList = new GroupListUI('groupPane', onGroupSelect);
    
    this.chatWindow = new ChatWindowUI(
      'chatPane',
      onSendText,
      onStartTalk,
      onStopTalk,
      onSendAudio,
      onPreviewAudio,
      onCancelTalk,
      onPlayMessage,
      onStopPlayback,
      onRevokeMessage,
      onBackToSidebar
    );

    // ヘッダーの設定ボタン
    const settingsBtn = document.querySelector('.btn-settings') as HTMLButtonElement;
    
    // 設定モーダルのバインド
    this.settingsModalEl = document.getElementById('settingsModal') as HTMLDivElement;
    this.settingsNicknameInput = document.getElementById('settingsNickname') as HTMLInputElement;
    this.settingsAutoplayCheck = document.getElementById('settingsAutoplay') as HTMLInputElement;
    this.settingsCallSignCheck = document.getElementById('settingsCallSignOff') as HTMLInputElement;
    this.settingsThemeSelect = document.getElementById('settingsTheme') as HTMLSelectElement;
    this.settingsSaveBtn = this.settingsModalEl.querySelector('.btn-settings-save') as HTMLButtonElement;
    this.settingsCancelBtn = this.settingsModalEl.querySelector('.btn-settings-cancel') as HTMLButtonElement;
    this.settingsLeaveContainerEl = this.settingsModalEl.querySelector('#settingsLeaveContainer') as HTMLDivElement;
    this.settingsCurrentCommunityNameEl = this.settingsModalEl.querySelector('#settingsCurrentCommunityName') as HTMLElement;
    const btnSettingsLeave = this.settingsModalEl.querySelector('#btnSettingsLeave') as HTMLButtonElement;

    // モバイル用ボタン
    this.btnMobileGoToChat = document.getElementById('btnMobileGoToChat') as HTMLButtonElement;
    if (this.btnMobileGoToChat) {
      this.btnMobileGoToChat.addEventListener('click', () => {
        onMobileGoToChat();
      });
    }

    if (btnSettingsLeave) {
      btnSettingsLeave.addEventListener('click', () => {
        if (confirm('本当にこのコミュニティから退会しますか？（参加履歴からも削除されます）')) {
          this.settingsModalEl.classList.remove('show');
          onLeaveCommunity();
        }
      });
    }

    // 設定ボタンクリック時にモーダルを表示
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        this.settingsModalEl.classList.add('show');
      });
    }

    // キャンセルボタン
    this.settingsCancelBtn.addEventListener('click', () => {
      this.settingsModalEl.classList.remove('show');
    });

    // 環境設定モーダル保存
    this.settingsSaveBtn.addEventListener('click', () => {
      const newNickname = this.settingsNicknameInput.value.trim();
      const autoplay = this.settingsAutoplayCheck.checked;
      const theme = this.settingsThemeSelect.value as 'light' | 'dark';
      const callSignEnabled = !this.settingsCallSignCheck.checked;
      if (newNickname) {
        onSaveSettings(newNickname, autoplay, theme, callSignEnabled);
        this.settingsModalEl.classList.remove('show');
      } else {
        alert('ニックネームを入力してください。');
      }
    });

    // マイク権限URLコピーボタン (DEC-008)
    const btnCopyMicUrl = this.settingsModalEl.querySelector('#btnCopyMicUrl') as HTMLButtonElement;
    const inputMicUrl = this.settingsModalEl.querySelector('#settingsMicUrl') as HTMLInputElement;
    if (btnCopyMicUrl && inputMicUrl) {
      btnCopyMicUrl.addEventListener('click', () => {
        navigator.clipboard.writeText(inputMicUrl.value).then(() => {
          const originalText = btnCopyMicUrl.textContent;
          btnCopyMicUrl.textContent = '✅';
          setTimeout(() => { btnCopyMicUrl.textContent = originalText; }, 2000);
        }).catch(err => {
          console.error('Failed to copy text: ', err);
          alert('コピーに失敗しました。');
        });
      });
    }

    // スピーカー/音声権限URLコピーボタン
    const btnCopySoundUrl = this.settingsModalEl.querySelector('#btnCopySoundUrl') as HTMLButtonElement;
    const inputSoundUrl = this.settingsModalEl.querySelector('#settingsSoundUrl') as HTMLInputElement;
    if (btnCopySoundUrl && inputSoundUrl) {
      btnCopySoundUrl.addEventListener('click', () => {
        navigator.clipboard.writeText(inputSoundUrl.value).then(() => {
          const originalText = btnCopySoundUrl.textContent;
          btnCopySoundUrl.textContent = '✅';
          setTimeout(() => { btnCopySoundUrl.textContent = originalText; }, 2000);
        }).catch(err => {
          console.error('Failed to copy text: ', err);
          alert('コピーに失敗しました。');
        });
      });
    }

    // FCM通知ボタンのイベント
    const btnReg = document.getElementById('btnRegisterNotification') as HTMLButtonElement;
    if (btnReg) {
      btnReg.addEventListener('click', async () => {
        const originalText = btnReg.textContent;
        btnReg.textContent = '処理中...';
        btnReg.disabled = true;
        await onRegisterNotification();
        if (btnReg) {
          btnReg.textContent = originalText;
          btnReg.disabled = false;
        }
      });
    }

    const btnUnreg = document.getElementById('btnUnregisterNotification') as HTMLButtonElement;
    if (btnUnreg) {
      btnUnreg.addEventListener('click', async () => {
        const originalText = btnUnreg.textContent;
        btnUnreg.textContent = '処理中...';
        btnUnreg.disabled = true;
        await onUnregisterNotification();
        if (btnUnreg) {
          btnUnreg.textContent = originalText;
          btnUnreg.disabled = false;
        }
      });
    }
  }

  /**
   * アプリ状態（State）に基づく画面全体の再描画 (DEC-012)
   */
  render(state: UIState): void {
    // 1. ログイン画面の表示・非表示切り替え
    if (!state.currentUser) {
      this.loginScreenEl.style.display = 'flex';
      return;
    } else {
      this.loginScreenEl.style.display = 'none';
      this.headerUserNicknameEl.textContent = state.currentUser.name;
      
      // 設定画面の初期値をセット（入力中以外の時に値を同期）
      if (document.activeElement !== this.settingsNicknameInput) {
        this.settingsNicknameInput.value = state.currentUser.name;
      }
      this.settingsAutoplayCheck.checked = state.autoplayEnabled;
      this.settingsCallSignCheck.checked = !state.callSignEnabled;
      this.settingsThemeSelect.value = state.theme;
      
      // 退会コントロールの表示制御
      if (state.currentCommunity) {
        this.settingsLeaveContainerEl.style.display = 'block';
        this.settingsCurrentCommunityNameEl.textContent = state.currentCommunity.name;
      } else {
        this.settingsLeaveContainerEl.style.display = 'none';
        this.settingsCurrentCommunityNameEl.textContent = '-';
      }

      // FCM UIの制御
      const fcmNotSupportedMsg = document.getElementById('fcmNotSupportedMsg') as HTMLDivElement;
      const fcmButtonsContainer = document.getElementById('fcmButtonsContainer') as HTMLDivElement;
      const btnRegister = document.getElementById('btnRegisterNotification') as HTMLButtonElement;
      const btnUnregister = document.getElementById('btnUnregisterNotification') as HTMLButtonElement;

      if (state.fcmIsIOS) {
        if (fcmNotSupportedMsg) fcmNotSupportedMsg.style.display = 'block';
        if (fcmButtonsContainer) fcmButtonsContainer.style.display = 'none';
      } else {
        if (fcmNotSupportedMsg) fcmNotSupportedMsg.style.display = 'none';
        if (fcmButtonsContainer) fcmButtonsContainer.style.display = 'flex';
        if (state.fcmRegistered) {
          if (btnRegister) btnRegister.style.display = 'none';
          if (btnUnregister) btnUnregister.style.display = 'block';
        } else {
          if (btnRegister) btnRegister.style.display = 'block';
          if (btnUnregister) btnUnregister.style.display = 'none';
        }
      }
    }

    // モバイル用表示切り替えクラスの制御 (has-active-chat) とフローティングボタンの表示
    const containerEl = document.querySelector('.app-container') as HTMLElement;
    
    // チャットが「開ける状態」かどうか（何かしら選択されているか）
    const canOpenChat = !!state.activeChatHistoryId || (state.selectedUserIds.length > 0);

    if (containerEl) {
      if (state.mobileChatForceOpen) {
        containerEl.classList.add('has-active-chat');
      } else {
        containerEl.classList.remove('has-active-chat');
      }
    }

    if (this.btnMobileGoToChat) {
      this.btnMobileGoToChat.disabled = !canOpenChat;
    }

    // 2. コミュニティ接続状態の更新
    const isConnected = !!state.currentCommunity;
    this.communitySelector.updateConnectionState(
      isConnected,
      state.currentCommunity?.slug
    );

    if (!isConnected) {
      // 未接続時はプレースホルダーと空リストを描画
      this.userList.render([], [], state.playingUserId);
      this.groupList.render([], null, state.playingGroupId);
      this.chatWindow.render([], '', 'unconnected');
      return;
    }

    // コミュニティ履歴への保存
    if (state.currentCommunity) {
      this.communitySelector.saveToHistory(
        state.currentCommunity.slug,
        state.currentCommunity.name
      );
    }

    // 3. 個別チャット一覧 (左ペイン) の描画
    this.userList.render(state.members, state.selectedUserIds, state.playingUserId);

    // 4. グループチャット一覧 (中央ペイン) の描画
    this.groupList.render(
      state.groups,
      state.activeChatHistoryId,
      state.playingGroupId
    );

    // 5. 右ペイン (チャットウィンドウ) の描画
    if (state.activeChatHistoryId) {
      // 既存チャットルームのアクティブ時
      let roomTitle = '';
      let roomMembers = '';
      if (state.activeChatHistoryId.startsWith('room_g')) {
        const group = state.groups.find(g => g.id === state.activeChatHistoryId);
        roomTitle = group ? group.name : 'グループチャット';
        roomMembers = group ? `${group.memberCount} 人のメンバー` : '';
      } else {
        const targetUserId = state.activeChatHistoryId.replace('room_u', 'u'); // room_u1 -> u1 に対応するため
        const member = state.members.find(m => m.id === targetUserId);
        roomTitle = member ? member.name : '個別チャット';
        roomMembers = member ? (member.isOnline ? '● オンライン' : 'オフライン') : '';
      }
      this.chatWindow.render(state.messages, state.currentUser.id, 'chat', undefined, roomTitle, roomMembers, state.targetMessageIdToFocus, state.currentCommunity?.slug);
    } else if (state.selectedUserIds.length >= 2) {
      // 新規グループ作成中プレースホルダー時 (DEC-011)
      const selectedNames = state.members
        .filter((m) => state.selectedUserIds.includes(m.id))
        .map((m) => m.name)
        .join(', ');

      this.chatWindow.render(
        [],
        state.currentUser.id,
        'placeholder',
        {
          title: '👥 新規グループチャットを作成中...',
          subtitle: `メンバー: ${selectedNames}<br>最初のボイスまたはテキストを送信すると、このメンバーで新しいグループチャットが開始され、一覧に追加されます。`
        }
      );
    } else {
      // 何も選択されていない時
      this.chatWindow.render(
        [],
        state.currentUser.id,
        'empty',
        {
          title: '💬 チャットを開始しましょう',
          subtitle: '左ペインから話したいメンバーをチェック（複数選択可）するか、グループを選択してください。'
        }
      );
    }
  }

  // 録音ダイアログ制御の委譲
  showRecordingModal(): void { this.chatWindow.showRecordingModal(); }
  hideRecordingModal(): void { this.chatWindow.hideRecordingModal(); }
  updateMicLevel(level: number): void { this.chatWindow.updateMicLevel(level); }
  updateRecordingTimer(text: string): void { this.chatWindow.updateRecordingTimer(text); }
  updateDictationPreview(text: string): void { this.chatWindow.updateDictationPreview(text); }
  hideRecordingStopButton(): void { this.chatWindow.hideStopButton(); }
  showMicError(siteUrl: string): void { this.chatWindow.showMicError(siteUrl); }
  
  /**
   * コミュニティ退出時に履歴ドロップダウンから削除
   */
  handleCommunityLeave(slug: string): void {
    this.communitySelector.removeFromHistory(slug);
  }
}
