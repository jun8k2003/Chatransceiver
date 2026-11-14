using Chatransceiver.Maui.Models;
using Chatransceiver.Maui.Platforms.Android.Services;

namespace Chatransceiver.Maui.Services;

/// <summary>
/// AudioPlaybackQueue (src/audio/queue.ts 相当)
/// 着信音声メッセージおよびTTS読み上げを直列キューで順次再生する。
/// DeepSleep中のFCM着信から呼ばれた場合も、NativeAudioService の一時 WakeLock により最後まで再生される。
/// </summary>
public class AudioPlaybackQueue
{
    public static AudioPlaybackQueue Instance { get; } = new();

    private readonly List<QueueItem> _queue = new();
    private readonly HashSet<string> _recentPlayedIds = new();
    private readonly object _lock = new();

    private bool _isPlaying;
    private bool _isPaused;
    private bool _stopRequested;

    public event Action<QueueItem>? PlaybackStarted;
    public event Action? PlaybackEnded;

    public bool IsPlaying
    {
        get
        {
            lock (_lock)
            {
                return _isPlaying;
            }
        }
    }

    /// <summary>
    /// SupabaseMessage から再生可能コンテンツを判定して再生キューに追加する
    /// </summary>
    public void EnqueueMessage(SupabaseMessage msg)
    {
        var isAudio = !string.IsNullOrEmpty(msg.AudioUrl);
        var content = isAudio ? msg.AudioUrl! : msg.TextContent;
        if (string.IsNullOrEmpty(content)) return;

        Enqueue(new QueueItem
        {
            Id = msg.Id,
            Type = isAudio ? "audio" : "text",
            Content = content,
            SenderName = msg.SenderName,
            RoomId = msg.RoomId
        });
    }

    public void Enqueue(QueueItem item)
    {
        bool shouldStart = false;
        lock (_lock)
        {
            if (!string.IsNullOrEmpty(item.Id))
            {
                // Realtime と FCM の両方から同一メッセージが届いた場合の二重再生を防止
                if (_queue.Any(q => q.Id == item.Id) || _recentPlayedIds.Contains(item.Id))
                {
                    return;
                }
                _recentPlayedIds.Add(item.Id);
                if (_recentPlayedIds.Count > 200)
                {
                    _recentPlayedIds.Clear();
                    _recentPlayedIds.Add(item.Id);
                }
            }

            _queue.Add(item);
            if (!_isPlaying && !_isPaused)
            {
                _isPlaying = true;
                shouldStart = true;
            }
        }

        if (shouldStart)
        {
            _ = PlayNextAsync();
        }
    }

    private async Task PlayNextAsync()
    {
        while (true)
        {
            QueueItem? currentItem;
            lock (_lock)
            {
                if (_queue.Count == 0 || _isPaused)
                {
                    _isPlaying = false;
                    NativeAudioService.Instance.ReleaseWakeLock();
                    return;
                }

                _stopRequested = false;
                _isPlaying = true;
                currentItem = _queue[0];
                _queue.RemoveAt(0);
            }

            // DeepSleep中でも再生途中でCPUが寝ないよう一時WakeLockを取得
            NativeAudioService.Instance.AcquireWakeLock(45000);

            try
            {
                currentItem.OnPlayStart?.Invoke();
                PlaybackStarted?.Invoke(currentItem);

                await NativeAudioService.Instance.PlayMessageAsync(
                    isAudio: currentItem.Type == "audio",
                    content: currentItem.Content,
                    callSignEnabled: AppConfig.CallSignEnabled,
                    isCancelled: () => _stopRequested);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"AudioPlaybackQueue error: {ex.Message}");
            }
            finally
            {
                currentItem.OnPlayEnd?.Invoke();
            }

            bool shouldContinue;
            lock (_lock)
            {
                if (_stopRequested || _queue.Count == 0 || _isPaused)
                {
                    _stopRequested = false;
                    _isPlaying = false;
                    shouldContinue = false;
                }
                else
                {
                    shouldContinue = true;
                }
            }

            if (!shouldContinue)
            {
                // IsPlaying を false に確定させてから PlaybackEnded を通知する
                // (UI側が IsPlaying == false を確認してオーバーレイを即座に閉じるため)
                NativeAudioService.Instance.ReleaseWakeLock();
                PlaybackEnded?.Invoke();
                return;
            }
        }
    }

    public void Pause()
    {
        lock (_lock)
        {
            _isPaused = true;
        }
    }

    public void Resume()
    {
        bool shouldStart = false;
        lock (_lock)
        {
            _isPaused = false;
            if (!_isPlaying && _queue.Count > 0)
            {
                _isPlaying = true;
                shouldStart = true;
            }
        }

        if (shouldStart)
        {
            _ = PlayNextAsync();
        }
    }

    /// <summary>
    /// 自動再生のハードストップ (DEC-032)
    /// キューを全消去し、現在再生中の音声・TTSを即座に止め、後続チャイムを鳴らさない。
    /// </summary>
    public void StopAll()
    {
        lock (_lock)
        {
            _queue.Clear();
            if (_isPlaying)
            {
                _stopRequested = true;
            }
        }
        NativeAudioService.Instance.StopAllPlayback();
    }
}
