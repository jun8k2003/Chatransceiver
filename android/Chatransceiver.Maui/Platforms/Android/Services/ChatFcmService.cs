using Android.App;
using Android.Content;
using Android.OS;
using AndroidX.Core.App;
using Chatransceiver.Maui.Models;
using Chatransceiver.Maui.Services;
using Firebase.Messaging;

namespace Chatransceiver.Maui.Platforms.Android.Services;

/// <summary>
/// ChatFcmService (specifications.md §8.3)
/// - DeepSleep（Doze）中に send-push-notification からの高優先度FCMデータメッセージで起床する。
/// - 自動再生がONの場合、画面ロックのまま NativeAudioService の一時 WakeLock を取得し、
///   AudioPlaybackQueue に投入して音声またはネイティブTTSを直接再生する。
/// </summary>
[Service(
    Name = "com.chatransceiver.app.Platforms.Android.Services.ChatFcmService",
    Exported = false)]
[IntentFilter(new[] { "com.google.firebase.MESSAGING_EVENT" })]
public class ChatFcmService : FirebaseMessagingService
{
    private const string SilentMsgChannelId = "chatransceiver_messages_silent";
    private const string SoundMsgChannelId = "chatransceiver_messages_sound";
    private const string SilentMsgNoBadgeChannelId = "chatransceiver_messages_silent_nobadge";
    private const string SoundMsgNoBadgeChannelId = "chatransceiver_messages_sound_nobadge";

    public override void OnNewToken(string token)
    {
        base.OnNewToken(token);
        AppConfig.PendingFcmToken = token;

        if (AppConfig.FcmRegistered && !string.IsNullOrEmpty(AppConfig.AccessToken))
        {
            _ = SupabaseClientService.Instance.RegisterFcmTokenAsync(token);
        }
    }

    public override void OnMessageReceived(RemoteMessage message)
    {
        base.OnMessageReceived(message);

        var data = message.Data;
        if (data == null || data.Count == 0) return;

        data.TryGetValue("messageId", out var messageId);
        data.TryGetValue("senderName", out var senderName);
        data.TryGetValue("communityName", out var communityName);
        data.TryGetValue("messageType", out var messageType);
        data.TryGetValue("textContent", out var textContent);
        data.TryGetValue("audioUrl", out var audioUrl);

        senderName = string.IsNullOrEmpty(senderName) ? "メンバー" : senderName;
        communityName = string.IsNullOrEmpty(communityName) ? "Chatransceiver" : communityName;
        messageType = string.IsNullOrEmpty(messageType) ? "text" : messageType;

        bool autoPlay = AppConfig.AutoPlayEnabled;

        // 1. システム通知を表示 (自動再生ON時は通知音を消してコールサイン音との被り・音量低下を防止、OFF時は通知音を鳴らす)
        ShowSystemNotification(
            $"[新着] {senderName} ({communityName})",
            messageType == "audio" ? "🎤 音声メッセージ" : (textContent ?? "新しいメッセージ"),
            silent: autoPlay);

        // 2. ロック画面・DeepSleep中の自動再生 (AutoPlayEnabled が ON の場合)
        if (autoPlay)
        {
            NativeAudioService.Instance.AcquireWakeLock(45000);

            var contentToPlay = messageType == "audio" && !string.IsNullOrEmpty(audioUrl)
                ? audioUrl
                : (textContent ?? string.Empty);

            if (!string.IsNullOrEmpty(contentToPlay))
            {
                AudioPlaybackQueue.Instance.Enqueue(new QueueItem
                {
                    Id = messageId ?? Guid.NewGuid().ToString("N"),
                    Type = messageType == "audio" && !string.IsNullOrEmpty(audioUrl) ? "audio" : "text",
                    Content = contentToPlay,
                    SenderName = senderName
                });
            }
        }
    }

    /// <summary>
    /// バッジ表示が有効な旧チャンネルの通知を消去し、ランチャーのアプリアイコンバッジを残さないようにする。
    /// </summary>
    public static void ClearBadgeEnabledNotifications(Context context)
    {
        if (!OperatingSystem.IsAndroidVersionAtLeast(26)) return;
        try
        {
            var nm = (NotificationManager?)context.GetSystemService(NotificationService);
            if (nm == null) return;

            foreach (var sbn in nm.GetActiveNotifications() ?? [])
            {
                var chId = sbn.Notification?.ChannelId;
                if (chId == SilentMsgChannelId || chId == SoundMsgChannelId)
                {
                    nm.Cancel(sbn.Tag, sbn.Id);
                }
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"ClearBadgeEnabledNotifications error: {ex.Message}");
        }
    }

    private void EnsureNotificationChannel(NotificationManager nm, string channelId, bool silent, bool showBadge)
    {
        if (!OperatingSystem.IsAndroidVersionAtLeast(26)) return;

        string suffix = showBadge ? string.Empty : "（バッジなし）";
        string channelName = silent
            ? $"新着メッセージ通知（自動再生時・無音）{suffix}"
            : $"新着メッセージ通知（自動再生OFF時・通知音あり）{suffix}";
        var importance = silent ? NotificationImportance.Default : NotificationImportance.High;

        var channel = new NotificationChannel(channelId, channelName, importance);
        channel.SetShowBadge(showBadge);
        if (silent)
        {
            channel.SetSound(null, null);
            channel.EnableVibration(false);
        }
        nm.CreateNotificationChannel(channel);
    }

    private void ShowSystemNotification(string title, string body, bool silent)
    {
        try
        {
            bool showBadge = AppConfig.UnreadBadgeEnabled;
            string channelId = (silent, showBadge) switch
            {
                (true, true) => SilentMsgChannelId,
                (true, false) => SilentMsgNoBadgeChannelId,
                (false, true) => SoundMsgChannelId,
                (false, false) => SoundMsgNoBadgeChannelId,
            };

            if (OperatingSystem.IsAndroidVersionAtLeast(26))
            {
                var nm = (NotificationManager?)GetSystemService(NotificationService);
                if (nm != null)
                {
                    EnsureNotificationChannel(nm, channelId, silent, showBadge);
                }
            }

            var openIntent = new Intent(this, typeof(MainActivity));
            openIntent.SetFlags(ActivityFlags.SingleTop | ActivityFlags.ClearTop);
            var pendingIntent = PendingIntent.GetActivity(
                this,
                1,
                openIntent,
                PendingIntentFlags.UpdateCurrent | PendingIntentFlags.Immutable);

            var builder = new NotificationCompat.Builder(this, channelId)
                .SetContentTitle(title)
                .SetContentText(body)
                .SetSmallIcon(global::Android.Resource.Drawable.SymActionChat)
                .SetAutoCancel(true)
                .SetSilent(silent)
                .SetPriority(silent ? NotificationCompat.PriorityDefault : NotificationCompat.PriorityHigh)
                .SetContentIntent(pendingIntent);

            if (!showBadge)
            {
                builder.SetNumber(0);
            }

            var notification = builder.Build();

            var manager = NotificationManagerCompat.From(this);
            manager.Notify(Random.Shared.Next(3000, 9999), notification);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"ShowSystemNotification error: {ex.Message}");
        }
    }
}
