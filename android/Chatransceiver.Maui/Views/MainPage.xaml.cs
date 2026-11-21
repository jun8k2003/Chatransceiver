using System.Collections.ObjectModel;
using Chatransceiver.Maui.Models;
using Chatransceiver.Maui.Platforms.Android.Services;
using Chatransceiver.Maui.Services;

namespace Chatransceiver.Maui.Views;

public partial class MainPage : ContentPage
{
    private SupabaseUser? _currentUser;
    private SupabaseCommunity? _currentCommunity;

    private List<SupabaseMember> _members = new();
    private List<SupabaseGroup> _groups = new();
    private string _currentFilter = "all"; // "all" | "individual" | "group"
    private bool _isGroupSelectMode;
    private readonly HashSet<string> _selectedGroupMemberIds = new();

    private UnifiedListItem? _activeItem;
    private string? _activeRoomId;
    private string? _loadedRoomId;
    private bool _isAppActive;
    private readonly Task _sessionInitializationTask;
    private readonly SemaphoreSlim _unreadUpdateLock = new(1, 1);
    private RecordingResult? _stoppedRecordingResult;
    private int _busyDepth;

    public ObservableCollection<UnifiedListItem> VisibleItems { get; } = new();
    public ObservableCollection<SupabaseMessage> RoomMessages { get; } = new();

    private async Task RunWithBusyAsync(string message, Func<Task> action)
    {
        _busyDepth++;
        MainThread.BeginInvokeOnMainThread(() =>
        {
            BusyMessageLabel.Text = message;
            BusyIndicator.IsRunning = true;
            BusyOverlay.IsVisible = true;
        });

        try
        {
            await action();
        }
        finally
        {
            _busyDepth = Math.Max(0, _busyDepth - 1);
            if (_busyDepth == 0)
            {
                MainThread.BeginInvokeOnMainThread(() =>
                {
                    BusyIndicator.IsRunning = false;
                    BusyOverlay.IsVisible = false;
                });
            }
        }
    }

    public MainPage()
    {
        InitializeComponent();

        UnifiedCollectionView.ItemsSource = VisibleItems;
        MessagesCollectionView.ItemsSource = RoomMessages;

        SupabaseClientService.Instance.AuthStateChanged += OnAuthStateChanged;
        AudioPlaybackQueue.Instance.PlaybackStarted += OnAutoPlayStarted;
        AudioPlaybackQueue.Instance.PlaybackEnded += OnAutoPlayEnded;

        NativeRecordingService.Instance.CountdownTick += OnRecordingCountdownTick;
        NativeRecordingService.Instance.PartialTranscriptUpdated += OnRecordingPartialTranscript;
        NativeRecordingService.Instance.AutoTimeoutReached += OnForegroundRecordingTimeout;

        TransceiverForegroundService.ServiceStateChanged += OnForegroundServiceStateChanged;
        TransceiverForegroundService.PttMessageSentFromBackground += OnBackgroundPttMessageSent;
        TransceiverForegroundService.ForegroundUiStopRecordingRequested += OnForegroundUiStopRecordingRequested;

        RealtimeService.Instance.NewRoomMessageArrived += OnRealtimeRoomMessageArrived;
        RealtimeService.Instance.CommunityUnreadUpdated += OnRealtimeUnreadUpdated;

        _sessionInitializationTask = InitializeSessionAsync();
    }

    private async Task InitializeSessionAsync()
    {
        UpdateHeaderIconStates();

        await RunWithBusyAsync("セッションを確認中...", async () =>
        {
            var user = await SupabaseClientService.Instance.GetCurrentUserAsync();
            if (user != null)
            {
                await ApplyLoggedInUserAsync(user);
            }
            else if (SupabaseClientService.Instance.LastAuthFailureWasInvalidSession ||
                     string.IsNullOrEmpty(AppConfig.CurrentUserId))
            {
                LoginOverlay.IsVisible = true;
            }
            else
            {
                // オフライン等の一時的エラーではログイン画面へ落とさずトークンを保持する
                LoginOverlay.IsVisible = false;
                await DisplayAlert("接続待機中", "ネットワーク接続を確認できませんでした。オンライン復帰後に自動で再接続します。", "OK");
            }
        });
    }

    public async Task OnAppResumedAsync()
    {
        _isAppActive = true;
        try
        {
            await _sessionInitializationTask;
            if (_currentUser == null && !LoginOverlay.IsVisible)
            {
                await InitializeSessionAsync();
            }
            else if (_currentUser != null)
            {
                await SupabaseClientService.Instance.EnsureFreshSessionAsync();
            }
            await RefreshVisibleRoomAsync();
            await ReloadCommunityDataAsync();
        }
        catch
        {
            // 復帰時のバックグラウンド更新失敗は無視（次のAPI呼び出し時に401リトライされる）
        }
    }

    public void OnAppDeactivated() => _isAppActive = false;

    private void OnAuthStateChanged(SupabaseUser user)
    {
        MainThread.BeginInvokeOnMainThread(async () =>
        {
            await ApplyLoggedInUserAsync(user);
        });
    }

    private async Task ApplyLoggedInUserAsync(SupabaseUser user)
    {
        _currentUser = user;
        LoginOverlay.IsVisible = false;

        if (!string.IsNullOrEmpty(AppConfig.PendingFcmToken) && AppConfig.FcmRegistered)
        {
            _ = SupabaseClientService.Instance.RegisterFcmTokenAsync(AppConfig.PendingFcmToken);
        }

        var lastSlug = AppConfig.CurrentCommunitySlug;
        if (!string.IsNullOrEmpty(lastSlug))
        {
            try
            {
                await ConnectToCommunityInternalAsync(lastSlug, allowAutoJoin: false);
            }
            catch
            {
                // 接続失敗時は未接続状態のまま待機
            }
        }
    }

    private void UpdateHeaderIconStates()
    {
        FcmToggleButton.BorderColor = AppConfig.FcmRegistered ? Color.FromArgb("#3B82F6") : Colors.Transparent;
        FcmToggleButton.BorderWidth = AppConfig.FcmRegistered ? 2 : 0;

        HeadsetPttButton.BorderColor = TransceiverForegroundService.IsRunning ? Color.FromArgb("#F97316") : Colors.Transparent;
        HeadsetPttButton.BorderWidth = TransceiverForegroundService.IsRunning ? 2 : 0;
    }

    // ==================== ログイン処理 ====================

    private async void OnGoogleLoginClicked(object? sender, EventArgs e)
    {
        try
        {
            await RunWithBusyAsync("Googleログイン処理中...", async () =>
            {
                await SupabaseClientService.Instance.SignInWithGoogleAsync();
            });
        }
        catch (Exception ex)
        {
            await DisplayAlert("Googleログインエラー", ex.Message, "OK");
        }
    }

    private async void OnMagicLinkLoginClicked(object? sender, EventArgs e)
    {
        var email = MagicLinkEmailEntry.Text?.Trim();
        if (string.IsNullOrEmpty(email))
        {
            await DisplayAlert("入力確認", "メールアドレスを入力してください。", "OK");
            return;
        }

        try
        {
            await RunWithBusyAsync("ログインリンクを送信中...", async () =>
            {
                await SupabaseClientService.Instance.SignInWithMagicLinkAsync(email);
            });
            await DisplayAlert(
                "送信完了",
                $"ログイン用リンクを {email} 宛に送信しました。メール内のリンクをタップするとこのアプリに戻ってログインが完了します。",
                "OK");
        }
        catch (Exception ex)
        {
            await DisplayAlert("Magic Link送信エラー", ex.Message, "OK");
        }
    }

    // ==================== コミュニティ接続・管理 ====================

    private void OnCommunityPillClicked(object? sender, EventArgs e)
    {
        CommunityHistoryView.ItemsSource = AppConfig.GetCommunityHistory();
        CommunityMenuOverlay.IsVisible = true;
    }

    private void OnCloseCommunityMenuClicked(object? sender, EventArgs e)
    {
        CommunityMenuOverlay.IsVisible = false;
    }

    private async void OnConnectCommunityClicked(object? sender, EventArgs e)
    {
        var input = CommunityInputEntry.Text?.Trim();
        if (string.IsNullOrEmpty(input)) return;
        await ConnectToCommunityInternalAsync(input);
        CommunityMenuOverlay.IsVisible = false;
    }

    private async void OnHistoryCommunitySelected(object? sender, EventArgs e)
    {
        if (sender is Button btn && btn.CommandParameter is string slug)
        {
            await ConnectToCommunityInternalAsync(slug);
            CommunityMenuOverlay.IsVisible = false;
        }
    }

    private async Task ConnectToCommunityInternalAsync(string slugOrInviteUrl, bool allowAutoJoin = true)
    {
        if (_currentUser == null) return;

        try
        {
            await RunWithBusyAsync("コミュニティに接続中...", async () =>
            {
                var community = await SupabaseClientService.Instance.ConnectCommunityAsync(_currentUser.Id, slugOrInviteUrl, allowAutoJoin);
                if (community == null)
                {
                    // 自動復元時に他端末で退会済みだった場合は再参加せず未接続状態へ戻す
                    var parsedSlug = SupabaseClientService.ParseCommunitySlugFromInput(slugOrInviteUrl);
                    if (!string.IsNullOrEmpty(parsedSlug))
                    {
                        AppConfig.RemoveCommunityHistory(parsedSlug);
                    }
                    DisconnectCommunityNonDestructive();
                    return;
                }

                _currentCommunity = community;
                CommunityPillButton.Text = $"🌐 {community.Name} ▾";

                await ReloadCommunityDataAsync();

                if (_currentCommunity == null) return;

                RealtimeService.Instance.StartForegroundSync(
                    _currentUser.Id,
                    community.Id,
                    _activeRoomId,
                    RoomMessages.Select(m => m.Id));
            });
        }
        catch (Exception ex)
        {
            await DisplayAlert("コミュニティ接続エラー", ex.Message, "OK");
        }
    }

    private async Task ReloadCommunityDataAsync()
    {
        await _unreadUpdateLock.WaitAsync();
        try
        {
            await ReloadCommunityDataCoreAsync();
        }
        finally
        {
            _unreadUpdateLock.Release();
        }
    }

    private async Task ReloadCommunityDataCoreAsync()
    {
        if (_currentUser == null || _currentCommunity == null) return;
        var userId = _currentUser.Id;
        var communityId = _currentCommunity.Id;
        var communitySlug = _currentCommunity.Slug;

        var membersTask = SupabaseClientService.Instance.GetCommunityMembersWithStatusAsync(_currentCommunity.Id, _currentUser.Id);
        var unreadTask = SupabaseClientService.Instance.GetUnreadIndividualCountsAsync(_currentUser.Id, _currentCommunity.Id);
        var groupsTask = SupabaseClientService.Instance.GetCommunityGroupsAsync(_currentCommunity.Id, _currentUser.Id);

        await Task.WhenAll(membersTask, unreadTask, groupsTask);
        if (_currentUser?.Id != userId || _currentCommunity?.Id != communityId) return;

        var (members, isCurrentUserMember) = membersTask.Result;
        if (!isCurrentUserMember)
        {
            // 他端末（Web等）から退会済みのためローカルも切断する
            AppConfig.RemoveCommunityHistory(communitySlug);
            DisconnectCommunityNonDestructive();
            return;
        }

        _members = members;
        var unreadMap = unreadTask.Result;
        foreach (var m in _members)
        {
            if (unreadMap.TryGetValue(m.Id, out var u))
            {
                m.UnreadCount = u.Count;
                m.LatestUnreadTime = u.LatestTime;
            }
        }

        _groups = groupsTask.Result;
        _selectedGroupMemberIds.IntersectWith(_members.Select(m => m.Id));
        RebuildUnifiedList();
    }

    private void RebuildUnifiedList()
    {
        bool showUnreadBadge = AppConfig.UnreadBadgeEnabled;
        var desired = new List<UnifiedListItem>();

        if (!_isGroupSelectMode && (_currentFilter == "all" || _currentFilter == "group"))
        {
            foreach (var g in _groups)
            {
                desired.Add(new UnifiedListItem
                {
                    Id = g.Id,
                    IsGroup = true,
                    DisplayTitle = $"👥 {g.Name}",
                    Subtitle = $"メンバー ({g.MemberCount}人): {g.MemberNames}",
                    UnreadCount = g.UnreadCount,
                    ShowUnreadBadge = showUnreadBadge,
                    IsActiveRoom = _activeRoomId == g.Id,
                    IsGroupSelectMode = false,
                    IsSelectedForGroup = false
                });
            }
        }

        if (_isGroupSelectMode || _currentFilter == "all" || _currentFilter == "individual")
        {
            foreach (var m in _members)
            {
                desired.Add(new UnifiedListItem
                {
                    Id = m.Id,
                    IsGroup = false,
                    DisplayTitle = $"#{m.UserNumber} {m.Name}",
                    Subtitle = "個別チャット",
                    IsOnline = m.IsOnline,
                    UnreadCount = m.UnreadCount,
                    ShowUnreadBadge = showUnreadBadge,
                    IsActiveRoom = _activeItem != null && !_activeItem.IsGroup && _activeItem.Id == m.Id,
                    IsGroupSelectMode = _isGroupSelectMode,
                    IsSelectedForGroup = _isGroupSelectMode && _selectedGroupMemberIds.Contains(m.Id)
                });
            }
        }

        // 構成（順序・ID・種別）が一致していればクリアせずインプレース更新して選択状態やスクロール位置を維持する
        bool sameStructure = VisibleItems.Count == desired.Count;
        if (sameStructure)
        {
            for (int i = 0; i < desired.Count; i++)
            {
                if (VisibleItems[i].Id != desired[i].Id || VisibleItems[i].IsGroup != desired[i].IsGroup)
                {
                    sameStructure = false;
                    break;
                }
            }
        }

        if (sameStructure)
        {
            for (int i = 0; i < desired.Count; i++)
            {
                var existing = VisibleItems[i];
                var next = desired[i];
                existing.DisplayTitle = next.DisplayTitle;
                existing.Subtitle = next.Subtitle;
                existing.IsOnline = next.IsOnline;
                existing.UnreadCount = next.UnreadCount;
                existing.ShowUnreadBadge = next.ShowUnreadBadge;
                existing.IsActiveRoom = next.IsActiveRoom;
                existing.IsGroupSelectMode = next.IsGroupSelectMode;
                existing.IsSelectedForGroup = next.IsSelectedForGroup;
            }
        }
        else
        {
            VisibleItems.Clear();
            foreach (var item in desired)
            {
                VisibleItems.Add(item);
            }
        }

        UpdateGroupSelectBar();
    }

    private void UpdateGroupSelectBar()
    {
        if (!_isGroupSelectMode) return;
        int count = _selectedGroupMemberIds.Count;
        GroupSelectCountLabel.Text = count > 0
            ? $"メンバー(2人以上)をタップして選択 ({count}人選択中)"
            : "メンバー(2人以上)をタップして選択";
        GroupCreateConfirmBtn.IsEnabled = count >= 2;
        GroupCreateConfirmBtn.Opacity = count >= 2 ? 1.0 : 0.5;
    }

    private async void OnCopyInviteLinkClicked(object? sender, EventArgs e)
    {
        if (_currentCommunity == null) return;
        var inviteUrl = $"https://chatransceiver13162.web.app/?c={Uri.EscapeDataString(_currentCommunity.Slug)}&code=code_{Uri.EscapeDataString(_currentCommunity.Slug)}";
        await Clipboard.Default.SetTextAsync(inviteUrl);
        await DisplayAlert("コピー完了", $"招待リンクをクリップボードにコピーしました:\n{inviteUrl}", "OK");
    }

    private void OnDisconnectCommunityClicked(object? sender, EventArgs e)
    {
        DisconnectCommunityNonDestructive();
        CommunityMenuOverlay.IsVisible = false;
    }

    private void DisconnectCommunityNonDestructive()
    {
        RealtimeService.Instance.StopForegroundSync();
        _currentCommunity = null;
        _activeRoomId = null;
        _loadedRoomId = null;
        _activeItem = null;
        AppConfig.CurrentCommunitySlug = null;
        AppConfig.ActiveRoomId = null;
        AppConfig.ActiveRoomTitle = null;
        _members.Clear();
        _groups.Clear();
        _isGroupSelectMode = false;
        _selectedGroupMemberIds.Clear();
        GroupCreateConfirmBar.IsVisible = false;
        VisibleItems.Clear();
        RoomMessages.Clear();
        CommunityPillButton.Text = "🌐 未接続 (タップで接続)";
        ChatHeaderTitleLabel.Text = "チャット未選択";
        ChatHeaderSubtitleLabel.Text = "一覧から送信先を選択してください";
        EditGroupNameButton.IsVisible = false;
        ClearRoomButton.IsVisible = false;
    }

    private async void OnLeaveCommunityClicked(object? sender, EventArgs e)
    {
        if (_currentUser == null || _currentCommunity == null) return;

        bool confirm = await DisplayAlert(
            "コミュニティ退会の確認",
            $"本当に「{_currentCommunity.Name}」を退出しますか？\n自分が含まれていた全チャットルームおよび過去の発言履歴・音声データが完全に削除されます。",
            "退会して全削除",
            "キャンセル");
        if (!confirm) return;

        try
        {
            await RunWithBusyAsync("コミュニティ退会処理中...", async () =>
            {
                var slug = _currentCommunity.Slug;
                await SupabaseClientService.Instance.LeaveCommunityAsync(_currentUser.Id, _currentCommunity.Id);
                AppConfig.RemoveCommunityHistory(slug);
                DisconnectCommunityNonDestructive();
                CommunityMenuOverlay.IsVisible = false;
            });
        }
        catch (Exception ex)
        {
            await DisplayAlert("退会エラー", ex.Message, "OK");
        }
    }

    // ==================== フィルタチップ・グループ作成・ルーム選択 ====================

    private void OnFilterAllClicked(object? sender, EventArgs e) => SetFilter("all");
    private void OnFilterIndividualClicked(object? sender, EventArgs e) => SetFilter("individual");
    private void OnFilterGroupClicked(object? sender, EventArgs e) => SetFilter("group");

    private static readonly Color ActiveBlueColor = Color.FromArgb("#3B82F6");
    private static readonly Color DarkInactiveBgColor = Color.FromArgb("#334155");
    private static readonly Color LightInactiveBgColor = Color.FromArgb("#E2E8F0");
    private static readonly Color DarkTextColor = Color.FromArgb("#F8FAFC");
    private static readonly Color LightTextColor = Color.FromArgb("#0F172A");

    private static void ApplyToggleButtonTheme(Button button, bool isActive)
    {
        if (isActive)
        {
            button.BackgroundColor = ActiveBlueColor;
            button.TextColor = Colors.White;
        }
        else
        {
            button.SetAppThemeColor(Button.BackgroundColorProperty, light: LightInactiveBgColor, dark: DarkInactiveBgColor);
            button.SetAppThemeColor(Button.TextColorProperty, light: LightTextColor, dark: DarkTextColor);
        }
    }

    private void SetFilter(string filter)
    {
        _currentFilter = filter;
        ApplyToggleButtonTheme(FilterAllBtn, filter == "all");
        ApplyToggleButtonTheme(FilterIndividualBtn, filter == "individual");
        ApplyToggleButtonTheme(FilterGroupBtn, filter == "group");
        RebuildUnifiedList();
    }

    private void OnToggleGroupSelectModeClicked(object? sender, EventArgs e)
    {
        _isGroupSelectMode = !_isGroupSelectMode;
        _selectedGroupMemberIds.Clear();
        GroupCreateConfirmBar.IsVisible = _isGroupSelectMode;
        if (_isGroupSelectMode)
        {
            SetFilter("individual");
        }
        else
        {
            SetFilter("all");
        }
    }

    private async void OnConfirmCreateGroupClicked(object? sender, EventArgs e)
    {
        if (_currentUser == null || _currentCommunity == null) return;

        var activeMemberIds = _members.Select(m => m.Id).ToHashSet();
        var selectedIds = _selectedGroupMemberIds
            .Where(activeMemberIds.Contains)
            .ToList();

        if (selectedIds.Count < 2)
        {
            await DisplayAlert("選択不足", "グループを作成するには2人以上のメンバーを選択してください。", "OK");
            return;
        }

        try
        {
            await RunWithBusyAsync("グループを作成中...", async () =>
            {
                var roomId = await SupabaseClientService.Instance.CreateGroupRoomAsync(_currentCommunity.Id, _currentUser.Id, selectedIds);
                _isGroupSelectMode = false;
                _selectedGroupMemberIds.Clear();
                GroupCreateConfirmBar.IsVisible = false;
                SetFilter("all");
                await ReloadCommunityDataAsync();

                var createdGroup = VisibleItems.FirstOrDefault(i => i.IsGroup && i.Id == roomId);
                if (createdGroup != null)
                {
                    await OpenUnifiedItemChatAsync(createdGroup);
                }
            });
        }
        catch (Exception ex)
        {
            await DisplayAlert("グループ作成エラー", ex.Message, "OK");
        }
    }

    private async void OnUnifiedItemTapped(object? sender, TappedEventArgs e)
    {
        if (e.Parameter is not UnifiedListItem item) return;

        if (_isGroupSelectMode)
        {
            if (item.IsGroup) return;

            if (_selectedGroupMemberIds.Contains(item.Id))
            {
                _selectedGroupMemberIds.Remove(item.Id);
                item.IsSelectedForGroup = false;
            }
            else
            {
                _selectedGroupMemberIds.Add(item.Id);
                item.IsSelectedForGroup = true;
            }
            UpdateGroupSelectBar();
            return;
        }

        await OpenUnifiedItemChatAsync(item);
    }

    private async Task OpenUnifiedItemChatAsync(UnifiedListItem item)
    {
        if (_currentUser == null || _currentCommunity == null) return;

        try
        {
            await RunWithBusyAsync("チャット履歴を読み込み中...", async () =>
            {
                _activeItem = item;
                _loadedRoomId = null;
                string roomId;
                if (item.IsGroup)
                {
                    roomId = item.Id;
                }
                else
                {
                    roomId = await SupabaseClientService.Instance.GetOrCreateIndividualRoomAsync(
                        _currentCommunity.Id,
                        _currentUser.Id,
                        item.Id);
                }

                _activeRoomId = roomId;
                AppConfig.ActiveRoomId = roomId;
                AppConfig.ActiveRoomTitle = item.DisplayTitle;

                ChatHeaderTitleLabel.Text = item.DisplayTitle;
                ChatHeaderSubtitleLabel.Text = item.Subtitle;
                EditGroupNameButton.IsVisible = item.IsGroup;
                ClearRoomButton.IsVisible = true;

                var msgs = await SupabaseClientService.Instance.GetRoomMessagesAsync(roomId, _currentUser.Id);
                RoomMessages.Clear();
                foreach (var m in msgs) RoomMessages.Add(m);
                _loadedRoomId = roomId;

                RealtimeService.Instance.UpdateActiveRoom(roomId, msgs.Select(m => m.Id));
                ShowPane(showChat: true);
                await MarkVisibleRoomAsReadAsync();
                await ReloadCommunityDataAsync();
            });
        }
        catch (Exception ex)
        {
            await DisplayAlert("チャット表示エラー", ex.Message, "OK");
        }
    }

    private void OnShowListPaneClicked(object? sender, EventArgs e) => ShowPane(showChat: false);
    private async void OnShowChatPaneClicked(object? sender, EventArgs e)
    {
        ShowPane(showChat: true);
        await RefreshVisibleRoomAsync();
    }

    private bool IsRoomVisible(string? roomId, string? userId) =>
        _isAppActive && ChatPaneGrid.IsVisible && Navigation.ModalStack.Count == 0 &&
        !string.IsNullOrEmpty(roomId) && _activeRoomId == roomId && _loadedRoomId == roomId &&
        !string.IsNullOrEmpty(userId) && _currentUser?.Id == userId && _currentCommunity != null;

    private async Task RefreshVisibleRoomAsync()
    {
        var roomId = _activeRoomId;
        var userId = _currentUser?.Id;
        if (!IsRoomVisible(roomId, userId)) return;

        try
        {
            var msgs = await SupabaseClientService.Instance.GetRoomMessagesAsync(roomId!, userId!);
            if (!IsRoomVisible(roomId, userId)) return;
            RoomMessages.Clear();
            foreach (var msg in msgs) RoomMessages.Add(msg);
            RealtimeService.Instance.UpdateActiveRoom(roomId, msgs.Select(m => m.Id));
            ScrollMessagesToBottom();
            await MarkVisibleRoomAsReadAsync();
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"RefreshVisibleRoomAsync error: {ex.Message}");
        }
    }

    private async Task MarkVisibleRoomAsReadAsync()
    {
        // 一覧の再取得と直列化し、既読化前の集計でバッジが復活するのを防ぐ。
        await _unreadUpdateLock.WaitAsync();
        try
        {
            var roomId = _activeRoomId;
            var userId = _currentUser?.Id;
            var communityId = _currentCommunity?.Id;
            var item = _activeItem;
            if (item == null || !IsRoomVisible(roomId, userId)) return;

            await SupabaseClientService.Instance.MarkAsReadAsync(roomId!, userId!);
            if (_currentUser?.Id != userId || _currentCommunity?.Id != communityId) return;

            if (item.IsGroup)
            {
                var group = _groups.FirstOrDefault(g => g.Id == item.Id);
                if (group != null)
                {
                    group.UnreadCount = 0;
                    group.LatestUnreadTime = 0;
                }
            }
            else
            {
                var member = _members.FirstOrDefault(m => m.Id == item.Id);
                if (member != null)
                {
                    member.UnreadCount = 0;
                    member.LatestUnreadTime = 0;
                }
            }
            item.UnreadCount = 0;
            foreach (var row in VisibleItems.Where(i => i.Id == item.Id && i.IsGroup == item.IsGroup))
                row.UnreadCount = 0;
        }
        catch (Exception ex)
        {
            // 失敗時は未読を残し、次の同期周期で再試行する。
            System.Diagnostics.Debug.WriteLine($"MarkVisibleRoomAsReadAsync error: {ex.Message}");
        }
        finally
        {
            _unreadUpdateLock.Release();
        }
    }

    private void ShowPane(bool showChat)
    {
        ListPaneGrid.IsVisible = !showChat;
        ChatPaneGrid.IsVisible = showChat;
        ApplyToggleButtonTheme(TabListButton, !showChat);
        ApplyToggleButtonTheme(TabChatButton, showChat);

        if (showChat)
        {
            ScrollMessagesToBottom(animate: false);
        }
    }

    private void ScrollMessagesToBottom(bool animate = false)
    {
        if (RoomMessages.Count == 0) return;

        MainThread.BeginInvokeOnMainThread(async () =>
        {
            // CollectionView の表示切替・レイアウト確定を待ってから最下部へスクロール
            await Task.Delay(60);
            if (RoomMessages.Count > 0 && ChatPaneGrid.IsVisible)
            {
                MessagesCollectionView.ScrollTo(RoomMessages.Count - 1, position: ScrollToPosition.End, animate: animate);
            }
        });
    }

    // ==================== グループ名編集 & ルーム履歴削除 ====================

    private async void OnEditGroupNameClicked(object? sender, EventArgs e)
    {
        if (_activeItem == null || !_activeItem.IsGroup || string.IsNullOrEmpty(_activeRoomId)) return;

        string? result = await DisplayPromptAsync(
            "グループ名の編集 (DEC-023)",
            "新しいグループ名（あだ名）を入力してください（空欄にするとメンバー名一覧に戻ります）:",
            "保存",
            "キャンセル",
            initialValue: _groups.FirstOrDefault(g => g.Id == _activeRoomId)?.CustomName ?? "");

        if (result == null) return;

        try
        {
            await RunWithBusyAsync("グループ名を更新中...", async () =>
            {
                await SupabaseClientService.Instance.UpdateRoomNameAsync(_activeRoomId, result);
                await ReloadCommunityDataAsync();
                var updated = _groups.FirstOrDefault(g => g.Id == _activeRoomId);
                if (updated != null)
                {
                    ChatHeaderTitleLabel.Text = $"👥 {updated.Name}";
                    AppConfig.ActiveRoomTitle = ChatHeaderTitleLabel.Text;
                }
            });
        }
        catch (Exception ex)
        {
            await DisplayAlert("グループ名更新エラー", ex.Message, "OK");
        }
    }

    private async void OnClearRoomClicked(object? sender, EventArgs e)
    {
        if (string.IsNullOrEmpty(_activeRoomId) || _activeItem == null) return;

        bool confirm = await DisplayAlert(
            "削除確認",
            _activeItem.IsGroup
                ? "このグループチャットとすべての履歴を削除しますか？"
                : "このチャットの発言履歴をすべて削除しますか？",
            "削除する",
            "キャンセル");
        if (!confirm) return;

        try
        {
            await RunWithBusyAsync("履歴を削除中...", async () =>
            {
                if (_activeItem.IsGroup)
                {
                    await SupabaseClientService.Instance.DeleteGroupAsync(_activeRoomId);
                    _activeRoomId = null;
                    _activeItem = null;
                    RoomMessages.Clear();
                    await ReloadCommunityDataAsync();
                    ShowPane(showChat: false);
                }
                else
                {
                    await SupabaseClientService.Instance.DeleteMessagesAsync(_activeRoomId);
                    RoomMessages.Clear();
                }
            });
        }
        catch (Exception ex)
        {
            await DisplayAlert("削除エラー", ex.Message, "OK");
        }
    }

    // ==================== 音声PTT録音 (Web版 recordingModal 準拠) & テキスト送信 ====================

    private async void OnPttMainButtonClicked(object? sender, EventArgs e)
    {
        if (_currentUser == null || string.IsNullOrEmpty(_activeRoomId))
        {
            NativeAudioService.Instance.BeepError();
            await DisplayAlert("送信先未選択", "先に一覧から送信先のメンバーまたはグループを選択してください。", "OK");
            return;
        }

        if (NativeRecordingService.Instance.IsRecording || NativeRecordingService.Instance.IsStarting) return;

        _stoppedRecordingResult = null;
        AudioPlaybackQueue.Instance.Pause();

        RecordingStatusTitleLabel.Text = "🎤 マイク接続準備中... 開始音の後に話してください";
        RecordingTimerLabel.Text = "--:--";
        RecordingProgressBar.Progress = 1.0;
        TranscriptPreviewLabel.Text = "（発話するとここに文字起こしが表示されます）";
        ModalStopBtn.IsEnabled = false;
        ModalStopBtn.Text = "⏹️ 停止して確認";
        ModalSendBtn.IsEnabled = false;
        RecordingModalOverlay.IsVisible = true;

        bool ok = await NativeRecordingService.Instance.StartRecordingAsync();
        if (ok)
        {
            RecordingStatusTitleLabel.Text = "🔴 音声録音中...";
            ModalStopBtn.IsEnabled = true;
            ModalSendBtn.IsEnabled = true;
        }
        else if (RecordingModalOverlay.IsVisible)
        {
            ResetRecordingUi();
            AudioPlaybackQueue.Instance.Resume();
            await DisplayAlert("マイクエラー", "録音を開始できませんでした。マイクの接続と権限を確認してください。", "OK");
        }
    }

    private async void OnModalStopRecordingClicked(object? sender, EventArgs e)
    {
        if (!NativeRecordingService.Instance.IsRecording) return;

        ModalStopBtn.IsEnabled = false;
        _stoppedRecordingResult = await NativeRecordingService.Instance.StopRecordingAsync();

        RecordingStatusTitleLabel.Text = "⏸️ 録音完了（送信待ち）";
        TranscriptPreviewLabel.Text = _stoppedRecordingResult.Transcript;
        ModalStopBtn.Text = "停止済み";
    }

    private async void OnModalSendRecordingClicked(object? sender, EventArgs e)
    {
        await FinishForegroundRecordingAndSendAsync();
    }

    private async Task<bool> OnForegroundUiStopRecordingRequested()
    {
        if (!RecordingModalOverlay.IsVisible || !NativeRecordingService.Instance.IsRecording)
        {
            return false;
        }
        await FinishForegroundRecordingAndSendAsync();
        return true;
    }

    private async void OnForegroundRecordingTimeout()
    {
        if (TransceiverForegroundService.IsRunning) return; // サービス側で処理される場合はスキップ
        if (NativeRecordingService.Instance.IsRecording)
        {
            // 15秒経過時は録音を止めて確認状態にする（または送信ボタンを押せるようにする）
            ModalStopBtn.IsEnabled = false;
            _stoppedRecordingResult = await NativeRecordingService.Instance.StopRecordingAsync();
            RecordingStatusTitleLabel.Text = "⏹️ 15秒録音完了（送信ボタンを押してください）";
            RecordingTimerLabel.Text = "00:00";
            RecordingProgressBar.Progress = 0.0;
            TranscriptPreviewLabel.Text = _stoppedRecordingResult.Transcript;
            ModalStopBtn.Text = "停止済み";
        }
    }

    private async Task FinishForegroundRecordingAndSendAsync()
    {
        if (_currentUser == null || string.IsNullOrEmpty(_activeRoomId)) return;

        try
        {
            ModalSendBtn.IsEnabled = false;
            ModalStopBtn.IsEnabled = false;

            RecordingResult result;
            if (NativeRecordingService.Instance.IsRecording)
            {
                result = await NativeRecordingService.Instance.StopRecordingAsync();
            }
            else if (_stoppedRecordingResult != null)
            {
                result = _stoppedRecordingResult;
            }
            else
            {
                return;
            }

            if (result.WavBytes != null || !string.IsNullOrWhiteSpace(result.Transcript))
            {
                await RunWithBusyAsync("音声メッセージを送信中...", async () =>
                {
                    var sent = await SupabaseClientService.Instance.SendMessageAsync(
                        _activeRoomId,
                        _currentUser.Id,
                        result.Transcript,
                        result.WavBytes,
                        result.NeedsTranscription);
                    RoomMessages.Add(sent);
                    ScrollMessagesToBottom(animate: true);
                    if (AppConfig.EchoSentEnabled)
                    {
                        AudioPlaybackQueue.Instance.EnqueueMessage(sent);
                    }
                });
            }
            else
            {
                await DisplayAlert("録音エラー", "録音データを取得できなかったため送信しませんでした。", "OK");
            }
        }
        catch (Exception ex)
        {
            NativeAudioService.Instance.BeepError();
            await DisplayAlert("送信エラー", ex.Message, "OK");
        }
        finally
        {
            _stoppedRecordingResult = null;
            ResetRecordingUi();
            AudioPlaybackQueue.Instance.Resume();
        }
    }

    private async void OnCancelRecordingClicked(object? sender, EventArgs e)
    {
        RecordingModalOverlay.IsVisible = false;
        if (NativeRecordingService.Instance.IsRecording || NativeRecordingService.Instance.IsStarting)
        {
            await NativeRecordingService.Instance.CancelRecordingAsync();
        }
        _stoppedRecordingResult = null;
        ResetRecordingUi();
        AudioPlaybackQueue.Instance.Resume();
    }

    private void ResetRecordingUi()
    {
        RecordingModalOverlay.IsVisible = false;
        ModalSendBtn.IsEnabled = true;
        ModalStopBtn.IsEnabled = true;
    }

    private void OnRecordingCountdownTick(int remainingSeconds)
    {
        RecordingTimerLabel.Text = $"00:{remainingSeconds:D2}";
        RecordingProgressBar.Progress = Math.Clamp(remainingSeconds / 15.0, 0.0, 1.0);
    }

    private void OnRecordingPartialTranscript(string partial)
    {
        MainThread.BeginInvokeOnMainThread(() =>
        {
            TranscriptPreviewLabel.Text = partial;
        });
    }

    private async void OnSendTextClicked(object? sender, EventArgs e)
    {
        var text = TextMessageEntry.Text?.Trim();
        if (string.IsNullOrEmpty(text)) return;

        if (_currentUser == null || string.IsNullOrEmpty(_activeRoomId))
        {
            await DisplayAlert("送信先未選択", "先に一覧から送信先を選択してください。", "OK");
            return;
        }

        try
        {
            TextMessageEntry.Text = string.Empty;
            SupabaseMessage? sent = null;
            await RunWithBusyAsync("メッセージを送信中...", async () =>
            {
                sent = await SupabaseClientService.Instance.SendMessageAsync(_activeRoomId, _currentUser.Id, text);
                RoomMessages.Add(sent);
                ScrollMessagesToBottom(animate: true);
            });
            if (sent != null && AppConfig.EchoSentEnabled)
            {
                AudioPlaybackQueue.Instance.EnqueueMessage(sent);
            }
        }
        catch (Exception ex)
        {
            await DisplayAlert("テキスト送信エラー", ex.Message, "OK");
        }
    }

    // ==================== バブル再生 & 発言取り消し ====================

    private async void OnPlayMessageBubbleClicked(object? sender, EventArgs e)
    {
        if (sender is not Button btn || btn.CommandParameter is not SupabaseMessage msg) return;

        var originalText = btn.Text;
        btn.IsEnabled = false;
        btn.Text = "⏳ 再生中...";

        try
        {
            var isAudio = msg.HasAudio && !string.IsNullOrEmpty(msg.AudioUrl);
            var content = isAudio ? msg.AudioUrl! : msg.TextContent;
            await NativeAudioService.Instance.PlayMessageAsync(
                isAudio: isAudio,
                content: content,
                callSignEnabled: AppConfig.CallSignEnabled);
        }
        catch (Exception ex)
        {
            await DisplayAlert("再生エラー", ex.Message, "OK");
        }
        finally
        {
            btn.Text = originalText;
            btn.IsEnabled = true;
        }
    }

    private async void OnRevokeMessageClicked(object? sender, EventArgs e)
    {
        if (_currentUser == null) return;
        if (sender is not Button btn || btn.CommandParameter is not SupabaseMessage msg) return;

        bool confirm = await DisplayAlert("発言の取り消し", "この発言を取り消しますか？", "OK", "キャンセル");
        if (!confirm) return;

        try
        {
            await RunWithBusyAsync("発言を取り消し中...", async () =>
            {
                await SupabaseClientService.Instance.RevokeMessageAsync(msg.Id, _currentUser.Id);
                msg.IsRevoked = true;
                msg.AudioUrl = null;
                msg.TextContent = string.Empty;
                msg.NotifyChanged();
            });
        }
        catch (Exception ex)
        {
            await DisplayAlert("取り消しエラー", ex.Message, "OK");
        }
    }

    // ==================== ヘッダーアイコン (🔔 FCM / 🎧 イヤフォンPTT / ⚙️ 設定) ====================

    private async void OnFcmToggleClicked(object? sender, EventArgs e)
    {
        if (_currentUser == null) return;

        if (AppConfig.FcmRegistered)
        {
            bool confirm = await DisplayAlert("プッシュ通知の解除", "この端末でのプッシュ通知をOFFにしますか？", "OFFにする", "キャンセル");
            if (!confirm) return;

            await RunWithBusyAsync("プッシュ通知を解除中...", async () =>
            {
                await SupabaseClientService.Instance.UnregisterFcmTokenAsync();
                UpdateHeaderIconStates();
            });
        }
        else
        {
            bool ok = false;
            bool missingToken = false;

            await RunWithBusyAsync("プッシュ通知を登録中...", async () =>
            {
                var token = AppConfig.PendingFcmToken;
                if (string.IsNullOrEmpty(token))
                {
                    try
                    {
                        var task = Firebase.Messaging.FirebaseMessaging.Instance.GetToken();
                        await System.Threading.Tasks.Task.Delay(600);
                        if (task.IsSuccessful && task.Result != null)
                        {
                            token = task.Result.ToString();
                            AppConfig.PendingFcmToken = token;
                        }
                    }
                    catch
                    {
                        // google-services.json 未設定環境等
                    }
                }

                if (string.IsNullOrEmpty(token))
                {
                    missingToken = true;
                    return;
                }

                ok = await SupabaseClientService.Instance.RegisterFcmTokenAsync(token);
                UpdateHeaderIconStates();
            });

            if (missingToken)
            {
                await DisplayAlert(
                    "FCMトークン未取得",
                    "Firebase (google-services.json) が構成されていないか、Google Play開発者サービスからトークンを取得できませんでした。",
                    "OK");
                return;
            }

            if (ok)
            {
                await DisplayAlert("通知ON", "プッシュ通知および画面ロック中の着信自動再生を有効にしました。", "OK");
            }
        }
    }

    private void OnHeadsetPttToggleClicked(object? sender, EventArgs e)
    {
        var ctx = global::Android.App.Application.Context;
        if (TransceiverForegroundService.IsRunning)
        {
            TransceiverForegroundService.Stop(ctx);
        }
        else
        {
            TransceiverForegroundService.Start(ctx);
        }
        UpdateHeaderIconStates();
    }

    private void OnForegroundServiceStateChanged(bool running)
    {
        MainThread.BeginInvokeOnMainThread(UpdateHeaderIconStates);
    }

    private void OnBackgroundPttMessageSent()
    {
        MainThread.BeginInvokeOnMainThread(async () =>
        {
            if (_currentUser != null && !string.IsNullOrEmpty(_activeRoomId))
            {
                var msgs = await SupabaseClientService.Instance.GetRoomMessagesAsync(_activeRoomId, _currentUser.Id);
                RoomMessages.Clear();
                foreach (var m in msgs) RoomMessages.Add(m);
                ScrollMessagesToBottom(animate: false);
            }
        });
    }

    private async void OnSettingsClicked(object? sender, EventArgs e)
    {
        var modal = new SettingsModalPage(
            _currentUser,
            onSettingsSaved: async () =>
            {
                if (_currentUser != null && _currentCommunity != null)
                {
                    await ReloadCommunityDataAsync();
                }
            },
            onSignOutRequested: async () =>
            {
                // DEC-031: ログアウト時は signOut の前に FCM トークンを解除し、非破壊切断を行う
                if (AppConfig.FcmRegistered)
                {
                    await SupabaseClientService.Instance.UnregisterFcmTokenAsync();
                }
                if (TransceiverForegroundService.IsRunning)
                {
                    TransceiverForegroundService.Stop(global::Android.App.Application.Context);
                }
                DisconnectCommunityNonDestructive();
                await SupabaseClientService.Instance.SignOutAsync();
                _currentUser = null;
                LoginOverlay.IsVisible = true;
            });

        await Navigation.PushModalAsync(modal);
    }

    // ==================== 自動再生オーバーレイ & Realtimeコールバック ====================

    private void OnAutoPlayStarted(QueueItem item)
    {
        MainThread.BeginInvokeOnMainThread(() =>
        {
            AutoPlaySenderLabel.Text = $"発話者: {item.SenderName}";
            AutoPlayStopOverlay.IsVisible = true;
        });
    }

    private void OnAutoPlayEnded()
    {
        MainThread.BeginInvokeOnMainThread(() =>
        {
            if (!AudioPlaybackQueue.Instance.IsPlaying)
            {
                AutoPlayStopOverlay.IsVisible = false;
            }
        });
    }

    private void OnAutoPlayStopOverlayTapped(object? sender, TappedEventArgs e)
    {
        AudioPlaybackQueue.Instance.StopAll();
        AutoPlayStopOverlay.IsVisible = false;
    }

    private void OnRealtimeRoomMessageArrived(SupabaseMessage msg)
    {
        if (msg.RoomId != _activeRoomId || msg.RoomId != _loadedRoomId) return;
        if (RoomMessages.Any(m => m.Id == msg.Id)) return;
        RoomMessages.Add(msg);
        ScrollMessagesToBottom(animate: true);

        if (!msg.IsMine)
        {
            NativeAudioService.Instance.VibrateIncomingIfEnabled(msg.Id);
            if (AppConfig.AutoPlayEnabled)
            {
                AudioPlaybackQueue.Instance.EnqueueMessage(msg);
            }
        }
    }

    private async void OnRealtimeUnreadUpdated()
    {
        if (_currentUser != null && _currentCommunity != null)
        {
            int prevUnread = _members.Sum(m => m.UnreadCount) + _groups.Sum(g => g.UnreadCount);
            await MarkVisibleRoomAsReadAsync();
            await ReloadCommunityDataAsync();
            int nextUnread = _members.Sum(m => m.UnreadCount) + _groups.Sum(g => g.UnreadCount);
            if (nextUnread > prevUnread)
            {
                NativeAudioService.Instance.VibrateIncomingIfEnabled();
            }
        }
    }
}
