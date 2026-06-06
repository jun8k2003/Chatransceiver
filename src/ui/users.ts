export interface MemberItem {
  id: string;
  name: string;
  userNumber: number;
  isOnline: boolean;
  unreadCount?: number;
  latestUnreadTime?: number;
}

/**
 * UserListUI (src/ui/users.ts)
 * 左ペイン（個別チャット一覧 / コミュニティメンバー）の描画と、
 * 複数選択可能なチェックボックス操作を制御します。
 */
export class UserListUI {
  private listEl: HTMLDivElement;
  private searchInput: HTMLInputElement;
  private searchBtn: HTMLButtonElement;
  private selectAllBtn: HTMLButtonElement;
  private searchQuery: string = '';
  private onUserCheckChange: (selectedUserIds: string[]) => void;
  private onUserChatClear: (userId: string, userName: string) => void;

  constructor(
    containerId: string,
    onUserCheckChange: (selectedUserIds: string[]) => void,
    onUserChatClear: (userId: string, userName: string) => void
  ) {
    this.onUserCheckChange = onUserCheckChange;
    this.onUserChatClear = onUserChatClear;

    const container = document.getElementById(containerId);
    if (!container) throw new Error(`Container #${containerId} not found`);
    this.listEl = container.querySelector('.pane-content') as HTMLDivElement;
    
    this.searchInput = container.querySelector('#userSearchInput') as HTMLInputElement;
    this.searchBtn = container.querySelector('#btnUserSearch') as HTMLButtonElement;

    if (this.searchBtn && this.searchInput) {
      this.searchBtn.addEventListener('click', () => {
        this.searchInput.style.display = 'block';
        this.searchInput.focus();
      });

      this.searchInput.addEventListener('input', () => {
        this.searchQuery = this.searchInput.value.toLowerCase();
        // 絞り込みが行われたらすべての選択チェックボックスを外す
        this.onUserCheckChange([]);
      });

      this.searchInput.addEventListener('blur', () => {
        if (this.searchInput.value.trim() === '') {
          this.searchInput.style.display = 'none';
        }
      });
    }

    this.selectAllBtn = container.querySelector('#btnUserSelectAll') as HTMLButtonElement;
    if (this.selectAllBtn) {
      this.selectAllBtn.addEventListener('click', () => {
        const checkboxes = this.listEl.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
        if (checkboxes.length === 0) return;

        let allChecked = true;
        checkboxes.forEach(cb => {
          if (!cb.checked) allChecked = false;
        });

        const newState = !allChecked;
        const selectedUserIds: string[] = [];
        if (newState) {
          checkboxes.forEach(cb => selectedUserIds.push(cb.value));
        }

        this.onUserCheckChange(selectedUserIds);
      });
    }
  }

  /**
   * メンバー一覧の描画
   * @param members コミュニティのメンバー一覧
   * @param checkedUserIds 現在選択されているユーザーIDのリスト
   * @param playingUserId 現在音声自動再生中のユーザーID (インジケータ表示用)
   */
  render(
    members: MemberItem[],
    checkedUserIds: string[],
    playingUserId?: string
  ): void {
    this.listEl.innerHTML = '';

    let displayMembers = members;
    if (this.searchQuery) {
      displayMembers = members.filter(m => m.name.toLowerCase().includes(this.searchQuery));
    }

    if (displayMembers.length === 0) {
      this.listEl.innerHTML = '<div class="chat-placeholder" style="padding: 20px;"><div class="placeholder-subtitle">メンバーが見つかりません</div></div>';
      return;
    }

    displayMembers.forEach((member) => {
      const isChecked = checkedUserIds.includes(member.id);
      const isPlaying = playingUserId === member.id;
      const isSelected = checkedUserIds.length === 1 && checkedUserIds[0] === member.id;

      const itemEl = document.createElement('div');
      itemEl.className = `list-item ${isPlaying ? 'playing' : ''} ${isSelected ? 'selected' : ''}`;
      itemEl.dataset.userId = member.id;

      // 初回文字をアイコン表示用に使用
      const firstChar = member.name.charAt(0).toUpperCase();
      
      // オンラインインジケーター
      const onlineIndicatorHtml = member.isOnline 
        ? `<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background-color:var(--color-success); margin-left:6px; box-shadow:0 0 4px var(--color-success);" title="オンライン"></span>` 
        : '';
      
      // 目立つ赤色 (#ef4444) のチャットアイコン(SVG)と未読数を表示
      const badgeHtml = member.unreadCount ? 
        `<span style="display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; color: #ef4444; font-size: 11px; font-weight: bold;" title="${member.unreadCount}件の未読">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
          ${member.unreadCount}
        </span>` : '';

      itemEl.innerHTML = `
        <div class="item-info">
          <div class="item-avatar">${firstChar}</div>
          <div class="item-details" style="position: relative; width: 100%;">
            <span class="item-name" style="display:flex; align-items:center;">#${member.userNumber} ${member.name} ${onlineIndicatorHtml} ${badgeHtml}</span>
          </div>
        </div>
        
        <!-- 音声自動再生中インジケータ (🔊) -->
        <div class="playing-indicator">
          <div class="wave-bar"></div>
          <div class="wave-bar"></div>
          <div class="wave-bar"></div>
        </div>
        
        <!-- 複数選択可能なチェックボックス -->
        <label class="checkbox-wrapper" style="margin-left: 10px;">
          <input type="checkbox" value="${member.id}" ${isChecked ? 'checked' : ''} />
          <span class="checkbox-custom"></span>
        </label>
      `;

      // チェックボックスの変更イベント
      const checkbox = itemEl.querySelector('input[type="checkbox"]') as HTMLInputElement;
      checkbox.addEventListener('change', () => {
        this.emitCheckedUsers();
      });

      // アイテム全体クリックでチェック切り替え（チェックボックス自体のクリックは伝搬させない）
      itemEl.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.checkbox-wrapper')) {
          return; // チェックボックス領域のクリック時は多重トグルを防ぐためスキップ
        }
        checkbox.checked = !checkbox.checked;
        this.emitCheckedUsers();
      });

      // 右クリック（コンテキストメニュー）で個別チャット履歴削除
      itemEl.addEventListener('contextmenu', (e) => {
        e.preventDefault(); // デフォルトの右クリックメニューを無効化
        this.onUserChatClear(member.id, member.name);
      });

      this.listEl.appendChild(itemEl);
    });
  }

  /**
   * 現在チェックが入っているユーザーIDの配列を取得し、イベント通知
   */
  private emitCheckedUsers(): void {
    const checkedCheckboxes = this.listEl.querySelectorAll(
      'input[type="checkbox"]:checked'
    ) as NodeListOf<HTMLInputElement>;
    
    const selectedUserIds: string[] = [];
    checkedCheckboxes.forEach((cb) => {
      selectedUserIds.push(cb.value);
    });

    this.onUserCheckChange(selectedUserIds);
  }
}
