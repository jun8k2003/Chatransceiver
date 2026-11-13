using Chatransceiver.Maui.Models;

namespace Chatransceiver.Maui.Services;

/// <summary>
/// RealtimeService
/// アプリがフォアグラウンドで表示されている間の新着メッセージ・未読更新をポーリング＋イベント通知で軽量に同期する。
/// (画面消灯・バックグラウンド中は完全に停止し、高優先度FCMに任せることでバッテリー消費をゼロにする)
/// </summary>
public class RealtimeService
{
    public static RealtimeService Instance { get; } = new();

    private CancellationTokenSource? _cts;
    private string? _watchedRoomId;
    private string? _watchedCommunityId;
    private string? _currentUserId;
    private HashSet<string> _knownMessageIds = new();

    public event Action<SupabaseMessage>? NewRoomMessageArrived;
    public event Action? CommunityUnreadUpdated;

    public void StartForegroundSync(string userId, string communityId, string? activeRoomId, IEnumerable<string>? initialMessageIds = null)
    {
        StopForegroundSync();

        _currentUserId = userId;
        _watchedCommunityId = communityId;
        _watchedRoomId = activeRoomId;
        _knownMessageIds = initialMessageIds != null
            ? new HashSet<string>(initialMessageIds)
            : new HashSet<string>();

        _cts = new CancellationTokenSource();
        _ = RunSyncLoopAsync(_cts.Token);
    }

    public void UpdateActiveRoom(string? activeRoomId, IEnumerable<string>? initialMessageIds = null)
    {
        _watchedRoomId = activeRoomId;
        _knownMessageIds = initialMessageIds != null
            ? new HashSet<string>(initialMessageIds)
            : new HashSet<string>();
    }

    public void StopForegroundSync()
    {
        try
        {
            _cts?.Cancel();
            _cts?.Dispose();
        }
        catch
        {
            // Ignore
        }
        _cts = null;
    }

    private async Task RunSyncLoopAsync(CancellationToken token)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(4));
        while (!token.IsCancellationRequested && await timer.WaitForNextTickAsync(token))
        {
            try
            {
                if (string.IsNullOrEmpty(_currentUserId) || string.IsNullOrEmpty(_watchedCommunityId))
                    continue;

                if (!string.IsNullOrEmpty(_watchedRoomId))
                {
                    var messages = await SupabaseClientService.Instance.GetRoomMessagesAsync(_watchedRoomId, _currentUserId);
                    foreach (var msg in messages)
                    {
                        if (_knownMessageIds.Add(msg.Id))
                        {
                            MainThread.BeginInvokeOnMainThread(() => NewRoomMessageArrived?.Invoke(msg));
                        }
                    }
                }

                MainThread.BeginInvokeOnMainThread(() => CommunityUnreadUpdated?.Invoke());
            }
            catch
            {
                // 一時的な通信エラーは無視して次周期で再試行
            }
        }
    }
}
