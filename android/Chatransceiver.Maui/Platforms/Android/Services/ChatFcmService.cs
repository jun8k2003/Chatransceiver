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
    private const string MsgChannelId = "chatransceiver_messages_channel";

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

        // 1. システム通知を表示
        ShowSystemNotification(
            $"[新着] {senderName} ({communityName})",
            messageType == "audio" ? "🎤 音声メッセージ" : (textContent ?? "新しいメッセージ"));

        // 2. ロック画面・DeepSleep中の自動再生 (AutoPlayEnabled が ON の場合)
        if (AppConfig.AutoPlayEnabled)
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

    private void ShowSystemNotification(string title, string body)
    {
        try
        {
            if (Build.VERSION.SdkInt >= BuildVersionCodes.O)
            {
                var channel = new NotificationChannel(
                    MsgChannelId,
                    "新着メッセージ通知",
                    NotificationImportance.High);
                var nm = (NotificationManager?)GetSystemService(NotificationService);
                nm?.CreateNotificationChannel(channel);
            }

            var openIntent = new Intent(this, typeof(MainActivity));
            openIntent.SetFlags(ActivityFlags.SingleTop | ActivityFlags.ClearTop);
            var pendingIntent = PendingIntent.GetActivity(
                this,
                1,
                openIntent,
                PendingIntentFlags.UpdateCurrent | PendingIntentFlags.Immutable);

            var notification = new NotificationCompat.Builder(this, MsgChannelId)
                .SetContentTitle(title)
                .SetContentText(body)
                .SetSmallIcon(global::Android.Resource.Drawable.SymActionChat)
                .SetAutoCancel(true)
                .SetPriority(NotificationCompat.PriorityHigh)
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
