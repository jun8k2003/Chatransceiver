export interface CommunityHistoryItem {
  slug: string;
  name: string;
}

/**
 * CommunityMenuUI (src/ui/community.ts)
 * ヘッダーの「コミュニティ名ピル」とそのドロップダウンメニューを制御します (DEC-024)。
 * 接続・入室履歴・招待リンクコピー・切断・退会の操作をここに集約します。
 */
export class CommunityMenuUI {
  private pillEl: HTMLButtonElement;
  private pillNameEl: HTMLSpanElement;
  private menuEl: HTMLDivElement;
  private slugInputEl: HTMLInputElement;
  private connectBtnEl: HTMLButtonElement;
  private historyListEl: HTMLDivElement;
  private connectedSectionEl: HTMLDivElement;
  private copyLinkTextEl: HTMLSpanElement;

  private onConnect: (slug: string) => void;
  private onDisconnect: () => void;
  private onLeave: () => void;

  private history: CommunityHistoryItem[] = [];
  private currentSlug: string | null = null;

  constructor(
    containerId: string,
    onConnect: (slug: string) => void,
    onDisconnect: () => void,
    onLeave: () => void
  ) {
    this.onConnect = onConnect;
    this.onDisconnect = onDisconnect;
    this.onLeave = onLeave;

    const container = document.getElementById(containerId);
    if (!container) throw new Error(`Container #${containerId} not found`);

    this.pillEl = container.querySelector('.community-pill') as HTMLButtonElement;
    this.pillNameEl = container.querySelector('.community-pill-name') as HTMLSpanElement;
    this.menuEl = container.querySelector('.community-menu') as HTMLDivElement;
    this.slugInputEl = container.querySelector('.community-slug-input') as HTMLInputElement;
    this.connectBtnEl = container.querySelector('.btn-connect') as HTMLButtonElement;
    this.historyListEl = container.querySelector('.community-history-list') as HTMLDivElement;
    this.connectedSectionEl = container.querySelector('.menu-connected-section') as HTMLDivElement;
    this.copyLinkTextEl = container.querySelector('.copy-link-text') as HTMLSpanElement;

    this.loadHistory();
    this.initEvents();
  }

  private loadHistory(): void {
    try {
      const stored = localStorage.getItem('chatransceiver_community_history');
      if (stored) {
        this.history = JSON.parse(stored);
      }
    } catch (e) {
      console.error('Failed to load community history from LocalStorage:', e);
      this.history = [];
    }
  }

  saveToHistory(slug: string, name: string): void {
    // 重複を削除して先頭に追加
    this.history = this.history.filter((item) => item.slug !== slug);
    this.history.unshift({ slug, name });

    // 最大10件まで保持
    if (this.history.length > 10) {
      this.history.pop();
    }

    try {
      localStorage.setItem('chatransceiver_community_history', JSON.stringify(this.history));
    } catch (e) {
      console.error('Failed to save community history to LocalStorage:', e);
    }

    this.renderHistory();
  }

  removeFromHistory(slug: string): void {
    this.history = this.history.filter((item) => item.slug !== slug);
    try {
      localStorage.setItem('chatransceiver_community_history', JSON.stringify(this.history));
    } catch (e) {
      console.error('Failed to update community history in LocalStorage:', e);
    }
    this.renderHistory();
  }

  private initEvents(): void {
    // ピルクリックでメニュー開閉
    this.pillEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.menuEl.classList.contains('show')) {
        this.closeMenu();
      } else {
        this.openMenu();
      }
    });

    // メニュー内クリックは外側クリック判定に伝搬させない
    this.menuEl.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // 画面外クリックでメニューを閉じる
    document.addEventListener('click', () => {
      this.closeMenu();
    });

    // 接続ボタン
    this.connectBtnEl.addEventListener('click', () => {
      const value = this.slugInputEl.value.trim();
      if (value) {
        this.closeMenu();
        this.onConnect(value);
      }
    });

    // キーボード Enter での接続
    this.slugInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const value = this.slugInputEl.value.trim();
        if (value) {
          this.closeMenu();
          this.onConnect(value);
        }
      }
    });

    // 招待リンクコピー
    const copyLinkItem = this.menuEl.querySelector('.menu-item-copy-link') as HTMLDivElement;
    copyLinkItem.addEventListener('click', async () => {
      if (!this.currentSlug) return;
      const url = window.location.origin + window.location.pathname + '?c=' + this.currentSlug;
      try {
        await navigator.clipboard.writeText(url);
        const originalText = this.copyLinkTextEl.textContent;
        this.copyLinkTextEl.textContent = 'コピーしました！';
        setTimeout(() => {
          this.copyLinkTextEl.textContent = originalText;
        }, 2000);
      } catch (e) {
        console.error('Failed to copy community link', e);
      }
    });

    // 切断
    const disconnectItem = this.menuEl.querySelector('.menu-item-disconnect') as HTMLDivElement;
    disconnectItem.addEventListener('click', () => {
      this.closeMenu();
      this.onDisconnect();
    });

    // 退会
    const leaveItem = this.menuEl.querySelector('.menu-item-leave') as HTMLDivElement;
    leaveItem.addEventListener('click', () => {
      if (confirm('本当にこのコミュニティから退会しますか？\n自分が参加していたチャット履歴はすべて削除され、参加履歴からも削除されます。')) {
        this.closeMenu();
        this.onLeave();
      }
    });
  }

  private renderHistory(): void {
    this.historyListEl.innerHTML = '';

    if (this.history.length === 0) {
      this.historyListEl.innerHTML = '<div class="history-empty">履歴がありません</div>';
      return;
    }

    this.history.forEach((item) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'history-item';
      itemEl.innerHTML = `
        <span class="history-item-slug">${item.slug}</span>
        <button class="btn-delete-history" title="履歴から削除">
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
        </button>
      `;

      // 履歴クリックで即接続
      itemEl.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.btn-delete-history')) {
          return;
        }
        this.closeMenu();
        this.onConnect(item.slug);
      });

      const deleteBtn = itemEl.querySelector('.btn-delete-history') as HTMLButtonElement;
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeFromHistory(item.slug);
      });

      this.historyListEl.appendChild(itemEl);
    });
  }

  private openMenu(): void {
    this.renderHistory();
    this.menuEl.classList.add('show');
    if (!this.currentSlug) {
      this.slugInputEl.focus();
    }
  }

  private closeMenu(): void {
    this.menuEl.classList.remove('show');
  }

  /**
   * UIの接続状態を更新
   */
  updateConnectionState(isConnected: boolean, currentSlug?: string): void {
    if (isConnected && currentSlug) {
      this.currentSlug = currentSlug;
      this.pillNameEl.textContent = currentSlug;
      this.connectedSectionEl.style.display = 'block';
    } else {
      this.currentSlug = null;
      this.pillNameEl.textContent = '未接続';
      this.connectedSectionEl.style.display = 'none';
      this.slugInputEl.value = '';
    }
  }
}
