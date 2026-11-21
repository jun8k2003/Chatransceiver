using Android.App;
using Android.Content;
using Android.OS;
using Android.Telecom;
using Java.Lang;
using Presentation = Android.Telecom.Presentation;

namespace Chatransceiver.Maui.Platforms.Android.Services;

/// <summary>
/// PTT中だけ自己管理の発信通話を登録し、Bluetoothの終話ボタンを受け取る。
/// 作成コールバックでは接続を返すだけにし、Telecomからの通知後にActiveへ移す。
/// https://developer.android.com/reference/android/telecom/ConnectionService
/// </summary>
[Service(
    Name = "com.chatransceiver.app.Platforms.Android.Services.PttConnectionService",
    Permission = "android.permission.BIND_TELECOM_CONNECTION_SERVICE",
    Exported = true)]
[IntentFilter(new[] { "android.telecom.ConnectionService" })]
public class PttConnectionService : ConnectionService
{
    private const string AccountId = "ChatransceiverPttCall";
    private const string PttScheme = "chatransceiver-ptt";
    private static readonly object SyncLock = new();
    private static PttConnection? _activeConnection;
    private static TaskCompletionSource<bool>? _connectTcs;
    private static string? _requestId;
    private static bool _accountRegistered;
    private bool _hasCallFocus;

    private static PhoneAccountHandle GetAccountHandle(Context context) =>
        new(new ComponentName(context, Class.FromType(typeof(PttConnectionService))), AccountId);

    public static void EnsurePhoneAccountRegistered(Context context)
    {
        if (_accountRegistered) return;
        try
        {
            var tm = (TelecomManager?)context.GetSystemService(Context.TelecomService);
            if (tm == null) return;
            var account = PhoneAccount.InvokeBuilder(GetAccountHandle(context), "Chatransceiver PTT")
                ?.SetCapabilities((int)PhoneAccountCapability.SelfManaged)
                ?.SetSupportedUriSchemes(new[] { PttScheme })
                ?.Build();
            if (account == null) return;
            tm.RegisterPhoneAccount(account);
            _accountRegistered = true;
        }
        catch (System.Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"RegisterPttPhoneAccount failed: {ex.Message}");
        }
    }

    public static async Task<bool> StartPttCallAsync(CancellationToken token = default)
    {
        var requestId = Guid.NewGuid().ToString("N");
        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (SyncLock)
        {
            CleanupActiveConnectionLocked();
            _requestId = requestId;
            _connectTcs = tcs;
        }

        try
        {
            await MainThread.InvokeOnMainThreadAsync(() =>
            {
                token.ThrowIfCancellationRequested();
                var context = global::Android.App.Application.Context;
                EnsurePhoneAccountRegistered(context);
                if (!_accountRegistered) throw new InvalidOperationException("PTT phone account registration failed.");
                var tm = (TelecomManager?)context.GetSystemService(Context.TelecomService)
                    ?? throw new InvalidOperationException("Telecom service is unavailable.");
                var extras = new Bundle();
                extras.PutParcelable(TelecomManager.ExtraPhoneAccountHandle, GetAccountHandle(context));
                // 専用URI + 自己管理PhoneAccountなので、電話番号への発信は行わない。
                tm.PlaceCall(global::Android.Net.Uri.FromParts(PttScheme, requestId, null), extras);
            });

            if (await tcs.Task.WaitAsync(TimeSpan.FromSeconds(8), token)) return true;
        }
        catch (System.Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"StartPttCallAsync failed: {ex.Message}");
        }

        lock (SyncLock)
        {
            if (_requestId == requestId) CleanupActiveConnectionLocked();
        }
        return false;
    }

    public static void EndPttCall()
    {
        lock (SyncLock) CleanupActiveConnectionLocked();
    }

    private static void CleanupActiveConnectionLocked()
    {
        var connection = _activeConnection;
        _activeConnection = null;
        _requestId = null;
        _connectTcs?.TrySetResult(false);
        _connectTcs = null;
        connection?.CloseLocally();
    }

    public override Connection OnCreateIncomingConnection(
        PhoneAccountHandle? connectionManagerPhoneAccount, ConnectionRequest? request) =>
        Connection.CreateFailedConnection(new DisconnectCause(Causes.Rejected))!;

    public override Connection OnCreateOutgoingConnection(
        PhoneAccountHandle? connectionManagerPhoneAccount, ConnectionRequest? request)
    {
        lock (SyncLock)
        {
            // 中止・タイムアウト後に届いた作成通知を、新しい録音へ結び付けない。
            if (_connectTcs == null || request?.Address?.Scheme != PttScheme ||
                request.Address.SchemeSpecificPart != _requestId || _activeConnection != null)
                return Connection.CreateFailedConnection(new DisconnectCause(Causes.Canceled))!;

            var connection = new PttConnection(this)
            {
                ConnectionProperties = ConnectionProperties.SelfManaged,
                AudioModeIsVoip = true
            };
            connection.SetAddress(request.Address, Presentation.Allowed);
            connection.SetCallerDisplayName("Chatransceiver PTT", Presentation.Allowed);
            connection.SetDialing();
            _activeConnection = connection;
            // SetActive、ルート操作、完了通知はここでは実行しない。
            return connection;
        }
    }

    public override void OnCreateOutgoingConnectionFailed(
        PhoneAccountHandle? connectionManagerPhoneAccount, ConnectionRequest? request)
    {
        lock (SyncLock)
        {
            if (request?.Address?.SchemeSpecificPart == _requestId)
                CleanupActiveConnectionLocked();
        }
    }

    public override void OnConnectionServiceFocusGained()
    {
        lock (SyncLock)
        {
            _hasCallFocus = true;
            ActivateRegisteredConnectionLocked(_activeConnection);
        }
    }

    public override async void OnConnectionServiceFocusLost()
    {
        lock (SyncLock) _hasCallFocus = false;
        try
        {
            // 他の電話等にフォーカスを譲る場合は送信せず、マイクを解放する。
            await NativeRecordingService.Instance.CancelRecordingAsync();
        }
        catch (System.Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"ReleasePttCallResources failed: {ex.Message}");
        }
        finally
        {
            if (OperatingSystem.IsAndroidVersionAtLeast(28)) ConnectionServiceFocusReleased();
        }
    }

    private static void ActivateRegisteredConnectionLocked(PttConnection? connection)
    {
        if (connection == null || !ReferenceEquals(connection, _activeConnection) ||
            connection.IsClosing || !connection.RegistrationConfirmed ||
            (OperatingSystem.IsAndroidVersionAtLeast(28) && !connection.HasCallFocus) ||
            _connectTcs == null || _connectTcs.Task.IsCompleted) return;

        // 対象Connectionの音声経路通知で登録を確認し、API 28以降はFocus取得も待つ。
        connection.SetActive();
        _connectTcs.TrySetResult(true);
    }

    private static void OnHeadsetDisconnect(PttConnection connection, bool sendRecording)
    {
        lock (SyncLock)
        {
            if (!ReferenceEquals(connection, _activeConnection) || connection.IsClosing) return;
            connection.IsClosing = true;
            _connectTcs?.TrySetResult(false);
        }

        if (sendRecording && NativeRecordingService.Instance.IsRecording)
            TransceiverForegroundService.TryHandleMediaButtonToggle();
        else
            _ = NativeRecordingService.Instance.CancelRecordingAsync();
    }

    internal sealed class PttConnection : Connection
    {
        private readonly PttConnectionService _service;
        public PttConnection(PttConnectionService service) => _service = service;
        public bool HasCallFocus => _service._hasCallFocus;
        public bool IsClosing { get; set; }
        public bool RegistrationConfirmed { get; private set; }

        public void CloseLocally()
        {
            IsClosing = true;
            try
            {
                SetDisconnected(new DisconnectCause(Causes.Local));
                Destroy();
            }
            catch (System.Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"ClosePttConnection error: {ex.Message}");
            }
        }

#pragma warning disable CA1422 // API 26-33の公開コールバックとして必要
        public override void OnCallAudioStateChanged(CallAudioState? state)
        {
            ConfirmRegistration();
        }
#pragma warning restore CA1422

        public override void OnCallEndpointChanged(CallEndpoint? endpoint)
        {
            ConfirmRegistration();
        }

        private void ConfirmRegistration()
        {
            lock (SyncLock)
            {
                RegistrationConfirmed = true;
                ActivateRegisteredConnectionLocked(this);
            }
        }

        // 応答は録音停止として扱わない。PTTは発信通話なので着信応答は不要。
        public override void OnAnswer() { }
        public override void OnDisconnect() => OnHeadsetDisconnect(this, sendRecording: true);
        public override void OnAbort() => OnHeadsetDisconnect(this, sendRecording: false);
        public override void OnReject() => OnHeadsetDisconnect(this, sendRecording: false);
    }
}
