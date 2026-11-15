using Android.App;
using Android.Content;
using Android.OS;
using Android.Telecom;
using Java.Lang;

namespace Chatransceiver.Maui.Platforms.Android.Services;

/// <summary>
/// PttConnectionService
/// Bluetoothマイク (HFP/SCO) を使用したPTT録音中、Bluetoothイヤフォン本体は「電話通話中 (HFP)」モードに遷移し、
/// イヤフォンのボタン押下は AVRCP Play/Pause ではなく HFP の終話/フック信号 (AT+CHUP / AT+CHLD) として送出される。
/// Android OS は HFP 終話信号を TelecomManager 上のアクティブな Connection にのみ配送するため、
/// 録音中（最大15秒間）のみ Self-Managed Connection をアクティブ化してイヤフォンボタンによる録音停止を捕捉する。
/// </summary>
[Service(
    Name = "com.chatransceiver.app.Platforms.Android.Services.PttConnectionService",
    Permission = "android.permission.BIND_TELECOM_CONNECTION_SERVICE",
    Exported = true)]
[IntentFilter(new[] { "android.telecom.ConnectionService" })]
public class PttConnectionService : ConnectionService
{
    private const string AccountId = "ChatransceiverPttCall";
    private static readonly object SyncLock = new();
    private static PttConnection? _activeConnection;
    private static TaskCompletionSource<bool>? _connectTcs;
    private static bool _accountRegistered;
    private static long _callStartedMs;

    private static PhoneAccountHandle GetAccountHandle(Context context)
    {
        var component = new ComponentName(context, Class.FromType(typeof(PttConnectionService)));
        return new PhoneAccountHandle(component, AccountId);
    }

    public static void EnsurePhoneAccountRegistered(Context context)
    {
        if (!OperatingSystem.IsAndroidVersionAtLeast(26)) return;
        if (_accountRegistered) return;

        try
        {
            var tm = (TelecomManager?)context.GetSystemService(Context.TelecomService);
            if (tm == null) return;

            var handle = GetAccountHandle(context);
            var builder = PhoneAccount.InvokeBuilder(handle, "Chatransceiver PTT")
                ?.SetCapabilities((int)PhoneAccountCapability.SelfManaged);
            var account = builder?.Build();
            if (account != null)
            {
                tm.RegisterPhoneAccount(account);
                _accountRegistered = true;
            }
        }
        catch (System.Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"EnsurePhoneAccountRegistered error: {ex.Message}");
        }
    }

    /// <summary>
    /// Bluetoothマイク録音開始時に Self-Managed 通話セッションを開始し、HFP終話ボタンを捕捉可能にする
    /// </summary>
    public static async Task StartPttCallAsync()
    {
        if (!OperatingSystem.IsAndroidVersionAtLeast(26)) return;

        try
        {
            var context = global::Android.App.Application.Context;
            EnsurePhoneAccountRegistered(context);

            var tm = (TelecomManager?)context.GetSystemService(Context.TelecomService);
            if (tm == null) return;

            TaskCompletionSource<bool> tcs;
            lock (SyncLock)
            {
                CleanupActiveConnectionLocked();
                tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                _connectTcs = tcs;
                _callStartedMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }

            var handle = GetAccountHandle(context);
            var extras = new Bundle();
            tm.AddNewIncomingCall(handle, extras);

            await Task.WhenAny(tcs.Task, Task.Delay(400));
        }
        catch (System.Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"StartPttCallAsync error: {ex.Message}");
        }
    }

    /// <summary>
    /// 録音終了時に Self-Managed 通話セッションを終了・破棄する
    /// </summary>
    public static void EndPttCall()
    {
        lock (SyncLock)
        {
            CleanupActiveConnectionLocked();
        }
    }

    private static void CleanupActiveConnectionLocked()
    {
        var conn = _activeConnection;
        _activeConnection = null;
        _connectTcs?.TrySetResult(false);
        _connectTcs = null;

        if (conn != null)
        {
            try
            {
                conn.MarkLocalClosing();
                conn.SetDisconnected(new DisconnectCause(Causes.Local));
                conn.Destroy();
            }
            catch { }
        }
    }

    public override Connection OnCreateIncomingConnection(
        PhoneAccountHandle? connectionManagerPhoneAccount,
        ConnectionRequest? request)
    {
        return CreateAndActivatePttConnection();
    }

    public override Connection OnCreateOutgoingConnection(
        PhoneAccountHandle? connectionManagerPhoneAccount,
        ConnectionRequest? request)
    {
        return CreateAndActivatePttConnection();
    }

    private static Connection CreateAndActivatePttConnection()
    {
        var conn = new PttConnection();
        if (OperatingSystem.IsAndroidVersionAtLeast(26))
        {
            conn.ConnectionProperties = ConnectionProperties.SelfManaged;
        }
        conn.ConnectionCapabilities = ConnectionCapability.Hold | ConnectionCapability.SupportHold;
        conn.SetInitializing();
        conn.SetActive();

        try
        {
            if (OperatingSystem.IsAndroidVersionAtLeast(26))
            {
#pragma warning disable CA1422
                conn.SetAudioRoute(CallAudioRoute.Bluetooth);
#pragma warning restore CA1422
            }
            var preferredIn = AudioDeviceService.FindPreferredInputDevice();
            if (preferredIn != null)
            {
                AudioDeviceService.BeginInputRouting(preferredIn);
            }
        }
        catch { }

        lock (SyncLock)
        {
            _activeConnection = conn;
            _callStartedMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            _connectTcs?.TrySetResult(true);
        }

        return conn;
    }

    internal static void OnHeadsetCallButtonAction(PttConnection source)
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        lock (SyncLock)
        {
            // 接続直後の初期状態遷移ノイズを無視
            if (now - _callStartedMs < 300) return;
            if (ReferenceEquals(_activeConnection, source))
            {
                _activeConnection = null;
            }
        }

        try
        {
            source.SetDisconnected(new DisconnectCause(Causes.Remote));
            source.Destroy();
        }
        catch { }

        if (NativeRecordingService.Instance.IsRecording)
        {
            TransceiverForegroundService.TryHandleMediaButtonToggle();
        }
    }

    internal sealed class PttConnection : Connection
    {
        private bool _isLocalClosing;

        public void MarkLocalClosing() => _isLocalClosing = true;

        private void HandleRemoteButtonIfNotClosing()
        {
            if (_isLocalClosing) return;
            _isLocalClosing = true;
            OnHeadsetCallButtonAction(this);
        }

        public override void OnDisconnect() => HandleRemoteButtonIfNotClosing();

        public override void OnHold() => HandleRemoteButtonIfNotClosing();

        public override void OnUnhold() => HandleRemoteButtonIfNotClosing();

        public override void OnAnswer() => HandleRemoteButtonIfNotClosing();

        public override void OnReject() => HandleRemoteButtonIfNotClosing();

        public override void OnAbort() => HandleRemoteButtonIfNotClosing();
    }
}
