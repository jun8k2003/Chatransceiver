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
  private onGroupDelete: (groupId: string, groupName: string) => void;

  constructor(
    containerId: string,
    onGroupSelect: (groupId: string | null) => void,
    onGroupDelete: (groupId: string, groupName: string) => void
  ) {
    this.onGroupSelect = onGroupSelect;
    this.onGroupDelete = onGroupDelete;

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

    groups.forEach((group) => {
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
          <button class="btn-delete-group" style="background:transparent; border:none; cursor:pointer; color:var(--color-danger); padding:0 8px 0 0; display:flex; align-items:center;" title="グループを削除">
            <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
          </button>
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

      // ごみ箱ボタンのクリック処理
      const deleteBtn = itemEl.querySelector('.btn-delete-group') as HTMLButtonElement;
      if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation(); // グループの選択切り替えを防ぐ
          this.onGroupDelete(group.id, group.name);
        });
      }

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
