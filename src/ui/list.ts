export interface MemberItem {
  id: string;
  name: string;
  userNumber: number;
  isOnline: boolean;
  unreadCount?: number;
  latestUnreadTime?: number;
}

export interface GroupItem {
  id: string;          // チャット履歴ID (ChatHistoryID)
  name: string;        // 表示名 (カスタム名 or メンバー名の羅列)
  customName?: string; // カスタム名 (DEC-023)
  memberNames: string; // メンバー名のカンマ羅列
  memberCount: number;
  unreadCount: number;
  latestUnreadTime?: number;
}

/** 統合リストの内部表現 */
interface ListEntry {
  type: 'user' | 'group';
  id: string;
  unread: number;
  latestUnreadTime: number;
  member?: MemberItem;
  group?: GroupItem;
}

/**
 * ChatListUI (src/ui/list.ts)
 * 個別チャットとグループチャットを1つに統合したリスト (DEC-024)。
 * - 行のクリックで即チャットを開く
 * - フィルタチップ (すべて/個別/グループ) と検索による絞り込み
 * - 「＋新規グループ」からの複数メンバー選択モード
 */
export class ChatListUI {
  private listEl: HTMLDivElement;
  private searchInput: HTMLInputElement;
  private selectModeCountEl: HTMLSpanElement;
  private btnSelectModeStart: HTMLButtonElement;

  private filter: 'all' | 'user' | 'group' = 'all';
  private searchQuery: string = '';
  private selectMode: boolean = false;
  private checkedIds: Set<string> = new Set();

  // 直近のrender引数を保持し、フィルタ変更等での再描画に使う
  private lastMembers: MemberItem[] = [];
  private lastGroups: GroupItem[] = [];
  private lastSelectedUserIds: string[] = [];
  private lastActiveChatId: string | null = null;
  private lastPlayingUserId?: string;
  private lastPlayingGroupId?: string;

  private onOpenUser: (userId: string) => void;
  private onOpenGroup: (groupId: string) => void;
  private onCreateGroup: (userIds: string[]) => void;
  private onUserChatClear: (userId: string, userName: string) => void;
  private onGroupDelete: (groupId: string, groupName: string) => void;

  constructor(
    onOpenUser: (userId: string) => void,
    onOpenGroup: (groupId: string) => void,
    onCreateGroup: (userIds: string[]) => void,
    onUserChatClear: (userId: string, userName: string) => void,
    onGroupDelete: (groupId: string, groupName: string) => void
  ) {
    this.onOpenUser = onOpenUser;
    this.onOpenGroup = onOpenGroup;
    this.onCreateGroup = onCreateGroup;
    this.onUserChatClear = onUserChatClear;
    this.onGroupDelete = onGroupDelete;

    this.listEl = document.getElementById('chatList') as HTMLDivElement;
    this.searchInput = document.getElementById('chatListSearchInput') as HTMLInputElement;
    this.selectModeCountEl = document.getElementById('selectModeCount') as HTMLSpanElement;
    this.btnSelectModeStart = document.getElementById('btnSelectModeStart') as HTMLButtonElement;

    // フィルタチップ
    document.querySelectorAll('.filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        this.filter = (chip as HTMLElement).dataset.filter as 'all' | 'user' | 'group';
        this.rerender();
      });
    });

    // 検索
    const searchBtn = document.getElementById('btnChatListSearch') as HTMLButtonElement;
    if (searchBtn && this.searchInput) {
      searchBtn.addEventListener('click', () => {
        this.searchInput.classList.add('show');
        this.searchInput.focus();
      });
      this.searchInput.addEventListener('input', () => {
        this.searchQuery = this.searchInput.value.toLowerCase();
        this.rerender();
      });
      this.searchInput.addEventListener('blur', () => {
        if (this.searchInput.value.trim() === '') {
          this.searchInput.classList.remove('show');
        }
      });
    }

    // 新規グループ作成 (選択モード)
    const btnNewGroup = document.getElementById('btnNewGroup') as HTMLButtonElement;
    const btnCancel = document.getElementById('btnSelectModeCancel') as HTMLButtonElement;

    btnNewGroup.addEventListener('click', () => {
      this.enterSelectMode();
    });
    btnCancel.addEventListener('click', () => {
      this.exitSelectMode();
    });
    this.btnSelectModeStart.addEventListener('click', () => {
      const ids = [...this.checkedIds];
      this.exitSelectMode();
      if (ids.length >= 2) {
        this.onCreateGroup(ids);
      }
    });
  }

  enterSelectMode(): void {
    this.selectMode = true;
    this.checkedIds.clear();
    document.body.classList.add('select-mode');
    this.updateSelectModeBar();
    this.rerender();
  }

  exitSelectMode(): void {
    this.selectMode = false;
    this.checkedIds.clear();
    document.body.classList.remove('select-mode');
    this.rerender();
  }

  private updateSelectModeBar(): void {
    this.selectModeCountEl.textContent = `${this.checkedIds.size}人を選択中`;
    this.btnSelectModeStart.disabled = this.checkedIds.size < 2;
  }

  private rerender(): void {
    this.render(
      this.lastMembers,
      this.lastGroups,
      this.lastSelectedUserIds,
      this.lastActiveChatId,
      this.lastPlayingUserId,
      this.lastPlayingGroupId
    );
  }

  /**
   * 統合リストの描画
   */
  render(
    members: MemberItem[],
    groups: GroupItem[],
    selectedUserIds: string[],
    activeChatHistoryId: string | null,
    playingUserId?: string,
    playingGroupId?: string
  ): void {
    this.lastMembers = members;
    this.lastGroups = groups;
    this.lastSelectedUserIds = selectedUserIds;
    this.lastActiveChatId = activeChatHistoryId;
    this.lastPlayingUserId = playingUserId;
    this.lastPlayingGroupId = playingGroupId;

    this.listEl.innerHTML = '';

    // 個別とグループを1つの配列に統合 (未読優先・新着順、それ以外は元の順序を維持)
    let entries: ListEntry[] = [
      ...members.map((m): ListEntry => ({
        type: 'user',
        id: m.id,
        unread: m.unreadCount || 0,
        latestUnreadTime: m.latestUnreadTime || 0,
        member: m
      })),
      ...groups.map((g): ListEntry => ({
        type: 'group',
        id: g.id,
        unread: g.unreadCount || 0,
        latestUnreadTime: g.latestUnreadTime || 0,
        group: g
      }))
    ];

    const originalIndex = new Map(entries.map((e, i) => [e.id, i]));
    entries.sort((a, b) => {
      if (a.unread > 0 && b.unread > 0) {
        return b.latestUnreadTime - a.latestUnreadTime;
      }
      if ((a.unread > 0) !== (b.unread > 0)) {
        return b.unread - a.unread;
      }
      return (originalIndex.get(a.id) || 0) - (originalIndex.get(b.id) || 0);
    });

    // フィルタと検索の適用 (選択モード中はメンバー全員を出す)
    if (!this.selectMode && this.filter !== 'all') {
      entries = entries.filter((e) => e.type === this.filter);
    }
    if (this.searchQuery) {
      entries = entries.filter((e) => {
        const name = e.type === 'user' ? e.member!.name : e.group!.name;
        return name.toLowerCase().includes(this.searchQuery);
      });
    }

    if (entries.length === 0) {
      this.listEl.innerHTML = '<div class="list-empty">メンバーやグループが見つかりません</div>';
      return;
    }

    entries.forEach((entry) => {
      if (entry.type === 'user') {
        this.listEl.appendChild(this.renderUserItem(entry.member!, selectedUserIds, activeChatHistoryId, playingUserId));
      } else {
        this.listEl.appendChild(this.renderGroupItem(entry.group!, activeChatHistoryId, playingGroupId));
      }
    });
  }

  private renderUserItem(
    member: MemberItem,
    selectedUserIds: string[],
    activeChatHistoryId: string | null,
    playingUserId?: string
  ): HTMLDivElement {
    // 個別チャットを開いている = 選択ユーザーが1人でそれが自分
    const isActive = !!activeChatHistoryId && selectedUserIds.length === 1 && selectedUserIds[0] === member.id;
    const isPlaying = playingUserId === member.id;
    const isChecked = this.checkedIds.has(member.id);

    const itemEl = document.createElement('div');
    itemEl.className = `list-item ${isActive ? 'active' : ''} ${isChecked ? 'checked' : ''}`;
    itemEl.dataset.type = 'user';
    itemEl.dataset.id = member.id;

    const displayName = `#${member.userNumber} ${member.name}`;
    const firstChar = member.name.charAt(0).toUpperCase();

    const subHtml = isPlaying
      ? `<div class="item-sub playing"><span class="wave"><span></span><span></span><span></span></span> 再生中</div>`
      : `<div class="item-sub">${member.isOnline ? 'オンライン' : 'オフライン'}</div>`;

    itemEl.innerHTML = `
      <span class="select-check">✓</span>
      <div class="item-avatar individual">${firstChar}${member.isOnline ? '<span class="online-dot"></span>' : ''}</div>
      <div class="item-body">
        <div class="item-name"><span class="item-name-text">${displayName}</span></div>
        ${subHtml}
      </div>
      <div class="item-meta">
        ${member.unreadCount ? `<span class="unread-badge">${member.unreadCount}</span>` : ''}
      </div>
      <button class="btn-item-delete" title="チャット履歴を削除">🗑️</button>
    `;

    itemEl.addEventListener('click', () => {
      if (this.selectMode) {
        if (this.checkedIds.has(member.id)) {
          this.checkedIds.delete(member.id);
          itemEl.classList.remove('checked');
        } else {
          this.checkedIds.add(member.id);
          itemEl.classList.add('checked');
        }
        this.updateSelectModeBar();
        return;
      }
      this.onOpenUser(member.id);
    });

    const deleteBtn = itemEl.querySelector('.btn-item-delete') as HTMLButtonElement;
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onUserChatClear(member.id, member.name);
    });

    return itemEl;
  }

  private renderGroupItem(
    group: GroupItem,
    activeChatHistoryId: string | null,
    playingGroupId?: string
  ): HTMLDivElement {
    const isActive = activeChatHistoryId === group.id;
    const isPlaying = playingGroupId === group.id;

    const itemEl = document.createElement('div');
    itemEl.className = `list-item ${isActive ? 'active' : ''}`;
    itemEl.dataset.type = 'group';
    itemEl.dataset.id = group.id;

    const subHtml = isPlaying
      ? `<div class="item-sub playing"><span class="wave"><span></span><span></span><span></span></span> 再生中</div>`
      : `<div class="item-sub">${group.customName ? group.memberNames : `${group.memberCount} 人のメンバー`}</div>`;

    itemEl.innerHTML = `
      <span class="select-check">✓</span>
      <div class="item-avatar group">👥</div>
      <div class="item-body">
        <div class="item-name"><span class="item-name-text">${group.name}</span><span class="item-member-count">(${group.memberCount})</span></div>
        ${subHtml}
      </div>
      <div class="item-meta">
        ${group.unreadCount ? `<span class="unread-badge">${group.unreadCount}</span>` : ''}
      </div>
      <button class="btn-item-delete" title="グループを削除">🗑️</button>
    `;

    itemEl.addEventListener('click', () => {
      if (this.selectMode) return; // 選択モード中はグループを操作不可
      this.onOpenGroup(group.id);
    });

    const deleteBtn = itemEl.querySelector('.btn-item-delete') as HTMLButtonElement;
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onGroupDelete(group.id, group.name);
    });

    return itemEl;
  }
}
