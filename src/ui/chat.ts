export interface MessageItem {
  id: string;
  senderName: string;
  senderId: string;
  audioUrl?: string;     // 音声データパス（存在しない場合はテキストのみ）
  textContent: string;   // 文字起こし、または直接入力テキスト
  isRevoked?: boolean;
  createdAt: Date;
}

/**
 * ChatWindowUI (src/ui/chat.ts)
 * 右ペイン（チャットウィンドウ）でのメッセージ履歴、新規グループプレースホルダー、
 * テキスト入力、録音ダイアログおよび音量レベルメーターの描画とイベント処理を制御します。
 */
export class ChatWindowUI {
  private messagesEl: HTMLDivElement;
  private inputEl: HTMLInputElement;
  private sendBtnEl: HTMLButtonElement;
  private talkBtnEl: HTMLButtonElement;
  private roomTitleEl: HTMLHeadingElement;
  private roomMembersEl: HTMLSpanElement;
  private backBtnEl: HTMLButtonElement;
  
  // モーダル関連の要素
  private modalEl: HTMLDivElement;
  private meterBars: HTMLDivElement[] = [];
  private recordingTimerEl!: HTMLSpanElement;
  private recordingProgressBarEl!: HTMLDivElement;
  private dictationPreviewEl!: HTMLDivElement;
  private mobileDictationWarningEl!: HTMLParagraphElement;
  private stopRecBtnEl: HTMLButtonElement;
  private previewBtnEl: HTMLButtonElement;
  private sendRecBtnEl: HTMLButtonElement;
  private cancelRecBtnEl: HTMLButtonElement;

  private onSendText: (text: string) => void;
  private onStartTalk: () => void;
  private onStopTalk: () => void;
  private onSendAudio: () => void;
  private onPreviewAudio: () => Promise<void>;
  private onCancelTalk: () => void;
  private onPlayMessage: (messageId: string) => Promise<void>;
  private onStopPlayback: () => void;
  private onRevokeMessage: (messageId: string) => void;
  private onBackToSidebar: () => void;

  constructor(
    containerId: string,
    onSendText: (text: string) => void,
    onStartTalk: () => void,
    onStopTalk: () => void,
    onSendAudio: () => void,
    onPreviewAudio: () => Promise<void>,
    onCancelTalk: () => void,
    onPlayMessage: (messageId: string) => Promise<void>,
    onStopPlayback: () => void,
    onRevokeMessage: (messageId: string) => void,
    onBackToSidebar: () => void
  ) {
    this.onSendText = onSendText;
    this.onStartTalk = onStartTalk;
    this.onStopTalk = onStopTalk;
    this.onSendAudio = onSendAudio;
    this.onPreviewAudio = onPreviewAudio;
    this.onCancelTalk = onCancelTalk;
    this.onPlayMessage = onPlayMessage;
    this.onStopPlayback = onStopPlayback;
    this.onRevokeMessage = onRevokeMessage;
    this.onBackToSidebar = onBackToSidebar;

    const container = document.getElementById(containerId);
    if (!container) throw new Error(`Container #${containerId} not found`);

    this.messagesEl = container.querySelector('.chat-messages') as HTMLDivElement;
    this.inputEl = container.querySelector('.chat-input') as HTMLInputElement;
    this.sendBtnEl = container.querySelector('.btn-send-message') as HTMLButtonElement;
    this.talkBtnEl = container.querySelector('.btn-talk-trigger') as HTMLButtonElement;
    this.roomTitleEl = container.querySelector('.chat-room-title') as HTMLHeadingElement;
    this.roomMembersEl = container.querySelector('.chat-room-members-text') as HTMLSpanElement;
    this.backBtnEl = container.querySelector('.btn-back-to-sidebar') as HTMLButtonElement;

    // 録音モーダルのバインド
    this.modalEl = document.getElementById('recordingModal') as HTMLDivElement;
    this.modalEl = document.getElementById('recordingModal') as HTMLDivElement;
    this.recordingTimerEl = document.getElementById('recordingTimer') as HTMLSpanElement;
    this.recordingProgressBarEl = document.getElementById('recordingProgressBar') as HTMLDivElement;
    this.dictationPreviewEl = document.getElementById('recordingDictationPreview') as HTMLDivElement;
    this.mobileDictationWarningEl = document.getElementById('mobileDictationWarning') as HTMLParagraphElement;
    this.stopRecBtnEl = document.querySelector('.btn-modal-stop') as HTMLButtonElement;
    this.previewBtnEl = document.querySelector('.btn-modal-preview') as HTMLButtonElement;
    this.sendRecBtnEl = document.querySelector('.btn-modal-send') as HTMLButtonElement;
    this.cancelRecBtnEl = document.querySelector('.btn-modal-cancel') as HTMLButtonElement;

    // レベルメーターバーのバインド
    const meterContainer = this.modalEl.querySelector('.meter-container') as HTMLDivElement;
    meterContainer.innerHTML = '';
    for (let i = 0; i < 20; i++) {
      const bar = document.createElement('div');
      bar.className = 'meter-bar';
      meterContainer.appendChild(bar);
      this.meterBars.push(bar);
    }

    this.initEvents();
  }

  private initEvents(): void {
    // 送信ボタンクリック
    this.sendBtnEl.addEventListener('click', () => {
      this.emitText();
    });

    // テキスト入力 Enter キー送信
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.emitText();
      }
    });

    // 発話ボタンクリック (録音開始)
    this.talkBtnEl.addEventListener('click', () => {
      this.onStartTalk();
    });

    // 録音モーダル - 録音停止
    this.stopRecBtnEl.addEventListener('click', () => {
      this.onStopTalk();
    });

    // 録音モーダル - プレビュー
    this.previewBtnEl.addEventListener('click', async () => {
      if (this.previewBtnEl.textContent?.includes('■')) {
        this.onStopPlayback();
        return;
      }
      
      // 他の再生ボタンをリセット
      document.querySelectorAll('.btn-play-msg').forEach(b => {
        if (b.textContent === '■') b.textContent = '▶';
      });

      this.previewBtnEl.textContent = '■ プレビュー';
      try {
        await this.onPreviewAudio();
      } finally {
        this.previewBtnEl.textContent = '▶ プレビュー';
      }
    });

    // 録音モーダル - 送信
    this.sendRecBtnEl.addEventListener('click', () => {
      this.onSendAudio();
    });

    // 録音モーダル - キャンセル
    this.cancelRecBtnEl.addEventListener('click', () => {
      this.onCancelTalk();
    });

    // モバイル用戻るボタンクリック
    this.backBtnEl.addEventListener('click', () => {
      this.onBackToSidebar();
    });
  }

  private emitText(): void {
    const value = this.inputEl.value.trim();
    if (value) {
      this.onSendText(value);
      this.inputEl.value = '';
    }
  }

  /**
   * チャット履歴全体の描画
   * @param messages メッセージ一覧
   * @param currentUserId 自分のユーザーID (送受信バブルの左右振分け用)
   * @param state 画面表示タイプ ('unconnected' | 'placeholder' | 'empty' | 'chat')
   * @param placeholderConfig 新規作成プレースホルダー用データ
   */
  render(
    messages: MessageItem[],
    currentUserId: string,
    state: 'unconnected' | 'placeholder' | 'empty' | 'chat',
    placeholderConfig?: { title: string; subtitle: string },
    roomTitle?: string,
    roomMembers?: string,
    targetMessageId?: string,
    communitySlug?: string
  ): void {
    this.messagesEl.innerHTML = '';

    // 1. 未接続プレースホルダー
    if (state === 'unconnected') {
      this.roomTitleEl.textContent = '-';
      this.roomMembersEl.textContent = '-';
      this.showPlaceholder(
        '🔌',
        'コミュニティ未接続',
        '最上部のコンボボックスにコミュニティIDを入力するか、履歴から選択して「接続する」を押してください。'
      );
      this.toggleInputs(false);
      return;
    }

    // 2. 新規部屋作成中プレースホルダー (DEC-011)
    if (state === 'placeholder' && placeholderConfig) {
      this.roomTitleEl.textContent = placeholderConfig.title;
      this.roomMembersEl.textContent = '';
      this.showPlaceholder(
        '👥',
        placeholderConfig.title,
        placeholderConfig.subtitle
      );
      this.toggleInputs(true);
      return;
    }

    // 2.5 未選択時プレースホルダー
    if (state === 'empty' && placeholderConfig) {
      this.roomTitleEl.textContent = placeholderConfig.title;
      this.roomMembersEl.textContent = '';
      this.showPlaceholder(
        '💬',
        placeholderConfig.title,
        placeholderConfig.subtitle
      );
      this.toggleInputs(false);
      return;
    }

    // 3. チャット履歴の描画
    this.roomTitleEl.textContent = roomTitle || 'チャット';
    this.roomMembersEl.textContent = roomMembers || '';
    this.toggleInputs(true);
    
    if (messages.length === 0) {
      this.messagesEl.innerHTML = `
        <div class="chat-placeholder">
          <div class="placeholder-icon">💬</div>
          <div class="placeholder-subtitle">メッセージがありません。<br>下部のボタンから発話するか、テキストを送信してください。</div>
        </div>
      `;
      return;
    }

    messages.forEach((msg) => {
      const isOutgoing = msg.senderId === currentUserId;
      const bubbleEl = document.createElement('div');
      bubbleEl.className = `message-bubble ${isOutgoing ? 'outgoing' : 'incoming'} ${msg.isRevoked ? 'message-revoked' : ''}`;
      bubbleEl.dataset.msgId = msg.id;
      
      const timeStr = msg.createdAt.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

      if (msg.isRevoked) {
        bubbleEl.innerHTML = `
          <span class="message-sender">${isOutgoing ? 'あなた' : msg.senderName}</span>
          <div class="message-body">
            <span class="message-text">この発言は取り消しされました。</span>
          </div>
          <span class="message-time">${timeStr}</span>
        `;
      } else {
        // 音声再生ボタン (▶) の表示判定。音声URLが空のテキストメッセージでもTTS再生用として表示 (DEC-018)
        const playBtnHtml = `<button class="btn-play-msg" data-msg-id="${msg.id}">▶</button>`;
        const deleteBtnHtml = isOutgoing ? `<button class="btn-delete-msg" data-msg-id="${msg.id}" title="発言を取り消す">🗑️</button>` : '';

        bubbleEl.innerHTML = `
          <span class="message-sender">${isOutgoing ? 'あなた' : msg.senderName}</span>
          <div class="message-body">
            ${playBtnHtml}
            <span class="message-text">${msg.textContent}</span>
            ${deleteBtnHtml}
          </div>
          <span class="message-time">${timeStr}</span>
        `;

        // 再生ボタンのクリックイベント
        const playBtn = bubbleEl.querySelector('.btn-play-msg') as HTMLButtonElement;
        playBtn.addEventListener('click', async () => {
          if (playBtn.textContent === '■') {
            this.onStopPlayback();
            return;
          }
          
          // 他の再生ボタンをリセット
          document.querySelectorAll('.btn-play-msg').forEach(b => b.textContent = '▶');
          if (this.previewBtnEl.textContent?.includes('■')) {
            this.previewBtnEl.textContent = '▶ プレビュー';
          }
          
          playBtn.textContent = '■';
          try {
            await this.onPlayMessage(msg.id);
          } finally {
            playBtn.textContent = '▶';
          }
        });

        // 削除ボタンのクリックイベント
        if (isOutgoing) {
          const deleteBtn = bubbleEl.querySelector('.btn-delete-msg') as HTMLButtonElement;
          deleteBtn.addEventListener('click', () => {
            if (window.confirm("発言を取り消しますか。")) {
              this.onRevokeMessage(msg.id);
            }
          });
        }
      }

      // 右クリック (コンテキストメニュー) でURLコピー
      bubbleEl.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        const url = new URL(window.location.href);
        url.hash = ''; // ハッシュをクリア
        if (communitySlug) {
          url.searchParams.set('c', communitySlug);
        }
        url.searchParams.set('m', msg.id);
        
        try {
          await navigator.clipboard.writeText(url.toString());
          alert('メッセージへのダイレクトリンクをコピーしました！\\n' + url.toString());
        } catch (err) {
          console.error('Failed to copy link', err);
        }
      });

      this.messagesEl.appendChild(bubbleEl);
    });

    // スクロールおよびハイライトの処理
    if (targetMessageId) {
      setTimeout(() => {
        const targetEl = this.messagesEl.querySelector(`.message-bubble[data-msg-id="${targetMessageId}"]`) as HTMLElement;
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetEl.classList.add('highlight-pulse');
          // アニメーション完了後にクラスを削除
          setTimeout(() => targetEl.classList.remove('highlight-pulse'), 2500);
        }
      }, 100);
    } else {
      // 最下部まで自動スクロール
      this.scrollToBottom();
    }
  }

  private showPlaceholder(icon: string, title: string, subtitle: string): void {
    this.messagesEl.innerHTML = `
      <div class="chat-placeholder">
        <div class="placeholder-icon">${icon}</div>
        <div class="placeholder-title">${title}</div>
        <div class="placeholder-subtitle">${subtitle}</div>
      </div>
    `;
  }

  private toggleInputs(enabled: boolean): void {
    const footerEl = this.inputEl.closest('.chat-footer') as HTMLElement;
    if (footerEl) {
      footerEl.style.display = enabled ? 'flex' : 'none';
    }
    
    this.inputEl.disabled = !enabled;
    this.sendBtnEl.disabled = !enabled;
    this.talkBtnEl.disabled = !enabled;
    if (enabled) {
      this.inputEl.placeholder = 'メッセージを入力...';
    }
  }

  scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /**
   * 録音モーダルの表示
   */
  showRecordingModal(): void {
    this.modalEl.classList.add('show');
    this.stopRecBtnEl.disabled = false;
    this.previewBtnEl.disabled = true;
    this.sendRecBtnEl.disabled = false;
    this.cancelRecBtnEl.disabled = false;
    
    this.stopRecBtnEl.style.display = '';
    this.previewBtnEl.style.display = '';
    this.sendRecBtnEl.style.display = '';
    this.cancelRecBtnEl.style.display = '';

    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile) {
      if (this.mobileDictationWarningEl) this.mobileDictationWarningEl.style.display = 'block';
    } else {
      if (this.mobileDictationWarningEl) this.mobileDictationWarningEl.style.display = 'none';
    }
    
    if (this.dictationPreviewEl) {
      this.dictationPreviewEl.style.display = 'block';
      this.dictationPreviewEl.textContent = '認識中...';
    }

    // メーターの初期化
    this.updateMicLevel(0);
    this.updateRecordingTimer('00:15');
    this.previewBtnEl.textContent = '▶ プレビュー';
    this.previewBtnEl.disabled = true;
    this.sendRecBtnEl.disabled = false;
    
    // プログレスバーのリセットとアニメーション開始
    if (this.recordingProgressBarEl) {
      this.recordingProgressBarEl.style.transition = 'none';
      this.recordingProgressBarEl.style.width = '0%';
      void this.recordingProgressBarEl.offsetWidth; // force reflow
      this.recordingProgressBarEl.style.transition = 'width 15s linear';
      this.recordingProgressBarEl.style.width = '100%';
    }
      
    const statusTextEl = this.modalEl.querySelector('#recordingStatusText') as HTMLSpanElement;
    const dotEl = this.modalEl.querySelector('.status-dot') as HTMLSpanElement;
    if (statusTextEl) statusTextEl.textContent = '音声録音中...';
    if (dotEl) dotEl.classList.remove('stopped');
  }


  updateRecordingTimer(text: string): void {
    if (this.recordingTimerEl) this.recordingTimerEl.textContent = text;
  }

  updateDictationPreview(text: string): void {
    if (this.dictationPreviewEl) this.dictationPreviewEl.textContent = text;
  }

  hideStopButton(): void {
    this.stopRecBtnEl.disabled = true;
    this.previewBtnEl.disabled = false;
    this.sendRecBtnEl.disabled = false;
    
    if (this.recordingProgressBarEl) {
      const computedWidth = window.getComputedStyle(this.recordingProgressBarEl).width;
      this.recordingProgressBarEl.style.transition = 'none';
      this.recordingProgressBarEl.style.width = computedWidth;
    }
    
    // ステータス表示の更新
    const statusTextEl = this.modalEl.querySelector('#recordingStatusText') as HTMLSpanElement;
    const dotEl = this.modalEl.querySelector('.status-dot') as HTMLSpanElement;
    if (statusTextEl) statusTextEl.textContent = '録音停止（未送信）';
    if (dotEl) dotEl.classList.add('stopped');
  }

  /**
   * 録音モーダルの非表示
   */
  hideRecordingModal(): void {
    this.modalEl.classList.remove('show');
    if (this.recordingProgressBarEl) {
      this.recordingProgressBarEl.style.transition = 'none';
      this.recordingProgressBarEl.style.width = '0%';
    }
  }

  /**
   * マイク入力レベルメーターの更新 (DEC-006)
   * @param level 音量 (0 ~ 100)
   */
  updateMicLevel(level: number): void {
    const totalBars = this.meterBars.length;
    
    // レベルに応じて光らせるバーの数を決定 (0 ~ 20本)
    const activeBarsCount = Math.ceil((level / 100) * totalBars);

    this.meterBars.forEach((bar, index) => {
      if (index < activeBarsCount) {
        // 音量に応じて高さを伸ばす
        const heightPercent = 20 + (index / totalBars) * 80;
        bar.style.height = `${heightPercent}%`;
        bar.style.opacity = '1';
        bar.style.backgroundColor = 'var(--color-success)';
      } else {
        // 非アクティブ時は小さく暗くする
        bar.style.height = '10%';
        bar.style.opacity = '0.2';
        bar.style.backgroundColor = 'var(--color-text-muted)';
      }
    });
  }

  /**
   * マイクパーミッションエラー等の深刻なエラー表示 (DEC-008)
   * @param siteUrl エラー時コピー用URL
   */
  showMicError(siteUrl: string): void {
    this.hideRecordingModal();
    
    const settingsUrl = `chrome://settings/content/siteDetails?site=${encodeURIComponent(siteUrl)}`;
    
    const confirmCopy = confirm(
      'マイクのアクセス権限が必要です。\n\n' +
      'ブラウザのセキュリティ制限により設定画面を直接開けません。\n' +
      '設定画面のURLをクリップボードにコピーしますか？\n' +
      'コピー後、新しいタブのアドレスバーに貼り付けてマイクを「許可」にしてください。'
    );

    if (confirmCopy) {
      navigator.clipboard.writeText(settingsUrl).then(() => {
        alert('設定URLをコピーしました！新しいタブに貼り付けてください。\n\n' + settingsUrl);
      }).catch(err => {
        console.error('Failed to copy settings URL:', err);
      });
    }
  }
}
