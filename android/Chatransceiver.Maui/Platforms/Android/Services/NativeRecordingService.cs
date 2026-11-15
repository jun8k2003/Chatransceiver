using System.Text;
using Android.Content;
using Android.Media;
using Android.Media.Audiofx;
using Android.OS;
using Android.Speech;
using Chatransceiver.Maui.Models;
using Chatransceiver.Maui.Services;
using Encoding = Android.Media.Encoding;
using Stream = System.IO.Stream;

namespace Chatransceiver.Maui.Platforms.Android.Services;

/// <summary>
/// NativeRecordingService (specifications.md §8.5)
/// AudioRecord による単一マイク録音 (16kHz / 16bit / Mono PCM) を行い、
/// 1. 送信用 WAV データ生成
/// 2. Android 13 (API 33+) の ParcelFileDescriptor パイプ (ExtraAudioSource) による SpeechRecognizer 端末側文字起こし
/// をマイク競合なしで同時実行する。
/// </summary>
public class NativeRecordingService
{
    public static NativeRecordingService Instance { get; } = new();

    private const int SampleRate = 16000;
    private const int MaxDurationSeconds = 15;

    private AudioRecord? _audioRecord;
    private NoiseSuppressor? _noiseSuppressor;
    private CancellationTokenSource? _recordCts;
    private Task<byte[]>? _recordLoopTask;

    private SpeechRecognizer? _speechRecognizer;
    private ParcelFileDescriptor? _pipeRead;
    private ParcelFileDescriptor? _pipeWrite;
    private ParcelFileDescriptor.AutoCloseOutputStream? _pipeWriteStream;
    private TaskCompletionSource<string>? _speechResultTcs;
    private string _latestPartialTranscript = string.Empty;

    public bool IsRecording { get; private set; }

    public event Action<string>? PartialTranscriptUpdated;
    public event Action<int>? CountdownTick; // 残り秒数 (15 -> 0)
    public event Action? AutoTimeoutReached;

    public async Task<bool> StartRecordingAsync()
    {
        if (IsRecording) return false;

        var mode = AppConfig.RecordingMode; // "both" | "audio_only" | "text_only"
        _latestPartialTranscript = string.Empty;

        int minBuf = AudioRecord.GetMinBufferSize(SampleRate, ChannelIn.Mono, Encoding.Pcm16bit);
        int bufferSize = Math.Max(minBuf * 2, SampleRate); // 約0.5秒分バッファ

        var preferredIn = AudioDeviceService.FindPreferredInputDevice();
        bool isBtInput = AudioDeviceService.IsBluetoothInputDevice(preferredIn);
        if (isBtInput)
        {
            await PttConnectionService.StartPttCallAsync();
        }
        AudioDeviceService.BeginInputRouting(preferredIn);

        try
        {
            bool noiseSuppression = AppConfig.NoiseSuppressionEnabled;
            var audioSource = noiseSuppression ? AudioSource.VoiceCommunication : AudioSource.Mic;

            _audioRecord = new AudioRecord(
                audioSource,
                SampleRate,
                ChannelIn.Mono,
                Encoding.Pcm16bit,
                bufferSize);

            if (_audioRecord.State != State.Initialized && audioSource != AudioSource.Mic)
            {
                _audioRecord.Release();
                _audioRecord = new AudioRecord(
                    AudioSource.Mic,
                    SampleRate,
                    ChannelIn.Mono,
                    Encoding.Pcm16bit,
                    bufferSize);
            }

            if (_audioRecord.State != State.Initialized)
            {
                _audioRecord.Release();
                _audioRecord = null;
                AudioDeviceService.EndInputRouting();
                PttConnectionService.EndPttCall();
                return false;
            }

            if (preferredIn != null)
            {
                _audioRecord.SetPreferredDevice(preferredIn);
            }

            ApplyNoiseSuppression(_audioRecord.AudioSessionId, noiseSuppression);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"AudioRecord init failed: {ex.Message}");
            ReleaseNoiseSuppressor();
            AudioDeviceService.EndInputRouting();
            PttConnectionService.EndPttCall();
            return false;
        }

        // Android 13 (API 33+) かつ文字起こし有効モードの場合は パイプ経由の SpeechRecognizer を起動
        if (mode != "audio_only" && Build.VERSION.SdkInt >= BuildVersionCodes.Tiramisu)
        {
            await StartPipedSpeechRecognizerOnMainThreadAsync();
        }

        IsRecording = true;
        NativeAudioService.Instance.StartSilentRecordingKeeper();
        _recordCts = new CancellationTokenSource();
        var token = _recordCts.Token;

        _audioRecord.StartRecording();

        // Bluetooth HFP/SCO 通話モードへのハードウェア切替完了を待ってから開始ビープを鳴らし、
        // ビープ再生終了直後から本録音を開始することで「音抜け」と「冒頭の頭切れ」を同時に解消する
        await WarmupAndPlayStartToneAsync(isBtInput, preferredIn, token);
        if (token.IsCancellationRequested || !IsRecording)
        {
            return false;
        }

        _recordLoopTask = Task.Run(() => CapturePcmLoop(token), token);
        _ = RunCountdownLoopAsync(token);

        return true;
    }

    private async Task WarmupAndPlayStartToneAsync(
        bool isBtInput,
        AudioDeviceInfo? preferredIn,
        CancellationToken token)
    {
        bool draining = true;
        var drainTask = Task.Run(() =>
        {
            byte[] discard = new byte[1600]; // 50ms @ 16kHz 16bit mono
            while (Volatile.Read(ref draining) && !token.IsCancellationRequested && _audioRecord != null)
            {
                try
                {
                    int r = _audioRecord.Read(discard, 0, discard.Length);
                    if (r <= 0) break;
                }
                catch
                {
                    break;
                }
            }
        });

        try
        {
            if (isBtInput)
            {
                // AudioRecord.Read() により HAL の SCO 入力が開くのを促しつつ、
                // Bluetoothイヤフォンの A2DP -> HFP 通話モード切替完了 (約500ms) を待機
                await Task.Delay(150, token);
                AudioDeviceService.BeginInputRouting(preferredIn);
                await Task.Delay(350, token);
            }

            if (!token.IsCancellationRequested)
            {
                await NativeAudioService.Instance.BeepStartAsync();
            }
        }
        catch (TaskCanceledException) { }
        finally
        {
            Volatile.Write(ref draining, false);
            try
            {
                await drainTask;
            }
            catch { }
        }
    }

    private Task StartPipedSpeechRecognizerOnMainThreadAsync()
    {
        var tcs = new TaskCompletionSource<bool>();
        MainThread.BeginInvokeOnMainThread(() =>
        {
            try
            {
                var context = global::Android.App.Application.Context;
                if (!SpeechRecognizer.IsRecognitionAvailable(context))
                {
                    tcs.TrySetResult(false);
                    return;
                }

                var pipe = ParcelFileDescriptor.CreatePipe();
                if (pipe == null || pipe.Length < 2)
                {
                    tcs.TrySetResult(false);
                    return;
                }

                _pipeRead = pipe[0];
                _pipeWrite = pipe[1];
                _pipeWriteStream = new ParcelFileDescriptor.AutoCloseOutputStream(_pipeWrite);
                _speechResultTcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);

                _speechRecognizer = SpeechRecognizer.CreateSpeechRecognizer(context);
                if (_speechRecognizer == null)
                {
                    ClosePipe();
                    tcs.TrySetResult(false);
                    return;
                }

                _speechRecognizer.SetRecognitionListener(new PipeRecognitionListener(
                    onPartial: text =>
                    {
                        if (!string.IsNullOrWhiteSpace(text))
                        {
                            _latestPartialTranscript = text.Trim();
                            PartialTranscriptUpdated?.Invoke(_latestPartialTranscript);
                        }
                    },
                    onFinal: text =>
                    {
                        var final = !string.IsNullOrWhiteSpace(text) ? text.Trim() : _latestPartialTranscript;
                        _speechResultTcs?.TrySetResult(final);
                    }));

                var intent = new Intent(RecognizerIntent.ActionRecognizeSpeech);
                intent.PutExtra(RecognizerIntent.ExtraLanguageModel, RecognizerIntent.LanguageModelFreeForm);
                intent.PutExtra(RecognizerIntent.ExtraLanguage, "ja-JP");
                intent.PutExtra(RecognizerIntent.ExtraPartialResults, true);
                intent.PutExtra("android.speech.extra.AUDIO_SOURCE", _pipeRead);
                intent.PutExtra("android.speech.extra.AUDIO_SOURCE_CHANNEL_COUNT", 1);
                intent.PutExtra("android.speech.extra.AUDIO_SOURCE_ENCODING", (int)Encoding.Pcm16bit);
                intent.PutExtra("android.speech.extra.AUDIO_SOURCE_SAMPLING_RATE", SampleRate);

                _speechRecognizer.StartListening(intent);
                tcs.TrySetResult(true);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"StartPipedSpeechRecognizer error: {ex.Message}");
                ClosePipe();
                tcs.TrySetResult(false);
            }
        });
        return tcs.Task;
    }

    private byte[] CapturePcmLoop(CancellationToken token)
    {
        using var pcmStream = new MemoryStream(SampleRate * 2 * MaxDurationSeconds);
        byte[] buffer = new byte[3200]; // 100ms @ 16kHz 16bit mono

        while (!token.IsCancellationRequested && _audioRecord != null)
        {
            int read = _audioRecord.Read(buffer, 0, buffer.Length);
            if (read > 0)
            {
                pcmStream.Write(buffer, 0, read);
                try
                {
                    _pipeWriteStream?.Write(buffer, 0, read);
                    _pipeWriteStream?.Flush();
                }
                catch
                {
                    // SpeechRecognizer側が先にパイプを閉じた場合は無視して録音は継続
                }
            }
            else
            {
                break;
            }
        }

        return BuildWavBytes(pcmStream.ToArray(), SampleRate);
    }

    private async Task RunCountdownLoopAsync(CancellationToken token)
    {
        for (int remaining = MaxDurationSeconds; remaining >= 1; remaining--)
        {
            MainThread.BeginInvokeOnMainThread(() => CountdownTick?.Invoke(remaining));
            try
            {
                await Task.Delay(1000, token);
            }
            catch (TaskCanceledException)
            {
                return;
            }
        }

        if (!token.IsCancellationRequested && IsRecording)
        {
            MainThread.BeginInvokeOnMainThread(() => AutoTimeoutReached?.Invoke());
        }
    }

    /// <summary>
    /// 録音を停止し、WAVバイト列と文字起こし結果を返却する
    /// </summary>
    public async Task<RecordingResult> StopRecordingAsync(bool playEndTone = true)
    {
        if (!IsRecording)
        {
            NativeAudioService.Instance.StopSilentRecordingKeeper();
            return new RecordingResult();
        }
        IsRecording = false;
        NativeAudioService.Instance.StopSilentRecordingKeeper();

        try
        {
            _recordCts?.Cancel();
        }
        catch { }

        try
        {
            _audioRecord?.Stop();
        }
        catch { }

        // パイプ書き込み側を閉じて SpeechRecognizer に発話終了 (EOF) を通知
        ClosePipe();

        byte[]? wavBytes = null;
        if (_recordLoopTask != null)
        {
            try
            {
                wavBytes = await _recordLoopTask;
            }
            catch { }
        }

        try
        {
            _audioRecord?.Release();
            _audioRecord?.Dispose();
        }
        catch { }
        _audioRecord = null;
        ReleaseNoiseSuppressor();

        // Bluetooth HFP通話モードを閉じる前に終了ビープを鳴らすことで、HFP->A2DP切替による終了音の消失を防ぐ
        if (playEndTone)
        {
            await NativeAudioService.Instance.BeepEndAsync();
        }

        AudioDeviceService.EndInputRouting();
        PttConnectionService.EndPttCall();

        string transcript = _latestPartialTranscript;
        if (_speechResultTcs != null)
        {
            using var timeoutCts = new CancellationTokenSource(TimeSpan.FromMilliseconds(1500));
            await using var reg = timeoutCts.Token.Register(() => _speechResultTcs.TrySetResult(_latestPartialTranscript));
            try
            {
                transcript = await _speechResultTcs.Task;
            }
            catch { }
        }

        CleanupSpeechRecognizerOnMainThread();

        var mode = AppConfig.RecordingMode;
        bool includeAudio = mode != "text_only";
        bool hasTranscript = !string.IsNullOrWhiteSpace(transcript);

        // DEC-036 準拠:
        // - audio_only モードは常に needs_transcription = true (サーバー側STT対象)
        // - both モードは端末側文字起こしが成功していれば false、空だった場合のみ true
        bool needsTranscription = mode == "audio_only" || (mode == "both" && !hasTranscript);

        var finalText = mode == "audio_only"
            ? "🎤 音声メッセージ"
            : (hasTranscript ? transcript : "🎤 音声メッセージ");

        return new RecordingResult
        {
            WavBytes = includeAudio ? wavBytes : null,
            Transcript = finalText,
            NeedsTranscription = includeAudio && needsTranscription
        };
    }

    private void ApplyNoiseSuppression(int audioSessionId, bool enabled)
    {
        ReleaseNoiseSuppressor();
        try
        {
            if (NoiseSuppressor.IsAvailable)
            {
                _noiseSuppressor = NoiseSuppressor.Create(audioSessionId);
                _noiseSuppressor?.SetEnabled(enabled);
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"ApplyNoiseSuppression error: {ex.Message}");
        }
    }

    private void ReleaseNoiseSuppressor()
    {
        var ns = _noiseSuppressor;
        _noiseSuppressor = null;
        if (ns != null)
        {
            try { ns.Release(); } catch { }
            try { ns.Dispose(); } catch { }
        }
    }

    private void ClosePipe()
    {
        try { _pipeWriteStream?.Close(); } catch { }
        try { _pipeWriteStream?.Dispose(); } catch { }
        _pipeWriteStream = null;

        try { _pipeWrite?.Close(); } catch { }
        try { _pipeWrite?.Dispose(); } catch { }
        _pipeWrite = null;

        try { _pipeRead?.Close(); } catch { }
        try { _pipeRead?.Dispose(); } catch { }
        _pipeRead = null;
    }

    private void CleanupSpeechRecognizerOnMainThread()
    {
        MainThread.BeginInvokeOnMainThread(() =>
        {
            try
            {
                _speechRecognizer?.Destroy();
                _speechRecognizer?.Dispose();
            }
            catch { }
            _speechRecognizer = null;
            _speechResultTcs = null;
        });
    }

    /// <summary>
    /// 16bit Mono PCM 配列に 44バイトの RIFF WAV ヘッダーを付与する
    /// </summary>
    private static byte[] BuildWavBytes(byte[] pcmData, int sampleRate)
    {
        int headerSize = 44;
        byte[] wav = new byte[headerSize + pcmData.Length];
        using var ms = new MemoryStream(wav);
        using var bw = new BinaryWriter(ms, System.Text.Encoding.ASCII);

        bw.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
        bw.Write(36 + pcmData.Length);
        bw.Write(System.Text.Encoding.ASCII.GetBytes("WAVE"));
        bw.Write(System.Text.Encoding.ASCII.GetBytes("fmt "));
        bw.Write(16);                      // fmt chunk size
        bw.Write((short)1);                // PCM = 1
        bw.Write((short)1);                // Mono = 1
        bw.Write(sampleRate);
        bw.Write(sampleRate * 2);          // Byte rate (SampleRate * BlockAlign)
        bw.Write((short)2);                // Block align (Channels * BitsPerSample / 8)
        bw.Write((short)16);               // Bits per sample
        bw.Write(System.Text.Encoding.ASCII.GetBytes("data"));
        bw.Write(pcmData.Length);
        bw.Write(pcmData);

        return wav;
    }

    private sealed class PipeRecognitionListener : Java.Lang.Object, IRecognitionListener
    {
        private readonly Action<string> _onPartial;
        private readonly Action<string> _onFinal;

        public PipeRecognitionListener(Action<string> onPartial, Action<string> onFinal)
        {
            _onPartial = onPartial;
            _onFinal = onFinal;
        }

        public void OnBeginningOfSpeech() { }
        public void OnBufferReceived(byte[]? buffer) { }
        public void OnEndOfSpeech() { }
        public void OnEvent(int eventType, Bundle? @params) { }
        public void OnReadyForSpeech(Bundle? @params) { }
        public void OnRmsChanged(float rmsdB) { }

        public void OnError(SpeechRecognizerError error)
        {
            _onFinal(string.Empty);
        }

        public void OnPartialResults(Bundle? partialResults)
        {
            var list = partialResults?.GetStringArrayList(SpeechRecognizer.ResultsRecognition);
            if (list != null && list.Count > 0 && !string.IsNullOrEmpty(list[0]))
            {
                _onPartial(list[0]);
            }
        }

        public void OnResults(Bundle? results)
        {
            var list = results?.GetStringArrayList(SpeechRecognizer.ResultsRecognition);
            var best = (list != null && list.Count > 0) ? (list[0] ?? string.Empty) : string.Empty;
            _onFinal(best);
        }
    }
}
