using Android.App;
using Android.Content;
using Android.Content.PM;
using Android.Media;
using Android.Media.Session;
using Android.OS;
using Android.Views;
using AndroidX.Core.App;
using Chatransceiver.Maui.Services;

namespace Chatransceiver.Maui.Platforms.Android.Services;

/// <summary>
/// TransceiverForegroundService (specifications.md §8.4)
/// - 画面ロック（DeepSleep）中もイヤフォンの Play/Pause ボタン押下を MediaSession で捕捉し、
///   1回目押下=録音開始(上昇ビープ)、2回目押下または15秒経過=停止+自動送信(下降ビープ) を行う。
/// - Web版 (DEC-027) のような微小ノイズ連続再生は不要（待機中はCPU・オーディオともにスリープ可）。
/// </summary>
[Service(
    Name = "com.chatransceiver.app.Platforms.Android.Services.TransceiverForegroundService",
    Enabled = true,
    Exported = false,
    ForegroundServiceType = ForegroundService.TypeMediaPlayback | ForegroundService.TypeMicrophone)]
public class TransceiverForegroundService : Service
{
    public const string ChannelId = "chatransceiver_ptt_channel";
    public const int NotificationId = 2001;

    private static TransceiverForegroundService? _instance;
    private static long _lastButtonPressMs;
    private const long DebounceMs = 350;

    public static bool IsRunning { get; private set; }
    public static event Action<bool>? ServiceStateChanged;
    public static event Action? PttMessageSentFromBackground;

    /// <summary>
    /// 画面上の🎤ボタン（録音モーダル表示中）で開始された録音をイヤフォンのPlay/Pauseボタンで停止・送信するためのフック
    /// </summary>
    public static event Func<Task<bool>>? ForegroundUiStopRecordingRequested;

    private MediaSession? _mediaSession;
    private AudioFocusRequestClass? _audioFocusRequest;
    private PttAudioFocusListener? _audioFocusListener;
    private bool _isStoppingAndSending;

    public static bool IsPttKey(Keycode keyCode, bool isRecording)
    {
        if (keyCode is Keycode.MediaPlayPause
            or Keycode.MediaPlay
            or Keycode.MediaPause
            or Keycode.Headsethook
            or Keycode.MediaStop)
        {
            return true;
        }

        // Bluetooth HFP/SCO 通話モード (Mode.InCommunication) での録音中は、
        // イヤフォン側のPlay/Pauseボタンがフック/終話キーとして送出される機種に対応する
        if (isRecording && keyCode is Keycode.Call or Keycode.Endcall)
        {
            return true;
        }

        return false;
    }

    /// <summary>
    /// MainActivity (フォアグラウンド表示中) または MediaSession からメディアボタン押下を処理する
    /// </summary>
    public static bool TryHandleMediaButtonToggle()
    {
        if (!IsRunning && !NativeRecordingService.Instance.IsRecording)
        {
            return false;
        }

        if (_instance != null)
        {
            _instance.HandleMediaButtonToggleAsync();
            return true;
        }

        if (NativeRecordingService.Instance.IsRecording && ForegroundUiStopRecordingRequested != null)
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (now - _lastButtonPressMs < DebounceMs) return true;
            _lastButtonPressMs = now;
            _ = MainThread.InvokeOnMainThreadAsync(async () =>
            {
                await ForegroundUiStopRecordingRequested.Invoke();
            });
            return true;
        }

        return false;
    }

    public static void Start(Context context)
    {
        var intent = new Intent(context, typeof(TransceiverForegroundService));
        if (Build.VERSION.SdkInt >= BuildVersionCodes.O)
        {
            context.StartForegroundService(intent);
        }
        else
        {
            context.StartService(intent);
        }
    }

    public static void Stop(Context context)
    {
        var intent = new Intent(context, typeof(TransceiverForegroundService));
        context.StopService(intent);
    }

    public override IBinder? OnBind(Intent? intent) => null;

    public override void OnCreate()
    {
        base.OnCreate();
        _instance = this;
        PttConnectionService.EnsurePhoneAccountRegistered(this);
        CreateNotificationChannel();
        SetupMediaSession();
        NativeRecordingService.Instance.AutoTimeoutReached += OnRecordingAutoTimeout;
    }

    public override StartCommandResult OnStartCommand(Intent? intent, StartCommandFlags flags, int startId)
    {
        var notification = BuildNotification("🎧 イヤフォンボタンPTT待機中 (ボタンで録音開始)");
        if (OperatingSystem.IsAndroidVersionAtLeast(34))
        {
            StartForeground(
                NotificationId,
                notification,
                ForegroundService.TypeMediaPlayback | ForegroundService.TypeMicrophone);
        }
        else
        {
            StartForeground(NotificationId, notification);
        }

        IsRunning = true;
        RefreshMediaSessionState();
        ServiceStateChanged?.Invoke(true);
        return StartCommandResult.Sticky;
    }

    public override void OnDestroy()
    {
        NativeRecordingService.Instance.AutoTimeoutReached -= OnRecordingAutoTimeout;
        NativeAudioService.Instance.StopSilentRecordingKeeper();
        AbandonMediaAudioFocus();
        if (ReferenceEquals(_instance, this))
        {
            _instance = null;
        }
        IsRunning = false;
        ServiceStateChanged?.Invoke(false);

        try
        {
            if (_mediaSession != null)
            {
                _mediaSession.Active = false;
                _mediaSession.Release();
                _mediaSession.Dispose();
                _mediaSession = null;
            }
        }
        catch { }

        base.OnDestroy();
    }

    private void SetupMediaSession()
    {
        RequestMediaAudioFocus();

        _mediaSession = new MediaSession(this, "ChatransceiverMediaSession");
        _mediaSession.SetCallback(new PttMediaSessionCallback(this));
        RefreshMediaSessionState();

        // Android OS にメディアボタンルーティング権を認識させるため、初回のみ極短のビープ音を1回流す
        NativeAudioService.Instance.BeepStart();
    }

    private void RefreshMediaSessionState()
    {
        if (_mediaSession == null) return;
        try
        {
            var stateBuilder = new PlaybackState.Builder()
                .SetActions(
                    PlaybackState.ActionPlay |
                    PlaybackState.ActionPause |
                    PlaybackState.ActionPlayPause |
                    PlaybackState.ActionStop)!
                .SetState(PlaybackStateCode.Playing, 0, 1.0f, SystemClock.ElapsedRealtime())!;
            _mediaSession.SetPlaybackState(stateBuilder.Build());
            _mediaSession.Active = true;
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"RefreshMediaSessionState error: {ex.Message}");
        }
    }

    private void RequestMediaAudioFocus()
    {
        try
        {
            var am = (AudioManager?)GetSystemService(AudioService);
            if (am == null) return;

            _audioFocusListener ??= new PttAudioFocusListener(this);

            if (Build.VERSION.SdkInt >= BuildVersionCodes.O)
            {
                var attrs = new AudioAttributes.Builder()
                    ?.SetUsage(AudioUsageKind.Media)
                    ?.SetContentType(AudioContentType.Speech)
                    ?.Build();
                if (attrs != null)
                {
                    _audioFocusRequest ??= new AudioFocusRequestClass.Builder(AudioFocus.Gain)
                        .SetAudioAttributes(attrs)!
                        .SetAcceptsDelayedFocusGain(true)!
                        .SetWillPauseWhenDucked(false)!
                        .SetOnAudioFocusChangeListener(_audioFocusListener)!
                        .Build();
                    if (_audioFocusRequest != null)
                    {
                        am.RequestAudioFocus(_audioFocusRequest);
                    }
                }
            }
            else
            {
#pragma warning disable CS0618, CA1422
                am.RequestAudioFocus(_audioFocusListener, global::Android.Media.Stream.Music, AudioFocus.Gain);
#pragma warning restore CS0618, CA1422
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"RequestMediaAudioFocus error: {ex.Message}");
        }
    }

    private void AbandonMediaAudioFocus()
    {
        try
        {
            var am = (AudioManager?)GetSystemService(AudioService);
            if (am == null) return;

            if (Build.VERSION.SdkInt >= BuildVersionCodes.O && _audioFocusRequest != null)
            {
                am.AbandonAudioFocusRequest(_audioFocusRequest);
            }
            else if (_audioFocusListener != null)
            {
#pragma warning disable CS0618, CA1422
                am.AbandonAudioFocus(_audioFocusListener);
#pragma warning restore CS0618, CA1422
            }
        }
        catch { }
    }

    private async void HandleMediaButtonToggleAsync()
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (now - _lastButtonPressMs < DebounceMs) return;
        _lastButtonPressMs = now;

        if (_isStoppingAndSending) return;

        // 画面上の🎤ボタン（録音モーダル表示中）で録音が開始されていた場合はUI側で停止・送信する
        if (NativeRecordingService.Instance.IsRecording && ForegroundUiStopRecordingRequested != null)
        {
            bool handledByUi = await MainThread.InvokeOnMainThreadAsync(() => ForegroundUiStopRecordingRequested.Invoke());
            if (handledByUi)
            {
                RefreshMediaSessionState();
                return;
            }
        }

        var roomId = AppConfig.ActiveRoomId;
        var userId = AppConfig.CurrentUserId;

        if (string.IsNullOrEmpty(roomId) || string.IsNullOrEmpty(userId))
        {
            NativeAudioService.Instance.BeepError();
            UpdateNotification("⚠️ 送信先チャットを選択してください");
            return;
        }

        if (!NativeRecordingService.Instance.IsRecording)
        {
            // 1回目押下: 録音開始
            NativeAudioService.Instance.AcquireWakeLock(25000);
            AudioPlaybackQueue.Instance.Pause();
            NativeAudioService.Instance.BeepStart();
            NativeAudioService.Instance.StartSilentRecordingKeeper();

            bool started = await NativeRecordingService.Instance.StartRecordingAsync();
            if (started)
            {
                UpdateNotification($"🔴 録音中... ({AppConfig.ActiveRoomTitle ?? "チャット"}) もう一度押すと送信");
                RefreshMediaSessionState();

                // SpeechRecognizer 起動時のシステム側フォーカス変化後に MediaSession の優先権を再アサートする
                _ = ReassertMediaSessionDuringRecordingAsync();
            }
            else
            {
                NativeAudioService.Instance.StopSilentRecordingKeeper();
                NativeAudioService.Instance.BeepError();
                AudioPlaybackQueue.Instance.Resume();
                NativeAudioService.Instance.ReleaseWakeLock();
            }
        }
        else
        {
            // 2回目押下: 録音停止 + 自動送信
            await StopAndSendAsync(roomId, userId);
        }
    }

    private async Task ReassertMediaSessionDuringRecordingAsync()
    {
        try
        {
            await Task.Delay(250);
            if (NativeRecordingService.Instance.IsRecording)
            {
                RefreshMediaSessionState();
            }

            await Task.Delay(350);
            if (NativeRecordingService.Instance.IsRecording)
            {
                RefreshMediaSessionState();
            }
        }
        catch { }
    }

    private async void OnRecordingAutoTimeout()
    {
        if (!IsRunning || !NativeRecordingService.Instance.IsRecording) return;
        var roomId = AppConfig.ActiveRoomId;
        var userId = AppConfig.CurrentUserId;
        if (!string.IsNullOrEmpty(roomId) && !string.IsNullOrEmpty(userId))
        {
            await StopAndSendAsync(roomId, userId);
        }
    }

    private async Task StopAndSendAsync(string roomId, string userId)
    {
        if (_isStoppingAndSending) return;
        _isStoppingAndSending = true;

        try
        {
            NativeAudioService.Instance.StopSilentRecordingKeeper();
            var result = await NativeRecordingService.Instance.StopRecordingAsync();
            NativeAudioService.Instance.BeepEnd();
            UpdateNotification("📤 メッセージ送信中...");

            if (result.WavBytes != null || !string.IsNullOrWhiteSpace(result.Transcript))
            {
                var sent = await SupabaseClientService.Instance.SendMessageAsync(
                    roomId,
                    userId,
                    result.Transcript,
                    result.WavBytes,
                    result.NeedsTranscription);

                MainThread.BeginInvokeOnMainThread(() => PttMessageSentFromBackground?.Invoke());

                if (AppConfig.EchoSentEnabled)
                {
                    AudioPlaybackQueue.Instance.EnqueueMessage(sent);
                }
            }

            UpdateNotification($"🎧 PTT待機中 ({AppConfig.ActiveRoomTitle ?? "送信準備OK"})");
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"StopAndSendAsync error: {ex.Message}");
            NativeAudioService.Instance.BeepError();
            UpdateNotification("⚠️ 送信に失敗しました");
        }
        finally
        {
            _isStoppingAndSending = false;
            NativeAudioService.Instance.StopSilentRecordingKeeper();
            RequestMediaAudioFocus();
            RefreshMediaSessionState();
            NativeAudioService.Instance.ReleaseWakeLock();
            AudioPlaybackQueue.Instance.Resume();
        }
    }

    private void CreateNotificationChannel()
    {
        if (Build.VERSION.SdkInt >= BuildVersionCodes.O)
        {
            var channel = new NotificationChannel(
                ChannelId,
                "Chatransceiver PTT待機",
                NotificationImportance.Low)
            {
                Description = "イヤフォンボタンでのPTT発話およびロック画面自動再生の待機状態を表示します"
            };
            var nm = (NotificationManager?)GetSystemService(NotificationService);
            nm?.CreateNotificationChannel(channel);
        }
    }

    private Notification BuildNotification(string statusText)
    {
        var openIntent = new Intent(this, typeof(MainActivity));
        openIntent.SetFlags(ActivityFlags.SingleTop | ActivityFlags.ClearTop);
        var pendingIntent = PendingIntent.GetActivity(
            this,
            0,
            openIntent,
            PendingIntentFlags.UpdateCurrent | PendingIntentFlags.Immutable);

        return new NotificationCompat.Builder(this, ChannelId)
            .SetContentTitle("Chatransceiver")
            .SetContentText(statusText)
            .SetSmallIcon(global::Android.Resource.Drawable.SymActionChat)
            .SetContentIntent(pendingIntent)
            .SetOngoing(true)
            .Build();
    }

    private void UpdateNotification(string statusText)
    {
        var nm = (NotificationManager?)GetSystemService(NotificationService);
        nm?.Notify(NotificationId, BuildNotification(statusText));
    }

    private sealed class PttAudioFocusListener : Java.Lang.Object, AudioManager.IOnAudioFocusChangeListener
    {
        private readonly TransceiverForegroundService _service;

        public PttAudioFocusListener(TransceiverForegroundService service)
        {
            _service = service;
        }

        public void OnAudioFocusChange(AudioFocus focusChange)
        {
            // SpeechRecognizer 起動等によってフォーカスが変化した直後に MediaSession の再生状態を更新し、
            // 2回目の Play/Pause ボタン配送先から外されないようにする（AudioFocus自体は奪い返さないため音声認識を阻害しない）
            _service.RefreshMediaSessionState();
        }
    }

    private sealed class PttMediaSessionCallback : MediaSession.Callback
    {
        private readonly TransceiverForegroundService _service;

        public PttMediaSessionCallback(TransceiverForegroundService service)
        {
            _service = service;
        }

        public override bool OnMediaButtonEvent(Intent mediaButtonIntent)
        {
            KeyEvent? keyEvent = OperatingSystem.IsAndroidVersionAtLeast(33)
                ? (KeyEvent?)mediaButtonIntent.GetParcelableExtra(Intent.ExtraKeyEvent, Java.Lang.Class.FromType(typeof(KeyEvent)))
                : (KeyEvent?)mediaButtonIntent.GetParcelableExtra(Intent.ExtraKeyEvent);
            if (keyEvent != null && IsPttKey(keyEvent.KeyCode, NativeRecordingService.Instance.IsRecording))
            {
                if (keyEvent.Action == KeyEventActions.Down && keyEvent.RepeatCount == 0)
                {
                    _service.HandleMediaButtonToggleAsync();
                }
                // Down / Up ともに消費し、base.OnMediaButtonEvent の遅延シングルタップ処理による二重発火を防ぐ
                return true;
            }
            return base.OnMediaButtonEvent(mediaButtonIntent);
        }

        public override void OnPlay() => _service.HandleMediaButtonToggleAsync();
        public override void OnPause() => _service.HandleMediaButtonToggleAsync();
        public override void OnStop() => _service.HandleMediaButtonToggleAsync();
    }
}
