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

    public bool IsPlaying => _isPlaying;

    public void Enqueue(QueueItem item)
    {
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
        }

        if (!_isPlaying && !_isPaused)
        {
            _ = PlayNextAsync();
        }
    }

    private async Task PlayNextAsync()
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

            // 1. 再生前チャイム (疑似コールサイン音)
            if (AppConfig.CallSignEnabled && !_stopRequested)
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

            // 2. メッセージ本体 (音声ファイル または ネイティブTTS)
            if (!_stopRequested)
            {
                if (currentItem.Type == "audio" && !string.IsNullOrEmpty(currentItem.Content))
                {
                    await NativeAudioService.Instance.PlayRemoteAudioAsync(currentItem.Content);
                }
                else if (!string.IsNullOrEmpty(currentItem.Content))
                {
                    await NativeAudioService.Instance.SpeakTextAsync(currentItem.Content);
                }
            }

            // 3. 再生後チャイム
            if (AppConfig.CallSignEnabled && !_stopRequested)
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
            System.Diagnostics.Debug.WriteLine($"AudioPlaybackQueue error: {ex.Message}");
        }
        finally
        {
            currentItem.OnPlayEnd?.Invoke();
            PlaybackEnded?.Invoke();

            if (_stopRequested)
            {
                _stopRequested = false;
                _isPlaying = false;
                NativeAudioService.Instance.ReleaseWakeLock();
            }
            else
            {
                await PlayNextAsync();
            }
        }
    }

    public void Pause()
    {
        _isPaused = true;
    }

    public void Resume()
    {
        _isPaused = false;
        if (!_isPlaying)
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
