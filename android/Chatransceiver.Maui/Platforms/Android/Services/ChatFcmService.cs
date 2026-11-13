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

    private void ShowSystemNotification(string title, string body, bool silent)
    {
        try
        {
            string channelId = silent ? SilentMsgChannelId : SoundMsgChannelId;

            if (OperatingSystem.IsAndroidVersionAtLeast(26))
            {
                var nm = (NotificationManager?)GetSystemService(NotificationService);
                if (nm != null)
                {
                    if (silent)
                    {
                        var silentChannel = new NotificationChannel(
                            SilentMsgChannelId,
                            "新着メッセージ通知（自動再生時・無音）",
                            NotificationImportance.Default);
                        silentChannel.SetSound(null, null);
                        silentChannel.EnableVibration(false);
                        nm.CreateNotificationChannel(silentChannel);
                    }
                    else
                    {
                        var soundChannel = new NotificationChannel(
                            SoundMsgChannelId,
                            "新着メッセージ通知（自動再生OFF時・通知音あり）",
                            NotificationImportance.High);
                        nm.CreateNotificationChannel(soundChannel);
                    }
                }
            }

            var openIntent = new Intent(this, typeof(MainActivity));
            openIntent.SetFlags(ActivityFlags.SingleTop | ActivityFlags.ClearTop);
            var pendingIntent = PendingIntent.GetActivity(
                this,
                1,
                openIntent,
                PendingIntentFlags.UpdateCurrent | PendingIntentFlags.Immutable);

            var notification = new NotificationCompat.Builder(this, channelId)
                .SetContentTitle(title)
                .SetContentText(body)
                .SetSmallIcon(global::Android.Resource.Drawable.SymActionChat)
                .SetAutoCancel(true)
                .SetSilent(silent)
                .SetPriority(silent ? NotificationCompat.PriorityDefault : NotificationCompat.PriorityHigh)
                .SetContentIntent(pendingIntent)
                .Build();

            var manager = NotificationManagerCompat.From(this);
            manager.Notify(Random.Shared.Next(3000, 9999), notification);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"ShowSystemNotification error: {ex.Message}");
        }
    }
}
