export interface CommunityHistoryItem {
  slug: string;
  name: string;
}

/**
 * CommunitySelectorUI (src/ui/community.ts)
 * 画面最上部（ヘッダー）の「編集可能コンボボックス」を用いた
 * コミュニティ選択・入室履歴・接続アクションを制御します。
 */
export class CommunitySelectorUI {
  private inputEl: HTMLInputElement;
  private dropdownEl: HTMLDivElement;
  private connectBtnEl: HTMLButtonElement;
  private disconnectBtnEl: HTMLButtonElement;
  private arrowEl: HTMLElement;
  
  private onConnect: (slug: string) => void;
  private onDisconnect: () => void;

  private history: CommunityHistoryItem[] = [];

  constructor(
    containerId: string,
    onConnect: (slug: string) => void,
    onDisconnect: () => void
  ) {
    this.onConnect = onConnect;
    this.onDisconnect = onDisconnect;

    // DOM要素のバインド
    const container = document.getElementById(containerId);
    if (!container) throw new Error(`Container #${containerId} not found`);

    this.inputEl = container.querySelector('.combobox-input') as HTMLInputElement;
    this.dropdownEl = container.querySelector('.combobox-dropdown') as HTMLDivElement;
    this.connectBtnEl = container.querySelector('.btn-connect') as HTMLButtonElement;
    this.disconnectBtnEl = container.querySelector('.btn-disconnect') as HTMLButtonElement;

    // 切断ボタンのイベント登録
    if (this.disconnectBtnEl) {
      this.disconnectBtnEl.addEventListener('click', () => {
        this.onDisconnect();
      });
    }
    this.arrowEl = container.querySelector('.combobox-arrow') as HTMLElement;

    this.loadHistory();
    this.initEvents();
  }

  /**
   * LocalStorage から入室履歴をロード
   */
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

  /**
   * LocalStorage に入室履歴を保存
   */
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

    this.renderDropdown();
  }

  /**
   * 指定したコミュニティを履歴から削除 (退出時など)
   */
  removeFromHistory(slug: string): void {
    this.history = this.history.filter((item) => item.slug !== slug);
    try {
      localStorage.setItem('chatransceiver_community_history', JSON.stringify(this.history));
    } catch (e) {
      console.error('Failed to update community history in LocalStorage:', e);
    }
    this.renderDropdown();
  }

  /**
   * イベントハンドラの初期化
   */
  private initEvents(): void {
    // 接続ボタン
    this.connectBtnEl.addEventListener('click', () => {
      const value = this.inputEl.value.trim();
      if (value) {
        this.onConnect(value);
      }
    });

    // キーボード Enter での接続
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const value = this.inputEl.value.trim();
        if (value) {
          this.onConnect(value);
          this.closeDropdown();
        }
      }
    });

    // 矢印ボタンでのドロップダウン開閉
    this.arrowEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDropdown();
    });

    // インプットフォーカス時にもし履歴があればドロップダウンを開く
    this.inputEl.addEventListener('focus', () => {
      if (this.history.length > 0) {
        this.openDropdown();
      }
    });

    // 画面外クリックでドロップダウンを閉じる
    document.addEventListener('click', () => {
      this.closeDropdown();
    });
  }

  /**
   * ドロップダウンの描画
   */
  renderDropdown(): void {
    this.dropdownEl.innerHTML = '';
    
    if (this.history.length === 0) {
      this.dropdownEl.innerHTML = '<div class="dropdown-item" style="color:var(--color-text-muted); cursor:default;">履歴がありません</div>';
      return;
    }

    this.history.forEach((item) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'dropdown-item';
      const displayName = item.name || `${item.slug.toUpperCase()} コミュニティ`;
      itemEl.innerHTML = `
        <span class="item-slug">${item.slug}</span>
        <span class="item-desc" style="font-size:11px; color:var(--color-text-muted);">${displayName}</span>
      `;
      
      // クリック時に選択して接続
      itemEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.inputEl.value = item.slug;
        this.closeDropdown();
        this.onConnect(item.slug);
      });

      this.dropdownEl.appendChild(itemEl);
    });
  }

  private toggleDropdown(): void {
    this.dropdownEl.classList.toggle('show');
  }

  private openDropdown(): void {
    this.renderDropdown();
    this.dropdownEl.classList.add('show');
  }

  private closeDropdown(): void {
    this.dropdownEl.classList.remove('show');
  }

  /**
   * UIの接続状態を更新
   * @param connected 接続しているかどうか
   * @param activeSlug 接続中のコミュニティスラッグ
   */
  updateConnectionState(isConnected: boolean, currentSlug?: string): void {
    if (isConnected && currentSlug) {
      this.inputEl.value = currentSlug;
      this.inputEl.readOnly = true;
      this.inputEl.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
      this.arrowEl.style.display = 'none';
      this.connectBtnEl.style.display = 'none';
      if (this.disconnectBtnEl) this.disconnectBtnEl.style.display = 'block';
    } else {
      this.inputEl.value = '';
      this.inputEl.readOnly = false;
      this.inputEl.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
      this.arrowEl.style.display = 'flex';
      this.connectBtnEl.style.display = 'block';
      if (this.disconnectBtnEl) this.disconnectBtnEl.style.display = 'none';
    }
  }
}
