import { CommunityMenuUI } from './community';
import { WakeLockService } from '../services/wakelock';
import { MediaButtonPttService } from '../services/mediabutton';
import { ChatListUI } from './list';
import type { MemberItem, GroupItem } from './list';
import { ChatWindowUI } from './chat';
import type { MessageItem } from './chat';
import type { UserWebhook, UserWebhookInput, WebhookMethod } from '../services/supabase';

export interface UIState {
  currentUser: { id: string; name: string; discord_webhook_url?: string } | null;
  webhooks: UserWebhook[];
  currentCommunity: { id: string; slug: string; name: string } | null;
  activeChatHistoryId: string | null;
  selectedUserIds: string[];
  members: MemberItem[];
  groups: GroupItem[];
  messages: MessageItem[];
  playingUserId?: string;
  playingGroupId?: string;
  autoplayEnabled: boolean;
  recordMode: 'both' | 'audio_only' | 'text_only';
  isRecording: boolean;
  mobileChatForceOpen: boolean;
  theme: 'light' | 'dark';
  targetMessageIdToFocus?: string;
  fcmIsIOS?: boolean;
  fcmRegistered?: boolean;
  callSignEnabled: boolean;
  isLoading: boolean;
  loadingMessage?: string;
  isTTTMode: boolean;
  tttWakeWord: string;
  bgSize?: 'cover' | 'contain';
  bgBlur?: boolean;
  isAutoplaying?: boolean;
  autoplaySenderName?: string;
}

/**
 * UIController (src/ui/controller.ts)
 * 画面上のすべてのビューコンポーネント（統合リスト、ヘッダー、チャット、モーダル）を統括し、
 * アプリのグローバルステートに応じたリアクティブな描画と相互同期を管理します。
 */
export class UIController {
  private communityMenu: CommunityMenuUI;
  private chatList: ChatListUI;
  private chatWindow: ChatWindowUI;

  // ログインUIの要素
  private loginScreenEl: HTMLDivElement;
  private authErrorMessageEl: HTMLDivElement;
  private headerUserNicknameEl: HTMLSpanElement;

  // 環境設定関連の要素
  private settingsModalEl: HTMLDivElement;
  private settingsNicknameInput: HTMLInputElement;
  private settingsAutoplayCheck: HTMLInputElement;
  private settingsRecordModeSelect: HTMLSelectElement;
  private settingsCallSignCheck: HTMLInputElement;
  private settingsThemeSelect: HTMLSelectElement;
  private settingsDiscordWebhookInput: HTMLInputElement;
  private settingsFcmToggle: HTMLInputElement;
  private fcmUpdating: boolean = false;
  
  // 背景設定関連
  private settingsBgImageInput: HTMLInputElement;
  private btnSettingsBgClear: HTMLButtonElement;
  private settingsBgSizeSelect: HTMLSelectElement;
  private settingsBgBlurCheck: HTMLInputElement;
  private bgImageClearRequested: boolean = false;

  // 全画面ローディング
  private loadingOverlayEl: HTMLDivElement;
  private loadingMessageEl: HTMLParagraphElement;

  // 常時表示 (Wake Lock) トグルボタン (DEC-026)
  private btnKeepAwake: HTMLButtonElement | null;

  // メディアボタンPTT トグルボタン (DEC-027)
  private btnMediaPtt: HTMLButtonElement | null;

  // TTT (TalkToTalk) ウェイクワード待機トグル (DEC-028)
  private tttToggleInput: HTMLInputElement | null = null;
  private tttToggleLabel: HTMLLabelElement | null = null;
  private tttWakeOverlayEl: HTMLDivElement | null = null;
  private tttWakeTextEl: HTMLSpanElement | null = null;
  private settingsWakeWordInput: HTMLInputElement | null = null;
  private settingsWakeWordErrorEl: HTMLDivElement | null = null;

  // 自動再生 停止パネル (DEC-032)
  private autoplayStopOverlayEl: HTMLDivElement | null = null;
  private autoplaySenderNameEl: HTMLSpanElement | null = null;

  // カスタムWebhook設定 (DEC-033)
  private webhookListEl: HTMLDivElement | null = null;
  private btnAddWebhook: HTMLButtonElement | null = null;
  private webhookFormEl: HTMLDivElement | null = null;
  private webhookLabelInput: HTMLInputElement | null = null;
  private webhookMethodSelect: HTMLSelectElement | null = null;
  private webhookUrlInput: HTMLInputElement | null = null;
  private webhookBodyInput: HTMLTextAreaElement | null = null;
  private webhookFormErrorEl: HTMLDivElement | null = null;
  private editingWebhook: UserWebhook | null = null;  // 編集中の既存Webhook (新規はnull)
  private currentWebhooks: UserWebhook[] = [];
  private onSaveWebhook: (webhook: UserWebhookInput) => Promise<void>;
  private onDeleteWebhook: (webhookId: string) => Promise<void>;

  private static readonly MAX_WEBHOOKS = 5;

  constructor(
    onConnectCommunity: (slug: string) => void,
    onDisconnectCommunity: () => void,
    onLeaveCommunity: () => void,
    onOpenUser: (userId: string) => void,
    onOpenGroup: (groupId: string) => void,
    onCreateGroup: (userIds: string[]) => void,
    onUserChatClear: (userId: string, userName: string) => void,
    onGroupDelete: (groupId: string, groupName: string) => void,
    onRenameGroup: (newName: string) => void,
    onSendText: (text: string) => void,
    onStartTalk: () => void,
    onStopTalk: () => void,
    onSendAudio: () => void,
    onPreviewAudio: () => Promise<void>,
    onCancelTalk: () => void,
    onPlayMessage: (messageId: string) => Promise<void>,
    onStopPlayback: () => void,
    onRevokeMessage: (messageId: string) => void,
    onSignInWithGoogle: () => Promise<void>,
    onSignInWithMagicLink: (email: string) => Promise<void>,
    onSignOut: () => Promise<void>,
    onBackToSidebar: () => void,
    onSaveSettings: (nickname: string, autoplay: boolean, recordMode: 'both'|'audio_only'|'text_only', theme: 'light'|'dark', callSignEnabled: boolean, discordWebhookUrl?: string, tttWakeWord?: string, bgImageFile?: File | null, bgImageClear?: boolean, bgSize?: 'cover'|'contain', bgBlur?: boolean) => void,
    onRegisterNotification: () => Promise<void>,
    onUnregisterNotification: () => Promise<void>,
    onToggleWakeLock: () => Promise<boolean>,
    onToggleMediaPtt: () => Promise<boolean>,
    onToggleTTT: () => void,
    onStopAutoplay: () => void,
    onSaveWebhook: (webhook: UserWebhookInput) => Promise<void>,
    onDeleteWebhook: (webhookId: string) => Promise<void>
  ) {
    this.onSaveWebhook = onSaveWebhook;
    this.onDeleteWebhook = onDeleteWebhook;
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

    // Magic Link (メールリンク) 送信イベント
    const magicLinkForm = document.getElementById('magicLinkForm') as HTMLFormElement;
    const magicLinkEmail = document.getElementById('magicLinkEmail') as HTMLInputElement;
    const btnAuthMagicLink = document.getElementById('btnAuthMagicLink') as HTMLButtonElement;
    const magicLinkSuccessEl = document.getElementById('magicLinkSuccess') as HTMLDivElement;

    if (magicLinkForm) {
      magicLinkForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = magicLinkEmail.value.trim();
        if (!email) return;

        btnAuthMagicLink.disabled = true;
        btnAuthMagicLink.textContent = '送信中...';
        magicLinkSuccessEl.style.display = 'none';
        clearAuthError();

        try {
          await onSignInWithMagicLink(email);
          // 送信成功: 案内メッセージを表示し、フォームを無効化したままにする
          magicLinkSuccessEl.style.display = 'block';
          btnAuthMagicLink.textContent = '送信済み';
        } catch (err: any) {
          console.error('Magic Link authentication error:', err);
          showAuthError(err.message || 'ログインリンクの送信に失敗しました。');
          btnAuthMagicLink.disabled = false;
          btnAuthMagicLink.textContent = 'メールでログインリンクを受け取る';
        }
      });
    }

    // 各UIパーツクラスの初期化
    this.communityMenu = new CommunityMenuUI(
      'communityConnector',
      onConnectCommunity,
      onDisconnectCommunity,
      onLeaveCommunity
    );

    this.chatList = new ChatListUI(
      onOpenUser,
      onOpenGroup,
      onCreateGroup,
      onUserChatClear,
      onGroupDelete
    );

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
      onBackToSidebar,
      onRenameGroup
    );

    // 設定モーダルのバインド
    this.settingsModalEl = document.getElementById('settingsModal') as HTMLDivElement;
    this.settingsNicknameInput = document.getElementById('settingsNickname') as HTMLInputElement;
    this.settingsAutoplayCheck = document.getElementById('settingsAutoplay') as HTMLInputElement;
    this.settingsRecordModeSelect = document.getElementById('settingsRecordMode') as HTMLSelectElement;
    this.settingsCallSignCheck = document.getElementById('settingsCallSign') as HTMLInputElement;
    this.settingsThemeSelect = document.getElementById('settingsTheme') as HTMLSelectElement;
    this.settingsDiscordWebhookInput = document.getElementById('settingsDiscordWebhook') as HTMLInputElement;
    this.settingsFcmToggle = document.getElementById('settingsFcmToggle') as HTMLInputElement;

    this.settingsBgImageInput = document.getElementById('settingsBgImage') as HTMLInputElement;
    this.btnSettingsBgClear = document.getElementById('btnSettingsBgClear') as HTMLButtonElement;
    this.settingsBgSizeSelect = document.getElementById('settingsBgSize') as HTMLSelectElement;
    this.settingsBgBlurCheck = document.getElementById('settingsBgBlur') as HTMLInputElement;

    // 画像クリアボタン
    if (this.btnSettingsBgClear) {
      this.btnSettingsBgClear.addEventListener('click', () => {
        this.settingsBgImageInput.value = '';
        this.bgImageClearRequested = true;
      });
    }

    // 画像アップロードが変更されたらクリア要求を取り消す
    if (this.settingsBgImageInput) {
      this.settingsBgImageInput.addEventListener('change', () => {
        if (this.settingsBgImageInput.files && this.settingsBgImageInput.files.length > 0) {
          this.bgImageClearRequested = false;
        }
      });
    }

    // 設定ボタンクリック時にモーダルを表示
    const settingsBtn = document.querySelector('.btn-settings') as HTMLButtonElement;
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        this.settingsModalEl.classList.add('show');
      });
    }

    // 閉じるボタン
    const settingsCancelBtn = this.settingsModalEl.querySelector('.btn-settings-cancel') as HTMLButtonElement;
    settingsCancelBtn.addEventListener('click', () => {
      this.settingsModalEl.classList.remove('show');
    });

    const btnSettingsCloseTop = document.getElementById('btnSettingsCloseTop') as HTMLButtonElement;
    if (btnSettingsCloseTop) {
      btnSettingsCloseTop.addEventListener('click', () => {
        this.settingsModalEl.classList.remove('show');
      });
    }

    // オーバーレイクリックで閉じる
    this.settingsModalEl.addEventListener('click', (e) => {
      if (e.target === this.settingsModalEl) {
        this.settingsModalEl.classList.remove('show');
      }
    });

    // 環境設定モーダル保存
    const settingsSaveBtn = this.settingsModalEl.querySelector('.btn-settings-save') as HTMLButtonElement;
    settingsSaveBtn.addEventListener('click', () => {
      const newNickname = this.settingsNicknameInput.value.trim();
      const autoplay = this.settingsAutoplayCheck.checked;
      const recordMode = this.settingsRecordModeSelect.value as 'both' | 'audio_only' | 'text_only';
      const theme = this.settingsThemeSelect.value as 'light' | 'dark';
      const callSignEnabled = this.settingsCallSignCheck.checked;
      const discordWebhookUrl = this.settingsDiscordWebhookInput.value.trim();
      const wakeWord = this.settingsWakeWordInput?.value.trim() || '';

      if (!newNickname) {
        alert('ニックネームを入力してください。');
        return;
      }

      // ウェイクワード正規表現バリデーション
      if (wakeWord) {
        try {
          new RegExp(wakeWord);
          if (this.settingsWakeWordErrorEl) this.settingsWakeWordErrorEl.textContent = '';
        } catch (e) {
          if (this.settingsWakeWordErrorEl) this.settingsWakeWordErrorEl.textContent = '正規表現が無効です。';
          return;
        }
      }

      const bgImageFile = (this.settingsBgImageInput.files && this.settingsBgImageInput.files.length > 0) ? this.settingsBgImageInput.files[0] : null;
      const bgSize = this.settingsBgSizeSelect.value as 'cover' | 'contain';
      const bgBlur = this.settingsBgBlurCheck.checked;

      onSaveSettings(newNickname, autoplay, recordMode, theme, callSignEnabled, discordWebhookUrl, wakeWord, bgImageFile, this.bgImageClearRequested, bgSize, bgBlur);
      
      // 保存後に入力状態をリセット
      this.settingsBgImageInput.value = '';
      this.bgImageClearRequested = false;
      this.settingsModalEl.classList.remove('show');
    });

    // マイク権限URLコピーボタン (DEC-008)
    const bindCopyButton = (btnId: string, inputId: string) => {
      const btn = this.settingsModalEl.querySelector(`#${btnId}`) as HTMLButtonElement;
      const input = this.settingsModalEl.querySelector(`#${inputId}`) as HTMLInputElement;
      if (btn && input) {
        btn.addEventListener('click', () => {
          navigator.clipboard.writeText(input.value).then(() => {
            const originalText = btn.textContent;
            btn.textContent = '✅';
            setTimeout(() => { btn.textContent = originalText; }, 2000);
          }).catch(err => {
            console.error('Failed to copy text: ', err);
            alert('コピーに失敗しました。');
          });
        });
      }
    };
    bindCopyButton('btnCopyMicUrl', 'settingsMicUrl');
    bindCopyButton('btnCopySoundUrl', 'settingsSoundUrl');

    // FCM通知トグル: ONで登録、OFFで解除 (DEC-024)
    if (this.settingsFcmToggle) {
      this.settingsFcmToggle.addEventListener('change', async () => {
        if (this.fcmUpdating) return;
        this.fcmUpdating = true;
        this.settingsFcmToggle.disabled = true;
        try {
          if (this.settingsFcmToggle.checked) {
            await onRegisterNotification();
          } else {
            await onUnregisterNotification();
          }
        } finally {
          this.settingsFcmToggle.disabled = false;
          this.fcmUpdating = false;
        }
      });
    }

    // 全画面ローディング要素
    this.loadingOverlayEl = document.getElementById('globalLoadingOverlay') as HTMLDivElement;
    this.loadingMessageEl = document.getElementById('globalLoadingMessage') as HTMLParagraphElement;

    // 常時表示 (Wake Lock) トグルボタン: 対応環境でのみ表示 (DEC-026)
    this.btnKeepAwake = document.getElementById('btnKeepAwake') as HTMLButtonElement | null;
    if (this.btnKeepAwake) {
      if (WakeLockService.isSupported()) {
        this.btnKeepAwake.classList.add('supported');
      }
      this.btnKeepAwake.addEventListener('click', async () => {
        this.btnKeepAwake!.disabled = true;
        try {
          await onToggleWakeLock();
        } finally {
          this.btnKeepAwake!.disabled = false;
        }
      });
    }

    // メディアボタンPTT トグルボタン: 対応環境でのみ表示 (DEC-027)
    this.btnMediaPtt = document.getElementById('btnMediaPtt') as HTMLButtonElement | null;
    if (this.btnMediaPtt) {
      if (MediaButtonPttService.isSupported()) {
        this.btnMediaPtt.classList.add('supported');
      }
      this.btnMediaPtt.addEventListener('click', async () => {
        this.btnMediaPtt!.disabled = true;
        try {
          await onToggleMediaPtt();
        } finally {
          this.btnMediaPtt!.disabled = false;
        }
      });
    }

    // TTT (TalkToTalk) ウェイクワード待機トグル (DEC-028)
    this.tttToggleInput = document.getElementById('tttToggleInput') as HTMLInputElement | null;
    this.tttToggleLabel = document.getElementById('tttToggle') as HTMLLabelElement | null;
    this.tttWakeOverlayEl = document.getElementById('tttWakeOverlay') as HTMLDivElement | null;
    this.tttWakeTextEl = document.getElementById('tttWakeText') as HTMLSpanElement | null;
    this.settingsWakeWordInput = document.getElementById('settingsWakeWord') as HTMLInputElement | null;
    this.settingsWakeWordErrorEl = document.getElementById('settingsWakeWordError') as HTMLDivElement | null;

    if (this.tttToggleInput) {
      this.tttToggleInput.addEventListener('change', () => {
        onToggleTTT();
      });
    }

    // カスタムWebhook設定 (DEC-033)
    this.webhookListEl = document.getElementById('customWebhookList') as HTMLDivElement | null;
    this.btnAddWebhook = document.getElementById('btnAddWebhook') as HTMLButtonElement | null;
    this.webhookFormEl = document.getElementById('webhookForm') as HTMLDivElement | null;
    this.webhookLabelInput = document.getElementById('webhookLabel') as HTMLInputElement | null;
    this.webhookMethodSelect = document.getElementById('webhookMethod') as HTMLSelectElement | null;
    this.webhookUrlInput = document.getElementById('webhookUrl') as HTMLInputElement | null;
    this.webhookBodyInput = document.getElementById('webhookBodyTemplate') as HTMLTextAreaElement | null;
    this.webhookFormErrorEl = document.getElementById('webhookFormError') as HTMLDivElement | null;

    if (this.btnAddWebhook) {
      this.btnAddWebhook.addEventListener('click', () => this.openWebhookForm(null));
    }
    const btnWebhookFormCancel = document.getElementById('btnWebhookFormCancel');
    if (btnWebhookFormCancel) {
      btnWebhookFormCancel.addEventListener('click', () => this.closeWebhookForm());
    }
    const btnWebhookFormSave = document.getElementById('btnWebhookFormSave') as HTMLButtonElement | null;
    if (btnWebhookFormSave) {
      btnWebhookFormSave.addEventListener('click', async () => {
        const url = this.webhookUrlInput?.value.trim() || '';
        if (!url.startsWith('https://')) {
          if (this.webhookFormErrorEl) this.webhookFormErrorEl.textContent = 'URLは https:// で始まる必要があります。';
          return;
        }
        if (this.webhookFormErrorEl) this.webhookFormErrorEl.textContent = '';

        btnWebhookFormSave.disabled = true;
        try {
          await this.onSaveWebhook({
            id: this.editingWebhook?.id,
            label: this.webhookLabelInput?.value.trim() || '',
            url: url,
            method: (this.webhookMethodSelect?.value || 'POST') as WebhookMethod,
            bodyTemplate: this.webhookBodyInput?.value || '',
            enabled: this.editingWebhook ? this.editingWebhook.enabled : true
          });
          this.closeWebhookForm();
        } catch (e) {
          if (this.webhookFormErrorEl) this.webhookFormErrorEl.textContent = '保存に失敗しました。';
        } finally {
          btnWebhookFormSave.disabled = false;
        }
      });
    }

    // 自動再生 停止パネル (DEC-032): パネル全域・背後スクリムのどこをクリック/タップしても停止。
    // クリックハンドラはここで一度だけバインドし、再描画で増殖させない（再生パイプラインと疎結合）。
    this.autoplayStopOverlayEl = document.getElementById('autoplayStopOverlay') as HTMLDivElement | null;
    this.autoplaySenderNameEl = document.getElementById('autoplaySenderName') as HTMLSpanElement | null;
    if (this.autoplayStopOverlayEl) {
      this.autoplayStopOverlayEl.addEventListener('click', () => onStopAutoplay());
    }
  }

  /**
   * メディアボタンPTTのON/OFFをヘッダーボタンに反映する (DEC-027)
   */
  updateMediaPttState(isActive: boolean): void {
    if (!this.btnMediaPtt) return;
    this.btnMediaPtt.classList.toggle('active', isActive);
    this.btnMediaPtt.title = isActive
      ? 'メディアボタンPTT有効: イヤフォンの再生/停止ボタンで録音・送信 (タップで解除)'
      : 'メディアボタンPTT: イヤフォンの再生/停止ボタンで録音・送信できるようにします';
  }

  /**
   * 常時表示のON/OFFをヘッダーボタンに反映する (DEC-026)
   */
  updateWakeLockState(isActive: boolean): void {
    if (!this.btnKeepAwake) return;
    this.btnKeepAwake.classList.toggle('active', isActive);
    this.btnKeepAwake.title = isActive
      ? '常時表示中: 画面は自動ロックされません (タップで解除)'
      : '常時表示: 画面の自動ロックを防ぎます';
  }

  /**
   * カスタムWebhook編集フォームを開く (DEC-033)
   * @param webhook 編集対象。null なら新規作成
   */
  private openWebhookForm(webhook: UserWebhook | null): void {
    if (!this.webhookFormEl) return;
    this.editingWebhook = webhook;
    if (this.webhookLabelInput) this.webhookLabelInput.value = webhook?.label || '';
    if (this.webhookUrlInput) this.webhookUrlInput.value = webhook?.url || '';
    if (this.webhookMethodSelect) this.webhookMethodSelect.value = webhook?.method || 'POST';
    if (this.webhookBodyInput) this.webhookBodyInput.value = webhook?.bodyTemplate || '';
    if (this.webhookFormErrorEl) this.webhookFormErrorEl.textContent = '';
    this.webhookFormEl.style.display = 'flex';
    if (this.btnAddWebhook) this.btnAddWebhook.style.display = 'none';
  }

  /** カスタムWebhook編集フォームを閉じる (DEC-033) */
  private closeWebhookForm(): void {
    if (!this.webhookFormEl) return;
    this.editingWebhook = null;
    this.webhookFormEl.style.display = 'none';
    this.updateWebhookAddButton();
  }

  /** Webhook追加ボタンの表示制御（フォーム表示中・上限到達時は隠す/無効化） */
  private updateWebhookAddButton(): void {
    if (!this.btnAddWebhook) return;
    const formOpen = this.webhookFormEl?.style.display === 'flex';
    this.btnAddWebhook.style.display = formOpen ? 'none' : '';
    this.btnAddWebhook.disabled = this.currentWebhooks.length >= UIController.MAX_WEBHOOKS;
    this.btnAddWebhook.textContent = this.btnAddWebhook.disabled
      ? `Webhookの上限 (${UIController.MAX_WEBHOOKS}件) に達しています`
      : '＋ Webhookを追加';
  }

  /**
   * カスタムWebhook一覧の描画 (DEC-033)
   */
  private renderWebhookList(webhooks: UserWebhook[]): void {
    if (!this.webhookListEl) return;
    this.currentWebhooks = webhooks;
    this.webhookListEl.innerHTML = '';

    for (const w of webhooks) {
      const item = document.createElement('div');
      item.className = 'webhook-item' + (w.enabled ? '' : ' disabled');

      // 有効/無効トグル
      const toggle = document.createElement('label');
      toggle.className = 'toggle';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = w.enabled;
      check.addEventListener('change', async () => {
        check.disabled = true;
        try {
          await this.onSaveWebhook({ ...w, enabled: check.checked });
        } finally {
          check.disabled = false;
        }
      });
      const track = document.createElement('span');
      track.className = 'toggle-track';
      toggle.appendChild(check);
      toggle.appendChild(track);

      // ラベルとURL
      const labelArea = document.createElement('span');
      labelArea.className = 'webhook-item-label';
      labelArea.textContent = w.label || '(ラベルなし)';
      const urlEl = document.createElement('span');
      urlEl.className = 'webhook-item-url';
      urlEl.textContent = w.url;
      labelArea.appendChild(urlEl);

      // メソッドチップ
      const chip = document.createElement('span');
      chip.className = 'webhook-method-chip';
      chip.textContent = w.method;

      // 編集・削除ボタン
      const btnEdit = document.createElement('button');
      btnEdit.className = 'btn-copy';
      btnEdit.title = '編集';
      btnEdit.textContent = '✏️';
      btnEdit.addEventListener('click', () => this.openWebhookForm(w));

      const btnDelete = document.createElement('button');
      btnDelete.className = 'btn-copy';
      btnDelete.title = '削除';
      btnDelete.textContent = '🗑️';
      btnDelete.addEventListener('click', async () => {
        if (!confirm(`このWebhook (${w.label || w.url}) を削除しますか？`)) return;
        btnDelete.disabled = true;
        try {
          await this.onDeleteWebhook(w.id);
        } finally {
          btnDelete.disabled = false;
        }
      });

      item.appendChild(toggle);
      item.appendChild(labelArea);
      item.appendChild(chip);
      item.appendChild(btnEdit);
      item.appendChild(btnDelete);
      this.webhookListEl.appendChild(item);
    }

    this.updateWebhookAddButton();
  }

  /**
   * アプリ状態（State）に基づく画面全体の再描画 (DEC-012, DEC-024)
   */
  render(state: UIState): void {
    // 全画面ローディングの制御
    if (this.loadingOverlayEl && this.loadingMessageEl) {
      if (state.isLoading) {
        this.loadingMessageEl.textContent = state.loadingMessage || '読み込み中...';
        this.loadingOverlayEl.classList.add('show');
      } else {
        this.loadingOverlayEl.classList.remove('show');
      }
    }

    // 自動再生 停止パネルの表示制御 (DEC-032)
    if (this.autoplayStopOverlayEl) {
      if (state.isAutoplaying) {
        if (this.autoplaySenderNameEl) {
          this.autoplaySenderNameEl.textContent = state.autoplaySenderName || '';
        }
        this.autoplayStopOverlayEl.classList.add('show');
      } else {
        this.autoplayStopOverlayEl.classList.remove('show');
      }
    }

    // 1. ログイン画面の表示・非表示切り替え
    if (!state.currentUser) {
      this.loginScreenEl.style.display = 'flex';
      return;
    } else {
      this.loginScreenEl.style.display = 'none';
      this.headerUserNicknameEl.textContent = state.currentUser.name;

      // 設定画面の初期値をセット（入力中以外の時に値を同期）
      if (document.activeElement !== this.settingsNicknameInput) {
        this.settingsNicknameInput.value = state.currentUser?.name || '';
      }
      this.settingsAutoplayCheck.checked = state.autoplayEnabled;
      this.settingsRecordModeSelect.value = state.recordMode;
      this.settingsCallSignCheck.checked = state.callSignEnabled;
      this.settingsThemeSelect.value = state.theme;

      if (document.activeElement !== this.settingsDiscordWebhookInput) {
        this.settingsDiscordWebhookInput.value = state.currentUser?.discord_webhook_url || '';
      }

      // カスタムWebhook一覧の同期 (DEC-033)
      this.renderWebhookList(state.webhooks || []);

      // TTT ウェイクワード設定の同期
      if (this.settingsWakeWordInput && document.activeElement !== this.settingsWakeWordInput) {
        this.settingsWakeWordInput.value = state.tttWakeWord || '';
      }

      // 背景設定の同期
      if (state.bgSize) {
        this.settingsBgSizeSelect.value = state.bgSize;
      }
      if (state.bgBlur !== undefined) {
        this.settingsBgBlurCheck.checked = state.bgBlur;
      }

      // TTT トグルの状態同期（録音中はロック）
      if (this.tttToggleInput) {
        this.tttToggleInput.checked = state.isTTTMode;
        this.tttToggleInput.disabled = state.isRecording;
      }
      if (this.tttToggleLabel) {
        this.tttToggleLabel.classList.toggle('listening', state.isTTTMode);
      }

      // FCM UIの制御
      const fcmNotSupportedMsg = document.getElementById('fcmNotSupportedMsg') as HTMLDivElement;
      const fcmToggleRow = document.getElementById('fcmToggleRow') as HTMLDivElement;
      if (state.fcmIsIOS) {
        if (fcmNotSupportedMsg) fcmNotSupportedMsg.style.display = 'block';
        if (fcmToggleRow) fcmToggleRow.style.display = 'none';
      } else {
        if (fcmNotSupportedMsg) fcmNotSupportedMsg.style.display = 'none';
        if (fcmToggleRow) fcmToggleRow.style.display = 'flex';
        if (!this.fcmUpdating) {
          this.settingsFcmToggle.checked = !!state.fcmRegistered;
        }

      }
    }

    // モバイル用表示切り替えクラスの制御 (has-active-chat)
    const containerEl = document.querySelector('.app-container') as HTMLElement;
    if (containerEl) {
      if (state.mobileChatForceOpen) {
        containerEl.classList.add('has-active-chat');
      } else {
        containerEl.classList.remove('has-active-chat');
      }
    }

    // 2. コミュニティ接続状態の更新
    const isConnected = !!state.currentCommunity;
    this.communityMenu.updateConnectionState(
      isConnected,
      state.currentCommunity?.slug
    );

    if (!isConnected) {
      // 未接続時はプレースホルダーと空リストを描画
      this.chatList.render([], [], [], null);
      this.chatWindow.render([], '', 'unconnected');
      return;
    }

    // コミュニティ履歴への保存
    if (state.currentCommunity) {
      this.communityMenu.saveToHistory(
        state.currentCommunity.slug,
        state.currentCommunity.name
      );
    }

    // 3. 統合リスト (サイドバー) の描画
    this.chatList.render(
      state.members,
      state.groups,
      state.selectedUserIds,
      state.activeChatHistoryId,
      state.playingUserId,
      state.playingGroupId
    );

    // 4. チャットウィンドウの描画
    if (state.activeChatHistoryId) {
      // 既存チャットルームのアクティブ時
      let roomTitle = '';
      let roomMembers = '';
      let canRename = false;

      const group = state.groups.find(g => g.id === state.activeChatHistoryId);
      if (group) {
        roomTitle = group.name;
        roomMembers = group.memberNames || `${group.memberCount} 人のメンバー`;
        canRename = true; // グループ名はメンバーなら誰でも編集可能 (DEC-023)
      } else if (state.selectedUserIds.length === 1) {
        const member = state.members.find(m => m.id === state.selectedUserIds[0]);
        roomTitle = member ? `#${member.userNumber} ${member.name}` : '個別チャット';
        roomMembers = member ? (member.isOnline ? '● オンライン' : 'オフライン') : '';
      } else {
        roomTitle = 'チャット';
      }

      this.chatWindow.render(state.messages, state.currentUser.id, 'chat', undefined, roomTitle, roomMembers, state.targetMessageIdToFocus, state.currentCommunity?.slug, canRename);
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
          subtitle: 'リストから話したい相手やグループをタップしてください。複数人での新規グループは「＋新規グループ」から作成できます。'
        }
      );
    }
  }

  // 録音ダイアログ制御の委譲
  showRecordingModal(recordMode: 'both'|'audio_only'|'text_only' = 'both'): void { this.chatWindow.showRecordingModal(recordMode); }
  hideRecordingModal(): void { this.chatWindow.hideRecordingModal(); }
  updateMicLevel(level: number): void { this.chatWindow.updateMicLevel(level); }
  updateRecordingTimer(text: string): void { this.chatWindow.updateRecordingTimer(text); }
  updateDictationPreview(text: string): void { this.chatWindow.updateDictationPreview(text); }
  hideRecordingStopButton(): void { this.chatWindow.hideStopButton(); }
  showMicError(siteUrl: string): void { this.chatWindow.showMicError(siteUrl); }

  /** TTT トグルの ON/OFF をUIに反映する (DEC-028) */
  updateTTTState(isActive: boolean): void {
    if (this.tttToggleInput) this.tttToggleInput.checked = isActive;
    if (this.tttToggleLabel) this.tttToggleLabel.classList.toggle('listening', isActive);
    if (!isActive) this.updateTTTWakeText('');
  }

  /** ウェイクワード認識中テキストをオーバーレイに表示する (DEC-028) */
  updateTTTWakeText(text: string): void {
    if (!this.tttWakeTextEl || !this.tttWakeOverlayEl) return;
    this.tttWakeTextEl.textContent = text;
    this.tttWakeOverlayEl.classList.toggle('visible', text.length > 0);
  }

  /** ウェイクワードヒット演出: 0.3秒テキストを濃く表示してからクリア (DEC-028) */
  showTTTWakeHit(): void {
    if (!this.tttWakeTextEl || !this.tttWakeOverlayEl) return;
    this.tttWakeOverlayEl.classList.add('visible');
    this.tttWakeTextEl.classList.add('hit');
    setTimeout(() => {
      if (this.tttWakeTextEl) {
        this.tttWakeTextEl.classList.remove('hit');
        this.tttWakeTextEl.textContent = '';
      }
      this.tttWakeOverlayEl?.classList.remove('visible');
    }, 300);
  }

  /**
   * コミュニティ退出時に履歴ドロップダウンから削除
   */
  handleCommunityLeave(slug: string): void {
    this.communityMenu.removeFromHistory(slug);
  }
}
