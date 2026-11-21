// Hardware/Telecom boundaries only. Tests compile the production PTT, recording and routing code.
global using OperatingSystem = Chatransceiver.Ptt.Tests.TestOperatingSystem;
global using MainThread = Chatransceiver.Ptt.Tests.TestMainThread;

namespace Chatransceiver.Ptt.Tests
{
    public static class TestOperatingSystem
    {
        public static int ApiLevel = 35;
        public static bool IsAndroidVersionAtLeast(int version) => ApiLevel >= version;
    }
    public static class TestMainThread
    {
        public static Task InvokeOnMainThreadAsync(Action action) { action(); return Task.CompletedTask; }
        public static void BeginInvokeOnMainThread(Action action) => action();
    }
}

namespace Java.Lang
{
    public class Object : IDisposable { public void Dispose() { } }
    public class Class { public static Class FromType(Type type) => new(); }
}

namespace Android.App
{
    [AttributeUsage(AttributeTargets.Class)]
    public class ServiceAttribute : Attribute
    {
        public string? Name { get; set; }
        public string? Permission { get; set; }
        public bool Exported { get; set; }
    }
    public static class Application { public static Content.Context Context { get; } = new(); }
}

namespace Android.Content
{
    [AttributeUsage(AttributeTargets.Class)]
    public class IntentFilterAttribute(string[] actions) : Attribute { public string[] Actions = actions; }
    public class Context
    {
        public const string TelecomService = "telecom", AudioService = "audio";
        public object? GetSystemService(string name) => name switch
        {
            TelecomService => Telecom.TelecomManager.Instance,
            AudioService => Media.AudioManager.Instance,
            _ => null
        };
    }
    public class ComponentName { public ComponentName(Context context, Java.Lang.Class type) { } }
    public class Intent
    {
        public Intent(string action) { }
        public Intent PutExtra(string? key, object value) => this;
    }
}

namespace Android.Net
{
    public class Uri(string scheme, string part)
    {
        public string Scheme { get; } = scheme;
        public string SchemeSpecificPart { get; } = part;
        public static Uri FromParts(string scheme, string part, string? fragment) => new(scheme, part);
    }
}

namespace Android.OS
{
    public class Bundle
    {
        public Dictionary<string, object> Values = new();
        public void PutParcelable(string key, object value) => Values[key] = value;
        public IList<string>? GetStringArrayList(string key) => null;
    }
    public enum BuildVersionCodes { Tiramisu = 33 }
    public static class Build
    {
        public const string Model = "Test phone";
        public static class VERSION { public static BuildVersionCodes SdkInt = (BuildVersionCodes)35; }
    }
    public class ParcelFileDescriptor : IDisposable
    {
        public static ParcelFileDescriptor[] CreatePipe() => [new(), new()];
        public void Close() { }
        public void Dispose() { }
        public class AutoCloseOutputStream : IDisposable
        {
            public AutoCloseOutputStream(ParcelFileDescriptor descriptor) { }
            public void Write(byte[] data, int offset, int count) { }
            public void Flush() { }
            public void Close() { }
            public void Dispose() { }
        }
    }
}

namespace Android.Telecom
{
    public enum Causes { Local, Canceled, Rejected }
    public enum Presentation { Allowed }
    public enum ConnectionProperties { SelfManaged }
    public enum PhoneAccountCapability { SelfManaged = 1 }
    public class DisconnectCause(Causes cause) { public Causes Cause = cause; }
    public class PhoneAccountHandle { public PhoneAccountHandle(Content.ComponentName component, string id) { } }
    public class PhoneAccount
    {
        public IList<string> Schemes = [];
        public static Builder InvokeBuilder(PhoneAccountHandle handle, string name) => new();
        public class Builder
        {
            private readonly PhoneAccount _account = new();
            public Builder SetCapabilities(int value) => this;
            public Builder SetSupportedUriSchemes(IList<string> schemes) { _account.Schemes = schemes; return this; }
            public PhoneAccount Build() => _account;
        }
    }
    public class ConnectionRequest(Net.Uri address) { public Net.Uri Address = address; }
    public class CallAudioState { }
    public class CallEndpoint { }
    public class Connection
    {
        public string State = "new";
        public bool WasReturned, Destroyed;
        public ConnectionProperties ConnectionProperties { get; set; }
        public bool AudioModeIsVoip { get; set; }
        public void SetAddress(Net.Uri address, Presentation presentation) { }
        public void SetCallerDisplayName(string name, Presentation presentation) { }
        public void SetDialing() => State = "dialing";
        public void SetActive()
        {
            if (!WasReturned) throw new InvalidOperationException("SetActive before returning to Telecom");
            State = "active";
        }
        public void SetDisconnected(DisconnectCause cause) => State = "disconnected";
        public void Destroy() => Destroyed = true;
        public static Connection CreateFailedConnection(DisconnectCause cause) => new() { State = "disconnected" };
        public virtual void OnCallAudioStateChanged(CallAudioState? state) { }
        public virtual void OnCallEndpointChanged(CallEndpoint? endpoint) { }
        public virtual void OnAnswer() { }
        public virtual void OnDisconnect() { }
        public virtual void OnAbort() { }
        public virtual void OnReject() { }
    }
    public class ConnectionService : Content.Context
    {
        public virtual Connection OnCreateIncomingConnection(PhoneAccountHandle? account, ConnectionRequest? request) => new();
        public virtual Connection OnCreateOutgoingConnection(PhoneAccountHandle? account, ConnectionRequest? request) => new();
        public virtual void OnCreateOutgoingConnectionFailed(PhoneAccountHandle? account, ConnectionRequest? request) { }
        public virtual void OnConnectionServiceFocusGained() { }
        public virtual void OnConnectionServiceFocusLost() { }
        public bool FocusReleased;
        public void ConnectionServiceFocusReleased() => FocusReleased = true;
    }
    public class TelecomManager
    {
        public static TelecomManager Instance = new();
        public const string ExtraPhoneAccountHandle = "account";
        public readonly Chatransceiver.Maui.Platforms.Android.Services.PttConnectionService Service = new();
        public bool AutoConnect = true, Reject, ThrowOnPlaceCall;
        public int RegistrationDelayMs;
        public PhoneAccount? RegisteredAccount;
        public Connection? Connection;
        public ConnectionRequest? LastRequest;
        public void RegisterPhoneAccount(PhoneAccount account) => RegisteredAccount = account;
        public void PlaceCall(Net.Uri address, OS.Bundle extras)
        {
            if (ThrowOnPlaceCall) throw new InvalidOperationException("Telecom rejected request");
            if (!extras.Values.ContainsKey(ExtraPhoneAccountHandle)) throw new InvalidOperationException("Missing self-managed account");
            LastRequest = new(address);
            if (!AutoConnect) return;
            if (Reject) { Service.OnCreateOutgoingConnectionFailed(null, LastRequest); return; }
            Connection = Service.OnCreateOutgoingConnection(null, LastRequest);
            if (Connection.State != "dialing") throw new InvalidOperationException("Initial call must be dialing");
            Connection.WasReturned = true;
            var connection = Connection;
            _ = Task.Run(async () =>
            {
                await Task.Delay(RegistrationDelayMs);
                if (Chatransceiver.Ptt.Tests.TestOperatingSystem.ApiLevel >= 28)
                    Service.OnConnectionServiceFocusGained();
                if (Chatransceiver.Ptt.Tests.TestOperatingSystem.ApiLevel >= 34)
                    connection.OnCallEndpointChanged(new());
                else connection.OnCallAudioStateChanged(new());
            });
        }
    }
}

namespace Android.Media
{
    public enum AudioDeviceType { BuiltinMic, BluetoothSco, BleHeadset, BleSpeaker, BuiltinEarpiece, BuiltinSpeaker, HearingAid, WiredHeadset, WiredHeadphones, BluetoothA2dp, UsbHeadset, UsbDevice, UsbAccessory }
    public enum GetDevicesTargets { Inputs, Outputs }
    public enum Mode { Normal, InCommunication }
    public enum AudioSource { VoiceCommunication, Mic }
    public enum ChannelIn { Mono }
    public enum Encoding { Pcm16bit }
    public enum State { Initialized }
    public class AudioDeviceInfo
    {
        public int Id;
        public AudioDeviceType Type;
        public string? ProductName, Address;
    }
    public class AudioManager
    {
        public static AudioManager Instance = new();
        public AudioDeviceInfo Input = new() { Id = 1, Type = AudioDeviceType.BluetoothSco, ProductName = "EC002", Address = "device" };
        public AudioDeviceInfo Output = new() { Id = 2, Type = AudioDeviceType.BluetoothSco, ProductName = "EC002", Address = "device" };
        public AudioDeviceInfo? CommunicationDevice;
        public bool AcceptRoute = true, BluetoothScoOn, SpeakerphoneOn;
        public Mode Mode;
        public IList<AudioDeviceInfo> AvailableCommunicationDevices => [Output];
        public AudioDeviceInfo[] GetDevices(GetDevicesTargets target) => target == GetDevicesTargets.Inputs ? [Input] : [Output];
        public bool SetCommunicationDevice(AudioDeviceInfo device)
        {
            if (!AcceptRoute) return false;
            CommunicationDevice = device;
            return true;
        }
        public void ClearCommunicationDevice() => CommunicationDevice = null;
        public void StartBluetoothSco() { BluetoothScoOn = true; }
        public void StopBluetoothSco() { BluetoothScoOn = false; }
    }
    public class AudioRecord : IDisposable
    {
        public static int RouteDelayMs, WarmupError;
        public static bool FailStart, NoFrames;
        public static byte FrameValue = 7;
        public static AudioRecord? Latest;
        private long _started, _lastFrame;
        private bool _recording;
        public AudioRecord(AudioSource source, int sampleRate, ChannelIn channels, Encoding encoding, int bufferSize) => Latest = this;
        public State State => State.Initialized;
        public int AudioSessionId => 1;
        public AudioDeviceInfo? RoutedDevice => Environment.TickCount64 - _started >= RouteDelayMs ? AudioManager.Instance.Input : null;
        public static int GetMinBufferSize(int rate, ChannelIn channels, Encoding encoding) => 3200;
        public void StartRecording()
        {
            if (FailStart) throw new InvalidOperationException("AudioRecord start failed");
            _recording = true;
            _started = Environment.TickCount64;
        }
        public int Read(byte[] bytes, int offset, int length, int mode)
        {
            if (!_recording || WarmupError < 0) return WarmupError < 0 ? WarmupError : -3;
            if (NoFrames || RoutedDevice == null || Environment.TickCount64 - _lastFrame < 20) return 0;
            _lastFrame = Environment.TickCount64;
            int size = Math.Min(length, 320);
            Array.Fill(bytes, FrameValue, offset, size);
            return size;
        }
        public bool SetPreferredDevice(AudioDeviceInfo device) => true;
        public void Stop() => _recording = false;
        public void Release() { }
        public void Dispose() { }
    }
}

namespace Android.Media.Audiofx
{
    public class NoiseSuppressor : IDisposable
    {
        public static bool IsAvailable => false;
        public static NoiseSuppressor Create(int id) => new();
        public void SetEnabled(bool value) { }
        public void Release() { }
        public void Dispose() { }
    }
}

namespace Android.Speech
{
    public enum SpeechRecognizerError { }
    public class SpeechRecognizer : IDisposable
    {
        public const string ResultsRecognition = "results";
        public static bool IsRecognitionAvailable(Content.Context context) => false;
        public static SpeechRecognizer CreateSpeechRecognizer(Content.Context context) => new();
        public void SetRecognitionListener(IRecognitionListener listener) { }
        public void StartListening(Content.Intent intent) { }
        public void Destroy() { }
        public void Dispose() { }
    }
    public static class RecognizerIntent
    {
        public const string ActionRecognizeSpeech = "recognize", ExtraLanguageModel = "model", LanguageModelFreeForm = "free", ExtraLanguage = "language", ExtraPartialResults = "partial";
    }
    public interface IRecognitionListener
    {
        void OnBeginningOfSpeech(); void OnBufferReceived(byte[]? buffer); void OnEndOfSpeech();
        void OnEvent(int eventType, OS.Bundle? parameters); void OnReadyForSpeech(OS.Bundle? parameters);
        void OnRmsChanged(float rms); void OnError(SpeechRecognizerError error);
        void OnPartialResults(OS.Bundle? results); void OnResults(OS.Bundle? results);
    }
}

namespace Chatransceiver.Maui.Models
{
    public class RecordingResult
    {
        public byte[]? WavBytes { get; set; }
        public string Transcript { get; set; } = "";
        public bool NeedsTranscription { get; set; }
    }
    public record AudioDeviceOption(string Key, string DisplayName);
}

namespace Chatransceiver.Maui.Services
{
    public static class AppConfig
    {
        public static string RecordingMode = "audio_only", PreferredAudioInputKey = "", PreferredAudioOutputKey = "";
        public static bool NoiseSuppressionEnabled;
    }
}

namespace Chatransceiver.Maui.Platforms.Android.Services
{
    public class NativeAudioService
    {
        public static NativeAudioService Instance = new();
        public int StartTones;
        public Action? OnStartTone;
        public void StartSilentRecordingKeeper() { }
        public void StopSilentRecordingKeeper() { }
        public Task BeepStartAsync() { StartTones++; OnStartTone?.Invoke(); return Task.Delay(30); }
        public Task BeepEndAsync() => Task.CompletedTask;
    }
    public static class TransceiverForegroundService
    {
        public static int StopRequests;
        public static bool TryHandleMediaButtonToggle() { StopRequests++; return true; }
    }
}
