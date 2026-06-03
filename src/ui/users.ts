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
  private onUserCheckChange: (selectedUserIds: string[]) => void;

  constructor(
    containerId: string,
    onUserCheckChange: (selectedUserIds: string[]) => void
  ) {
    this.onUserCheckChange = onUserCheckChange;

    const container = document.getElementById(containerId);
    if (!container) throw new Error(`Container #${containerId} not found`);
    this.listEl = container.querySelector('.pane-content') as HTMLDivElement;
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

    if (members.length === 0) {
      this.listEl.innerHTML = '<div class="chat-placeholder" style="padding: 20px;"><div class="placeholder-subtitle">メンバーがいません</div></div>';
      return;
    }

    // 未読件数があるメンバーを上にソートし、未読がある場合は最終未読日時の新しい順
    const sortedMembers = [...members].sort((a, b) => {
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

    sortedMembers.forEach((member) => {
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
