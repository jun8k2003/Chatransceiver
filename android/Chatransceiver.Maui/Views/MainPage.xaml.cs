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

    private UnifiedListItem? _activeItem;
    private string? _activeRoomId;
    private RecordingResult? _stoppedRecordingResult;

    public ObservableCollection<UnifiedListItem> VisibleItems { get; } = new();
    public ObservableCollection<SupabaseMessage> RoomMessages { get; } = new();

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

        RealtimeService.Instance.NewRoomMessageArrived += OnRealtimeRoomMessageArrived;
        RealtimeService.Instance.CommunityUnreadUpdated += OnRealtimeUnreadUpdated;

        _ = InitializeSessionAsync();
    }

    private async Task InitializeSessionAsync()
    {
        UpdateHeaderIconStates();

        var user = await SupabaseClientService.Instance.GetCurrentUserAsync();
        if (user != null)
        {
            await ApplyLoggedInUserAsync(user);
        }
        else
        {
            LoginOverlay.IsVisible = true;
        }
    }

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
                await ConnectToCommunityInternalAsync(lastSlug);
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
            await SupabaseClientService.Instance.SignInWithGoogleAsync();
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
            await SupabaseClientService.Instance.SignInWithMagicLinkAsync(email);
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

    private async Task ConnectToCommunityInternalAsync(string slugOrInviteUrl)
    {
        if (_currentUser == null) return;

        try
        {
            var community = await SupabaseClientService.Instance.ConnectCommunityAsync(_currentUser.Id, slugOrInviteUrl);
            _currentCommunity = community;
            CommunityPillButton.Text = $"🌐 {community.Name} ▾";

            await ReloadCommunityDataAsync();

            RealtimeService.Instance.StartForegroundSync(
                _currentUser.Id,
                community.Id,
                _activeRoomId,
                RoomMessages.Select(m => m.Id));
        }
        catch (Exception ex)
        {
            await DisplayAlert("コミュニティ接続エラー", ex.Message, "OK");
        }
    }

    private async Task ReloadCommunityDataAsync()
    {
        if (_currentUser == null || _currentCommunity == null) return;

        var membersTask = SupabaseClientService.Instance.GetCommunityMembersAsync(_currentCommunity.Id, _currentUser.Id);
        var unreadTask = SupabaseClientService.Instance.GetUnreadIndividualCountsAsync(_currentUser.Id, _currentCommunity.Id);
        var groupsTask = SupabaseClientService.Instance.GetCommunityGroupsAsync(_currentCommunity.Id, _currentUser.Id);

        await Task.WhenAll(membersTask, unreadTask, groupsTask);

        _members = membersTask.Result;
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
        RebuildUnifiedList();
    }

    private void RebuildUnifiedList()
    {
        VisibleItems.Clear();

        if (_currentFilter == "all" || _currentFilter == "group")
        {
            foreach (var g in _groups)
            {
                VisibleItems.Add(new UnifiedListItem
                {
                    Id = g.Id,
                    IsGroup = true,
                    DisplayTitle = $"👥 {g.Name}",
                    Subtitle = $"メンバー ({g.MemberCount}人): {g.MemberNames}",
                    UnreadCount = g.UnreadCount,
                    IsActiveRoom = _activeRoomId == g.Id
                });
            }
        }

        if (_currentFilter == "all" || _currentFilter == "individual")
        {
            foreach (var m in _members)
            {
                VisibleItems.Add(new UnifiedListItem
                {
                    Id = m.Id,
                    IsGroup = false,
                    DisplayTitle = $"#{m.UserNumber} {m.Name}",
                    Subtitle = "個別チャット",
                    IsOnline = m.IsOnline,
                    UnreadCount = m.UnreadCount,
                    IsActiveRoom = _activeItem != null && !_activeItem.IsGroup && _activeItem.Id == m.Id
                });
            }
        }
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
        _activeItem = null;
        AppConfig.CurrentCommunitySlug = null;
        AppConfig.ActiveRoomId = null;
        AppConfig.ActiveRoomTitle = null;
        _members.Clear();
        _groups.Clear();
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
            var slug = _currentCommunity.Slug;
            await SupabaseClientService.Instance.LeaveCommunityAsync(_currentUser.Id, _currentCommunity.Id);
            AppConfig.RemoveCommunityHistory(slug);
            DisconnectCommunityNonDestructive();
            CommunityMenuOverlay.IsVisible = false;
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

    private void SetFilter(string filter)
    {
        _currentFilter = filter;
        FilterAllBtn.BackgroundColor = filter == "all" ? Color.FromArgb("#3B82F6") : Color.FromArgb("#334155");
        FilterIndividualBtn.BackgroundColor = filter == "individual" ? Color.FromArgb("#3B82F6") : Color.FromArgb("#334155");
        FilterGroupBtn.BackgroundColor = filter == "group" ? Color.FromArgb("#3B82F6") : Color.FromArgb("#334155");
        RebuildUnifiedList();
    }

    private void OnToggleGroupSelectModeClicked(object? sender, EventArgs e)
    {
        _isGroupSelectMode = !_isGroupSelectMode;
        GroupCreateConfirmBar.IsVisible = _isGroupSelectMode;
        if (_isGroupSelectMode)
        {
            SetFilter("individual");
        }
        else
        {
            foreach (var item in VisibleItems) item.IsSelectedForGroup = false;
        }
    }

    private async void OnConfirmCreateGroupClicked(object? sender, EventArgs e)
    {
        if (_currentUser == null || _currentCommunity == null) return;

        var selectedIds = VisibleItems
            .Where(i => !i.IsGroup && i.IsSelectedForGroup)
            .Select(i => i.Id)
            .ToList();

        if (selectedIds.Count < 2)
        {
            await DisplayAlert("選択不足", "グループを作成するには2人以上のメンバーを選択してください。", "OK");
            return;
        }

        try
        {
            var roomId = await SupabaseClientService.Instance.CreateGroupRoomAsync(_currentCommunity.Id, _currentUser.Id, selectedIds);
            _isGroupSelectMode = false;
            GroupCreateConfirmBar.IsVisible = false;
            SetFilter("all");
            await ReloadCommunityDataAsync();

            var createdGroup = VisibleItems.FirstOrDefault(i => i.IsGroup && i.Id == roomId);
            if (createdGroup != null)
            {
                await OpenUnifiedItemChatAsync(createdGroup);
            }
        }
        catch (Exception ex)
        {
            await DisplayAlert("グループ作成エラー", ex.Message, "OK");
        }
    }

    private async void OnUnifiedItemTapped(object? sender, TappedEventArgs e)
    {
        if (e.Parameter is not UnifiedListItem item) return;

        if (_isGroupSelectMode && !item.IsGroup)
        {
            item.IsSelectedForGroup = !item.IsSelectedForGroup;
            return;
        }

        await OpenUnifiedItemChatAsync(item);
    }

    private async Task OpenUnifiedItemChatAsync(UnifiedListItem item)
    {
        if (_currentUser == null || _currentCommunity == null) return;

        try
        {
            _activeItem = item;
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

            // チャットを開いた時点で既読化 (DEC-010)
            await SupabaseClientService.Instance.MarkAsReadAsync(roomId, _currentUser.Id);
            item.UnreadCount = 0;

            var msgs = await SupabaseClientService.Instance.GetRoomMessagesAsync(roomId, _currentUser.Id);
            RoomMessages.Clear();
            foreach (var m in msgs) RoomMessages.Add(m);

            RealtimeService.Instance.UpdateActiveRoom(roomId, msgs.Select(m => m.Id));
            await ReloadCommunityDataAsync();

            ShowPane(showChat: true);
        }
        catch (Exception ex)
        {
            await DisplayAlert("チャット表示エラー", ex.Message, "OK");
        }
    }

    private void OnShowListPaneClicked(object? sender, EventArgs e) => ShowPane(showChat: false);
    private void OnShowChatPaneClicked(object? sender, EventArgs e) => ShowPane(showChat: true);

    private void ShowPane(bool showChat)
    {
        ListPaneGrid.IsVisible = !showChat;
        ChatPaneGrid.IsVisible = showChat;
        TabListButton.BackgroundColor = !showChat ? Color.FromArgb("#3B82F6") : Color.FromArgb("#334155");
        TabChatButton.BackgroundColor = showChat ? Color.FromArgb("#3B82F6") : Color.FromArgb("#334155");

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
            await SupabaseClientService.Instance.UpdateRoomNameAsync(_activeRoomId, result);
            await ReloadCommunityDataAsync();
            var updated = _groups.FirstOrDefault(g => g.Id == _activeRoomId);
            if (updated != null)
            {
                ChatHeaderTitleLabel.Text = $"👥 {updated.Name}";
                AppConfig.ActiveRoomTitle = ChatHeaderTitleLabel.Text;
            }
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

        if (NativeRecordingService.Instance.IsRecording) return;

        _stoppedRecordingResult = null;
        AudioPlaybackQueue.Instance.Pause();
        NativeAudioService.Instance.BeepStart();

        RecordingStatusTitleLabel.Text = "🔴 音声録音中...";
        RecordingTimerLabel.Text = "00:15";
        RecordingProgressBar.Progress = 1.0;
        TranscriptPreviewLabel.Text = "（発話するとここに文字起こしが表示されます）";
        ModalStopBtn.IsEnabled = true;
        ModalStopBtn.Text = "⏹️ 停止して確認";
        ModalSendBtn.IsEnabled = true;
        RecordingModalOverlay.IsVisible = true;

        bool ok = await NativeRecordingService.Instance.StartRecordingAsync();
        if (!ok)
        {
            ResetRecordingUi();
            AudioPlaybackQueue.Instance.Resume();
            await DisplayAlert("マイクエラー", "マイクの初期化に失敗しました。マイク権限が許可されているか確認してください。", "OK");
        }
    }

    private async void OnModalStopRecordingClicked(object? sender, EventArgs e)
    {
        if (!NativeRecordingService.Instance.IsRecording) return;

        ModalStopBtn.IsEnabled = false;
        _stoppedRecordingResult = await NativeRecordingService.Instance.StopRecordingAsync();
        NativeAudioService.Instance.BeepEnd();

        RecordingStatusTitleLabel.Text = "⏸️ 録音完了（送信待ち）";
        TranscriptPreviewLabel.Text = _stoppedRecordingResult.Transcript;
        ModalStopBtn.Text = "停止済み";
    }

    private async void OnModalSendRecordingClicked(object? sender, EventArgs e)
    {
        await FinishForegroundRecordingAndSendAsync();
    }

    private async void OnForegroundRecordingTimeout()
    {
        if (TransceiverForegroundService.IsRunning) return; // サービス側で処理される場合はスキップ
        if (NativeRecordingService.Instance.IsRecording)
        {
            // 15秒経過時は録音を止めて確認状態にする（または送信ボタンを押せるようにする）
            ModalStopBtn.IsEnabled = false;
            _stoppedRecordingResult = await NativeRecordingService.Instance.StopRecordingAsync();
            NativeAudioService.Instance.BeepEnd();
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
                NativeAudioService.Instance.BeepEnd();
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
                var sent = await SupabaseClientService.Instance.SendMessageAsync(
                    _activeRoomId,
                    _currentUser.Id,
                    result.Transcript,
                    result.WavBytes,
                    result.NeedsTranscription);
                RoomMessages.Add(sent);
                ScrollMessagesToBottom(animate: true);
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
        if (NativeRecordingService.Instance.IsRecording)
        {
            _ = await NativeRecordingService.Instance.StopRecordingAsync();
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
            var sent = await SupabaseClientService.Instance.SendMessageAsync(_activeRoomId, _currentUser.Id, text);
            RoomMessages.Add(sent);
            ScrollMessagesToBottom(animate: true);
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

        try
        {
            if (AppConfig.CallSignEnabled)
            {
                try
                {
                    await NativeAudioService.Instance.PlayCallSignAssetAsync(0.3f);
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"CallSign before error: {ex.Message}");
                }
            }

            if (msg.HasAudio && !string.IsNullOrEmpty(msg.AudioUrl))
            {
                await NativeAudioService.Instance.PlayRemoteAudioAsync(msg.AudioUrl);
            }
            else if (!string.IsNullOrEmpty(msg.TextContent))
            {
                await NativeAudioService.Instance.SpeakTextAsync(msg.TextContent);
            }

            if (AppConfig.CallSignEnabled)
            {
                try
                {
                    await NativeAudioService.Instance.PlayCallSignAssetAsync(0.3f);
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"CallSign after error: {ex.Message}");
                }
            }
        }
        catch (Exception ex)
        {
            await DisplayAlert("再生エラー", ex.Message, "OK");
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
            await SupabaseClientService.Instance.RevokeMessageAsync(msg.Id, _currentUser.Id);
            msg.IsRevoked = true;
            msg.AudioUrl = null;
            msg.TextContent = string.Empty;
            msg.NotifyChanged();
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

            await SupabaseClientService.Instance.UnregisterFcmTokenAsync();
            UpdateHeaderIconStates();
        }
        else
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
                await DisplayAlert(
                    "FCMトークン未取得",
                    "Firebase (google-services.json) が構成されていないか、Google Play開発者サービスからトークンを取得できませんでした。",
                    "OK");
                return;
            }

            bool ok = await SupabaseClientService.Instance.RegisterFcmTokenAsync(token);
            UpdateHeaderIconStates();
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
        if (RoomMessages.Any(m => m.Id == msg.Id)) return;
        RoomMessages.Add(msg);
        ScrollMessagesToBottom(animate: true);

        if (!msg.IsMine && AppConfig.AutoPlayEnabled)
        {
            var isAudio = !string.IsNullOrEmpty(msg.AudioUrl);
            var content = isAudio ? msg.AudioUrl! : msg.TextContent;
            if (!string.IsNullOrEmpty(content))
            {
                AudioPlaybackQueue.Instance.Enqueue(new QueueItem
                {
                    Id = msg.Id,
                    Type = isAudio ? "audio" : "text",
                    Content = content,
                    SenderName = msg.SenderName,
                    RoomId = msg.RoomId
                });
            }
        }
    }

    private async void OnRealtimeUnreadUpdated()
    {
        if (_currentUser != null && _currentCommunity != null)
        {
            await ReloadCommunityDataAsync();
        }
    }
}
