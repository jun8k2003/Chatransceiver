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
    private const int ReadNonBlocking = 1; // AudioRecord.READ_NON_BLOCKING

    private AudioRecord? _audioRecord;
    private NoiseSuppressor? _noiseSuppressor;
    private CancellationTokenSource? _recordCts;
    private Task<byte[]>? _recordLoopTask;
    private readonly SemaphoreSlim _recordingLock = new(1, 1);

    private SpeechRecognizer? _speechRecognizer;
    private ParcelFileDescriptor? _pipeRead;
    private ParcelFileDescriptor? _pipeWrite;
    private ParcelFileDescriptor.AutoCloseOutputStream? _pipeWriteStream;
    private TaskCompletionSource<string>? _speechResultTcs;
    private string _latestPartialTranscript = string.Empty;

    public bool IsRecording { get; private set; }
    public bool IsStarting { get; private set; }

    public event Action<string>? PartialTranscriptUpdated;
    public event Action<int>? CountdownTick; // 残り秒数 (15 -> 0)
    public event Action? AutoTimeoutReached;

    public async Task<bool> StartRecordingAsync()
    {
        if (!await _recordingLock.WaitAsync(0)) return false;
        if (IsRecording)
        {
            _recordingLock.Release();
            return false;
        }

        IsStarting = true;
        _recordCts = new CancellationTokenSource();
        var token = _recordCts.Token;
        _recordLoopTask = null;
        _latestPartialTranscript = string.Empty;
        bool started = false;
        try
        {
            var mode = AppConfig.RecordingMode;
            int minBuf = AudioRecord.GetMinBufferSize(SampleRate, ChannelIn.Mono, Encoding.Pcm16bit);
            int bufferSize = Math.Max(minBuf * 2, SampleRate);
            var preferredIn = AudioDeviceService.FindPreferredInputDevice();
            bool isBtInput = AudioDeviceService.IsBluetoothInputDevice(preferredIn);
            if (isBtInput && !await PttConnectionService.StartPttCallAsync(token)) return false;
            token.ThrowIfCancellationRequested();
            AudioDeviceService.BeginInputRouting(preferredIn);

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
                throw new InvalidOperationException("AudioRecord initialization failed.");

            if (preferredIn != null && !_audioRecord.SetPreferredDevice(preferredIn))
                throw new InvalidOperationException("The selected microphone is unavailable.");

            ApplyNoiseSuppression(_audioRecord.AudioSessionId, noiseSuppression);

            NativeAudioService.Instance.StartSilentRecordingKeeper();
            _audioRecord.StartRecording();
            await WarmupAndPlayStartToneAsync(preferredIn,
                mode != "audio_only" && Build.VERSION.SdkInt >= BuildVersionCodes.Tiramisu, token);
            token.ThrowIfCancellationRequested();

            // 開始音が終わるまでは準備中。以前の録音タスクも再利用しない。
            var recorder = _audioRecord;
            _recordLoopTask = Task.Run(() => CapturePcmLoop(recorder, token));
            IsRecording = true;
            started = true;
            _ = RunCountdownLoopAsync(token);
            return true;
        }
        catch (System.OperationCanceledException) { return false; }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"StartRecordingAsync failed: {ex.Message}");
            return false;
        }
        finally
        {
            if (!started) ReleaseRecordingResources();
            IsStarting = false;
            _recordingLock.Release();
        }
    }

    private async Task WarmupAndPlayStartToneAsync(
        AudioDeviceInfo? preferredIn,
        bool transcribe,
        CancellationToken token)
    {
        var recorder = _audioRecord!;
        bool draining = true;
        var ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var drainTask = Task.Run(async () =>
        {
            byte[] discard = new byte[1600];
            try
            {
                while (Volatile.Read(ref draining) && !token.IsCancellationRequested)
                {
                    // 接続待ちのReadで永久に止まらないよう、ノンブロッキングで排出する。
                    int read = recorder.Read(discard, 0, discard.Length, ReadNonBlocking);
                    if (read < 0) throw new IOException($"AudioRecord warmup failed: {read}");
                    if (read > 0 && AudioDeviceService.IsInputRouteReady(preferredIn, recorder.RoutedDevice))
                        ready.TrySetResult(true);
                    await Task.Delay(10, token);
                }
            }
            catch (System.OperationCanceledException) { }
            catch (Exception ex) { ready.TrySetException(ex); }
        });

        try
        {
            // 機種ごとの切替時間を許容し、入力経路とPCM取得を確認してから開始音を鳴らす。
            await ready.Task.WaitAsync(TimeSpan.FromSeconds(8), token);
            if (transcribe) await StartPipedSpeechRecognizerOnMainThreadAsync();
            token.ThrowIfCancellationRequested();
            await NativeAudioService.Instance.BeepStartAsync();
        }
        finally
        {
            Volatile.Write(ref draining, false);
            await drainTask;
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

    private byte[] CapturePcmLoop(AudioRecord recorder, CancellationToken token)
    {
        using var pcmStream = new MemoryStream(SampleRate * 2 * MaxDurationSeconds);
        byte[] buffer = new byte[3200]; // 100ms @ 16kHz 16bit mono

        while (!token.IsCancellationRequested)
        {
            int read = recorder.Read(buffer, 0, buffer.Length, ReadNonBlocking);
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
            else if (read < 0)
            {
                if (token.IsCancellationRequested) break;
                throw new IOException($"AudioRecord capture failed: {read}");
            }
            else if (token.WaitHandle.WaitOne(10)) break;
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
        // 準備中の停止はキャンセルとし、本録音が始まるまで待って送信しない。
        try { _recordCts?.Cancel(); } catch (ObjectDisposedException) { }
        await _recordingLock.WaitAsync();
        try
        {
            if (!IsRecording) return new RecordingResult();
            IsRecording = false;
            NativeAudioService.Instance.StopSilentRecordingKeeper();

            try { _audioRecord?.Stop(); } catch { }
            ClosePipe();

            byte[]? wavBytes = null;
            if (_recordLoopTask != null)
            {
                try { wavBytes = await _recordLoopTask; }
                catch (Exception ex) { System.Diagnostics.Debug.WriteLine($"Capture failed: {ex.Message}"); }
            }

            // 通話ルートを閉じる前に終了音を鳴らす。
            if (playEndTone) await NativeAudioService.Instance.BeepEndAsync();

            string transcript = _latestPartialTranscript;
            if (_speechResultTcs != null)
            {
                try { transcript = await _speechResultTcs.Task.WaitAsync(TimeSpan.FromMilliseconds(1500)); }
                catch (TimeoutException) { }
            }

            var mode = AppConfig.RecordingMode;
            bool includeAudio = mode != "text_only";
            bool hasAudio = wavBytes is { Length: > 44 };
            bool hasTranscript = mode != "audio_only" && !string.IsNullOrWhiteSpace(transcript);
            return new RecordingResult
            {
                WavBytes = includeAudio && hasAudio ? wavBytes : null,
                Transcript = hasTranscript ? transcript : (includeAudio && hasAudio ? "🎤 音声メッセージ" : string.Empty),
                NeedsTranscription = includeAudio && hasAudio && (mode == "audio_only" || !hasTranscript)
            };
        }
        finally
        {
            ReleaseRecordingResources();
            _recordingLock.Release();
        }
    }

    public async Task CancelRecordingAsync() => await StopRecordingAsync(playEndTone: false);

    private void ReleaseRecordingResources()
    {
        IsRecording = false;
        NativeAudioService.Instance.StopSilentRecordingKeeper();
        try { _recordCts?.Cancel(); } catch (ObjectDisposedException) { }
        try { _audioRecord?.Stop(); } catch { }
        try { _audioRecord?.Release(); _audioRecord?.Dispose(); } catch { }
        _audioRecord = null;
        _recordLoopTask = null;
        _recordCts?.Dispose();
        _recordCts = null;
        ReleaseNoiseSuppressor();
        ClosePipe();
        CleanupSpeechRecognizerOnMainThread();
        AudioDeviceService.EndInputRouting();
        PttConnectionService.EndPttCall();
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
        var recognizer = _speechRecognizer;
        _speechRecognizer = null;
        _speechResultTcs = null;
        MainThread.BeginInvokeOnMainThread(() =>
        {
            try
            {
                recognizer?.Destroy();
                recognizer?.Dispose();
            }
            catch { }
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
