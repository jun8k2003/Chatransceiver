export interface GroupItem {
  id: string;         // チャット履歴ID (ChatHistoryID)
  name: string;       // グループ表示名 (例: 「ユーザーA, ユーザーB, ユーザーC」)
  memberCount: number;// グループのメンバー数
  unreadCount: number;// 未読メッセージ数
  latestUnreadTime?: number; // 最終未読日時
}

/**
 * GroupListUI (src/ui/groups.ts)
 * 中央ペイン（グループチャット一覧）の描画と、
 * 単一選択（択一）チェックボックス操作を制御します。
 */
export class GroupListUI {
  private listEl: HTMLDivElement;
  private onGroupSelect: (groupId: string | null) => void;

  constructor(
    containerId: string,
    onGroupSelect: (groupId: string | null) => void
  ) {
    this.onGroupSelect = onGroupSelect;

    const container = document.getElementById(containerId);
    if (!container) throw new Error(`Container #${containerId} not found`);
    this.listEl = container.querySelector('.pane-content') as HTMLDivElement;
  }

  /**
   * グループ一覧の描画
   * @param groups 表示するグループチャット一覧
   * @param activeGroupId 現在アクティブなグループチャットID
   * @param playingGroupId 現在音声自動再生中のグループチャットID (インジケータ用)
   */
  render(
    groups: GroupItem[],
    activeGroupId: string | null,
    playingGroupId?: string
  ): void {
    this.listEl.innerHTML = '';

    if (groups.length === 0) {
      this.listEl.innerHTML = '<div class="chat-placeholder" style="padding: 20px;"><div class="placeholder-subtitle">グループがありません</div></div>';
      return;
    }

    // 未読件数があるグループを上にソートし、未読がある場合は最終未読日時の新しい順
    const sortedGroups = [...groups].sort((a, b) => {
      const aUnread = a.unreadCount || 0;
      const bUnread = b.unreadCount || 0;
      if (aUnread > 0 && bUnread > 0) {
        return (b.latestUnreadTime || 0) - (a.latestUnreadTime || 0);
      }
      return bUnread - aUnread;
    });

    sortedGroups.forEach((group) => {
      const isSelected = activeGroupId === group.id;
      const isPlaying = playingGroupId === group.id;
      const isUnread = group.unreadCount > 0;

      const itemEl = document.createElement('div');
      itemEl.className = `list-item ${isPlaying ? 'playing' : ''} ${
        isSelected ? 'selected' : ''
      } ${isUnread ? 'unread' : ''}`;
      itemEl.dataset.groupId = group.id;

      itemEl.innerHTML = `
        <div class="item-info">
          <div class="item-avatar" style="border-radius:8px;">Gp</div>
          <div class="item-details">
            <span class="item-name">${group.name}</span>
            <span class="item-status">${group.memberCount} 人のメンバー</span>
          </div>
        </div>
        
        <!-- 音声再生中インジケータ (🔊) -->
        <div class="playing-indicator">
          <div class="wave-bar"></div>
          <div class="wave-bar"></div>
          <div class="wave-bar"></div>
        </div>
        
        <!-- 未読バッジ -->
        ${group.unreadCount > 0 ? 
          `<span style="display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; margin-right: 12px; color: #ef4444; font-size: 11px; font-weight: bold;" title="${group.unreadCount}件の未読">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
            ${group.unreadCount}
          </span>` : ''}
        
        <!-- 単一選択用の丸型チェックボックス -->
        <label class="checkbox-wrapper" style="margin-left: 10px;">
          <input type="checkbox" name="group-select" value="${group.id}" ${
        isSelected ? 'checked' : ''
      } />
          <span class="checkbox-custom"></span>
        </label>
      `;

      const checkbox = itemEl.querySelector('input[type="checkbox"]') as HTMLInputElement;

      // チェックボックス変更イベント
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          this.onGroupSelect(group.id);
        } else {
          this.onGroupSelect(null); // チェックを外した場合は未選択
        }
      });

      // アイテム全体クリックでチェック切り替え
      itemEl.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.checkbox-wrapper')) {
          return;
        }
        const wasChecked = checkbox.checked;
        this.clearAllChecks();
        
        if (!wasChecked) {
          checkbox.checked = true;
          this.onGroupSelect(group.id);
        } else {
          checkbox.checked = false;
          this.onGroupSelect(null);
        }
      });

      this.listEl.appendChild(itemEl);
    });
  }

  /**
   * 画面上のグループチェックをすべてクリアする
   */
  private clearAllChecks(): void {
    const checkboxes = this.listEl.querySelectorAll(
      'input[name="group-select"]'
    ) as NodeListOf<HTMLInputElement>;
    checkboxes.forEach((cb) => {
      cb.checked = false;
    });
  }
}
