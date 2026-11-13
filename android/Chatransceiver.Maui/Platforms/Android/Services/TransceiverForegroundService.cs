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

    public static bool IsRunning { get; private set; }
    public static event Action<bool>? ServiceStateChanged;
    public static event Action? PttMessageSentFromBackground;

    private MediaSession? _mediaSession;
    private long _lastButtonPressMs;
    private const long DebounceMs = 600;

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
        CreateNotificationChannel();
        SetupMediaSession();
        NativeRecordingService.Instance.AutoTimeoutReached += OnRecordingAutoTimeout;
    }

    public override StartCommandResult OnStartCommand(Intent? intent, StartCommandFlags flags, int startId)
    {
        var notification = BuildNotification("🎧 イヤフォンボタンPTT待機中 (ボタンで録音開始)");
        if (Build.VERSION.SdkInt >= BuildVersionCodes.UpsideDownCake)
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
        ServiceStateChanged?.Invoke(true);
        return StartCommandResult.Sticky;
    }

    public override void OnDestroy()
    {
        NativeRecordingService.Instance.AutoTimeoutReached -= OnRecordingAutoTimeout;
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
        _mediaSession = new MediaSession(this, "ChatransceiverMediaSession");
        _mediaSession.SetCallback(new PttMediaSessionCallback(this));

        var stateBuilder = new PlaybackState.Builder()
            .SetActions(
                PlaybackState.ActionPlay |
                PlaybackState.ActionPause |
                PlaybackState.ActionPlayPause |
                PlaybackState.ActionStop)
            .SetState(PlaybackStateCode.Playing, 0, 1.0f);
        _mediaSession.SetPlaybackState(stateBuilder.Build());
        _mediaSession.Active = true;

        // Android OS にメディアボタンルーティング権を認識させるため、初回のみ極短の無音パルスを1回流す
        NativeAudioService.Instance.BeepStart();
    }

    private async void HandleMediaButtonToggleAsync()
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (now - _lastButtonPressMs < DebounceMs) return;
        _lastButtonPressMs = now;

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

            bool started = await NativeRecordingService.Instance.StartRecordingAsync();
            if (started)
            {
                UpdateNotification($"🔴 録音中... ({AppConfig.ActiveRoomTitle ?? "チャット"}) もう一度押すと送信");
            }
            else
            {
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
        try
        {
            var result = await NativeRecordingService.Instance.StopRecordingAsync();
            NativeAudioService.Instance.BeepEnd();
            UpdateNotification("📤 メッセージ送信中...");

            if (result.WavBytes != null || !string.IsNullOrWhiteSpace(result.Transcript))
            {
                await SupabaseClientService.Instance.SendMessageAsync(
                    roomId,
                    userId,
                    result.Transcript,
                    result.WavBytes,
                    result.NeedsTranscription);

                MainThread.BeginInvokeOnMainThread(() => PttMessageSentFromBackground?.Invoke());
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
            AudioPlaybackQueue.Instance.Resume();
            NativeAudioService.Instance.ReleaseWakeLock();
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

    private sealed class PttMediaSessionCallback : MediaSession.Callback
    {
        private readonly TransceiverForegroundService _service;

        public PttMediaSessionCallback(TransceiverForegroundService service)
        {
            _service = service;
        }

        public override bool OnMediaButtonEvent(Intent mediaButtonIntent)
        {
            var keyEvent = (KeyEvent?)mediaButtonIntent.GetParcelableExtra(Intent.ExtraKeyEvent);
            if (keyEvent != null && keyEvent.Action == KeyEventActions.Down)
            {
                if (keyEvent.KeyCode == Keycode.MediaPlayPause ||
                    keyEvent.KeyCode == Keycode.MediaPlay ||
                    keyEvent.KeyCode == Keycode.MediaPause ||
                    keyEvent.KeyCode == Keycode.Headsethook)
                {
                    _service.HandleMediaButtonToggleAsync();
                    return true;
                }
            }
            return base.OnMediaButtonEvent(mediaButtonIntent);
        }

        public override void OnPlay() => _service.HandleMediaButtonToggleAsync();
        public override void OnPause() => _service.HandleMediaButtonToggleAsync();
    }
}
