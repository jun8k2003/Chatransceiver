using Android.Content;
using Android.Media;
using Android.OS;
using Android.Speech.Tts;
using Java.Util;
using Locale = Java.Util.Locale;
using TextToSpeech = Android.Speech.Tts.TextToSpeech;

namespace Chatransceiver.Maui.Platforms.Android.Services;

/// <summary>
/// NativeAudioService
/// - DeepSleep時の一時 PARTIAL_WAKE_LOCK 取得・解放
/// - MediaPlayer によるリモート音声 (webm/wav) およびコールサイン音再生
/// - Android.Speech.Tts.TextToSpeech によるロック画面対応のネイティブ音声合成読み上げ
/// - AudioTrack による PTT 開始・終了・エラービープ音生成
/// </summary>
public class NativeAudioService : Java.Lang.Object, TextToSpeech.IOnInitListener
{
    public static NativeAudioService Instance { get; } = new();

    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(15) };
    private PowerManager.WakeLock? _wakeLock;
    private MediaPlayer? _activePlayer;
    private TaskCompletionSource<bool>? _activePlayTcs;

    private TextToSpeech? _tts;
    private TaskCompletionSource<bool>? _ttsInitTcs;
    private TaskCompletionSource<bool>? _activeSpeechTcs;
    private bool _ttsReady;

    /// <summary>
    /// 再生中・録音中のみCPUをスリープさせない一時WakeLockを取得する（安全タイムアウト付き）
    /// </summary>
    public void AcquireWakeLock(long timeoutMs = 30000)
    {
        try
        {
            if (_wakeLock == null)
            {
                var context = global::Android.App.Application.Context;
                var pm = (PowerManager?)context.GetSystemService(Context.PowerService);
                if (pm != null)
                {
                    _wakeLock = pm.NewWakeLock(WakeLockFlags.Partial, "Chatransceiver::AudioWakeLock");
                    _wakeLock?.SetReferenceCounted(false);
                }
            }
            if (_wakeLock != null && !_wakeLock.IsHeld)
            {
                _wakeLock.Acquire(timeoutMs);
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"AcquireWakeLock error: {ex.Message}");
        }
    }

    public void ReleaseWakeLock()
    {
        try
        {
            if (_wakeLock != null && _wakeLock.IsHeld)
            {
                _wakeLock.Release();
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"ReleaseWakeLock error: {ex.Message}");
        }
    }

    /// <summary>
    /// コールサイン効果音 (Resources/Raw/ptt_start.wav) を再生する
    /// </summary>
    public async Task PlayCallSignAssetAsync(float volume = 0.3f)
    {
        var context = global::Android.App.Application.Context;
        var cacheFile = Path.Combine(context.CacheDir!.AbsolutePath, "ptt_start_cached.wav");
        if (!File.Exists(cacheFile))
        {
            await using var stream = await FileSystem.OpenAppPackageFileAsync("ptt_start.wav");
            await using var fs = File.Create(cacheFile);
            await stream.CopyToAsync(fs);
        }
        await PlayLocalFileAsync(cacheFile, volume);
    }

    /// <summary>
    /// Supabase Storage 上の音声ファイルをキャッシュへDLしてから確実に再生する
    /// </summary>
    public async Task PlayRemoteAudioAsync(string audioUrl, float volume = 1.0f)
    {
        var context = global::Android.App.Application.Context;
        var ext = audioUrl.Contains(".wav", StringComparison.OrdinalIgnoreCase) ? ".wav" : ".webm";
        var tempFile = Path.Combine(context.CacheDir!.AbsolutePath, $"msg_{Guid.NewGuid():N}{ext}");
        try
        {
            var bytes = await _http.GetByteArrayAsync(audioUrl);
            await File.WriteAllBytesAsync(tempFile, bytes);
            await PlayLocalFileAsync(tempFile, volume);
        }
        finally
        {
            try
            {
                if (File.Exists(tempFile)) File.Delete(tempFile);
            }
            catch { }
        }
    }

    private Task PlayLocalFileAsync(string filePath, float volume)
    {
        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        _activePlayTcs = tcs;

        try
        {
            StopActiveMediaPlayer();

            var player = new MediaPlayer();
            _activePlayer = player;

            var attrs = new AudioAttributes.Builder()
                ?.SetUsage(AudioUsageKind.Media)
                ?.SetContentType(AudioContentType.Speech)
                ?.Build();
            if (attrs != null)
            {
                player.SetAudioAttributes(attrs);
            }

            player.SetDataSource(filePath);
            player.SetVolume(volume, volume);
            player.Completion += (_, _) =>
            {
                StopActiveMediaPlayer();
                tcs.TrySetResult(true);
            };
            player.Error += (_, _) =>
            {
                StopActiveMediaPlayer();
                tcs.TrySetResult(false);
            };
            player.Prepare();
            player.Start();
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"PlayLocalFileAsync error: {ex.Message}");
            StopActiveMediaPlayer();
            tcs.TrySetResult(false);
        }

        return tcs.Task;
    }

    private void StopActiveMediaPlayer()
    {
        var p = _activePlayer;
        _activePlayer = null;
        if (p != null)
        {
            try
            {
                if (p.IsPlaying) p.Stop();
            }
            catch { }
            try
            {
                p.Release();
                p.Dispose();
            }
            catch { }
        }
    }

    /// <summary>
    /// Androidネイティブ TextToSpeech でテキストを読み上げる（DeepSleep・画面ロック中も動作）
    /// </summary>
    public async Task SpeakTextAsync(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;

        await EnsureTtsInitializedAsync();
        if (!_ttsReady || _tts == null) return;

        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        _activeSpeechTcs = tcs;
        var utteranceId = Guid.NewGuid().ToString("N");

        _tts.SetOnUtteranceProgressListener(new TtsUtteranceListener(utteranceId, () =>
        {
            tcs.TrySetResult(true);
        }));

        var bundle = new Bundle();
        bundle.PutFloat(TextToSpeech.Engine.KeyParamVolume, 1.0f);
        _tts.Speak(text, QueueMode.Flush, bundle, utteranceId);

        // TTSエンジンが万が一OnDoneを返さない端末向けの安全タイムアウト (DEC-032)
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        await using var reg = cts.Token.Register(() => tcs.TrySetResult(false));
        await tcs.Task;
    }

    private Task<bool> EnsureTtsInitializedAsync()
    {
        if (_ttsReady && _tts != null) return Task.FromResult(true);

        if (_ttsInitTcs != null) return _ttsInitTcs.Task;

        _ttsInitTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        MainThread.BeginInvokeOnMainThread(() =>
        {
            try
            {
                _tts = new TextToSpeech(global::Android.App.Application.Context, this);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"TTS init exception: {ex.Message}");
                _ttsInitTcs?.TrySetResult(false);
            }
        });
        return _ttsInitTcs.Task;
    }

    public void OnInit(OperationResult status)
    {
        if (status == OperationResult.Success && _tts != null)
        {
            try
            {
                _tts.SetLanguage(Locale.Japanese);
                var attrs = new AudioAttributes.Builder()
                    ?.SetUsage(AudioUsageKind.Media)
                    ?.SetContentType(AudioContentType.Speech)
                    ?.Build();
                if (attrs != null) _tts.SetAudioAttributes(attrs);
            }
            catch { }
            _ttsReady = true;
            _ttsInitTcs?.TrySetResult(true);
        }
        else
        {
            _ttsReady = false;
            _ttsInitTcs?.TrySetResult(false);
        }
    }

    /// <summary>
    /// すべての再生とTTSを即座に強制停止する (DEC-032)
    /// </summary>
    public void StopAllPlayback()
    {
        StopActiveMediaPlayer();
        _activePlayTcs?.TrySetResult(false);
        _activePlayTcs = null;

        try
        {
            _tts?.Stop();
        }
        catch { }
        _activeSpeechTcs?.TrySetResult(false);
        _activeSpeechTcs = null;
    }

    /// <summary>
    /// PTT録音開始ビープ (800Hz -> 1200Hz)
    /// </summary>
    public void BeepStart() => PlayTones(new[] { (800, 80), (1200, 80) });

    /// <summary>
    /// PTT録音停止・送信ビープ (1200Hz -> 800Hz)
    /// </summary>
    public void BeepEnd() => PlayTones(new[] { (1200, 80), (800, 80) });

    /// <summary>
    /// PTTエラービープ (400Hz x 2)
    /// </summary>
    public void BeepError() => PlayTones(new[] { (400, 120), (0, 60), (400, 120) });

    private static void PlayTones((int FreqHz, int DurationMs)[] tones)
    {
        _ = Task.Run(() =>
        {
            try
            {
                const int sampleRate = 16000;
                int totalSamples = tones.Sum(t => sampleRate * t.DurationMs / 1000);
                short[] pcm = new short[totalSamples];

                int offset = 0;
                foreach (var (freq, durMs) in tones)
                {
                    int count = sampleRate * durMs / 1000;
                    int fadeSamples = Math.Min(sampleRate / 100, count / 4); // 10msフェードでクリックノイズ防止
                    for (int i = 0; i < count; i++)
                    {
                        if (freq <= 0)
                        {
                            pcm[offset + i] = 0;
                        }
                        else
                        {
                            double env = 1.0;
                            if (i < fadeSamples) env = (double)i / fadeSamples;
                            else if (i > count - fadeSamples) env = (double)(count - i) / fadeSamples;

                            double angle = 2.0 * Math.PI * freq * i / sampleRate;
                            pcm[offset + i] = (short)(Math.Sin(angle) * short.MaxValue * 0.3 * env);
                        }
                    }
                    offset += count;
                }

                var attrs = new AudioAttributes.Builder()
                    ?.SetUsage(AudioUsageKind.Media)
                    ?.SetContentType(AudioContentType.Sonification)
                    ?.Build();
                var format = new AudioFormat.Builder()
                    ?.SetEncoding(Encoding.Pcm16bit)
                    ?.SetSampleRate(sampleRate)
                    ?.SetChannelMask(ChannelOut.Mono)
                    ?.Build();

                if (attrs == null || format == null) return;

                int byteLen = pcm.Length * 2;
                using var track = new AudioTrack(
                    attrs,
                    format,
                    byteLen,
                    AudioTrackMode.Static,
                    0);
                track.Write(pcm, 0, pcm.Length);
                track.Play();
                Thread.Sleep(tones.Sum(t => t.DurationMs) + 50);
                track.Stop();
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"PlayTones error: {ex.Message}");
            }
        });
    }

    private sealed class TtsUtteranceListener : UtteranceProgressListener
    {
        private readonly string _targetId;
        private readonly Action _onFinish;

        public TtsUtteranceListener(string targetId, Action onFinish)
        {
            _targetId = targetId;
            _onFinish = onFinish;
        }

        public override void OnStart(string? utteranceId) { }

        public override void OnDone(string? utteranceId)
        {
            if (utteranceId == _targetId) _onFinish();
        }

        public override void OnStop(string? utteranceId, bool interrupted)
        {
            if (utteranceId == _targetId) _onFinish();
        }

        [Obsolete]
        public override void OnError(string? utteranceId)
        {
            if (utteranceId == _targetId) _onFinish();
        }
    }
}
