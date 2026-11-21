using System.Diagnostics;
using System.Reflection;
using Android.Media;
using Android.Telecom;
using Chatransceiver.Maui.Platforms.Android.Services;
using Chatransceiver.Maui.Services;
using Chatransceiver.Ptt.Tests;

int passed = 0, failed = 0;
async Task Test(string name, Func<Task> body)
{
    try
    {
        await NativeRecordingService.Instance.CancelRecordingAsync();
        TelecomManager.Instance = new();
        AudioManager.Instance = new();
        NativeAudioService.Instance = new();
        TestOperatingSystem.ApiLevel = 35;
        Android.OS.Build.VERSION.SdkInt = (Android.OS.BuildVersionCodes)35;
        AudioRecord.RouteDelayMs = AudioRecord.WarmupError = 0;
        AudioRecord.FailStart = AudioRecord.NoFrames = false;
        AudioRecord.FrameValue = 7;
        AudioRecord.Latest = null;
        AppConfig.RecordingMode = "audio_only";
        AppConfig.PreferredAudioInputKey = AudioDeviceService.BuildDeviceKey(AudioManager.Instance.Input);
        TransceiverForegroundService.StopRequests = 0;
        typeof(PttConnectionService).GetField("_accountRegistered", BindingFlags.Static | BindingFlags.NonPublic)!.SetValue(null, false);
        await body();
        Console.WriteLine($"PASS {name}");
        passed++;
    }
    catch (Exception ex)
    {
        Console.WriteLine($"FAIL {name}: {ex}");
        failed++;
    }
    finally { await NativeRecordingService.Instance.CancelRecordingAsync(); }
}
void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
async Task WaitUntil(Func<bool> condition)
{
    var watch = Stopwatch.StartNew();
    while (!condition())
    {
        if (watch.ElapsedMilliseconds > 2000) throw new TimeoutException("Expected state did not arrive");
        await Task.Delay(10);
    }
}

await Test("outgoing call stays dialing until a Telecom callback after creation returns", async () =>
{
    var telecom = TelecomManager.Instance;
    telecom.AutoConnect = false;
    var starting = PttConnectionService.StartPttCallAsync();
    Check(telecom.LastRequest!.Address.Scheme == "chatransceiver-ptt", "PTT must use its own URI scheme");
    Check(telecom.RegisteredAccount!.Schemes.Contains("chatransceiver-ptt"), "Account must register PTT scheme");
    var connection = telecom.Service.OnCreateOutgoingConnection(null, telecom.LastRequest);
    Check(connection.State == "dialing" && connection.AudioModeIsVoip, "Return an outgoing VoIP connection");
    Check(!starting.IsCompleted, "Creation alone must not complete startup");
    connection.WasReturned = true;
    telecom.Service.OnConnectionServiceFocusGained();
    Check(!starting.IsCompleted, "Service focus alone must not confirm this connection's registration");
    connection.OnCallEndpointChanged(new());
    Check(await starting, "Registration notification should complete startup");
    Check(connection.State == "active", "Connection should become active after registration");
    connection.OnAnswer();
    Check(TransceiverForegroundService.StopRequests == 0, "Answer must not send a recording");
    PttConnectionService.EndPttCall();
    Check(connection.Destroyed, "Local stop must destroy the call");
});

await Test("incoming calls are rejected without creating ringing PTT sessions", () =>
{
    var connection = TelecomManager.Instance.Service.OnCreateIncomingConnection(null, null);
    Check(connection.State == "disconnected", "PTT must never create an incoming call");
    return Task.CompletedTask;
});

await Test("slow Bluetooth routing finishes before the start tone and recording", async () =>
{
    TelecomManager.Instance.RegistrationDelayMs = 150;
    AudioRecord.RouteDelayMs = 800;
    NativeAudioService.Instance.OnStartTone = () =>
    {
        Check(NativeRecordingService.Instance.IsStarting && !NativeRecordingService.Instance.IsRecording,
            "Start tone belongs to preparation");
        Check(AudioDeviceService.IsInputRouteReady(AudioManager.Instance.Input, AudioRecord.Latest!.RoutedDevice),
            "Route must be ready before the start tone");
    };
    var watch = Stopwatch.StartNew();
    Check(await NativeRecordingService.Instance.StartRecordingAsync(), "Slow microphone should start");
    Check(watch.ElapsedMilliseconds >= 950, "Do not replace readiness with a fixed 500ms delay");
    await Task.Delay(60);
    var result = await NativeRecordingService.Instance.StopRecordingAsync();
    Check(result.WavBytes is { Length: > 44 } && result.WavBytes[44] == 7, "Capture microphone PCM");
});

await Test("headset answer does not stop recording; disconnect requests one stop", async () =>
{
    Check(await NativeRecordingService.Instance.StartRecordingAsync(), "Start recording");
    var connection = TelecomManager.Instance.Connection!;
    connection.OnAnswer();
    Check(NativeRecordingService.Instance.IsRecording && TransceiverForegroundService.StopRequests == 0,
        "Answer should have no stop effect");
    connection.OnDisconnect();
    connection.OnDisconnect();
    Check(TransceiverForegroundService.StopRequests == 1, "Duplicate disconnect should not duplicate sends");
    Check(!connection.Destroyed, "Keep route until the recorder plays the end tone");
    await NativeRecordingService.Instance.StopRecordingAsync();
    Check(connection.Destroyed, "Stop should clean up the call");
});

await Test("cancelling before registration produces no tone, audio, or send", async () =>
{
    var telecom = TelecomManager.Instance;
    telecom.AutoConnect = false;
    var starting = NativeRecordingService.Instance.StartRecordingAsync();
    Check(NativeRecordingService.Instance.IsStarting, "Expose preparation separately from recording");
    var stale = telecom.LastRequest;
    await NativeRecordingService.Instance.CancelRecordingAsync().WaitAsync(TimeSpan.FromSeconds(2));
    Check(!await starting && !NativeRecordingService.Instance.IsRecording, "Cancel startup");
    Check(NativeAudioService.Instance.StartTones == 0 && AudioRecord.Latest == null, "No recording before registration");
    Check(telecom.Service.OnCreateOutgoingConnection(null, stale).State == "disconnected", "Reject late creation");
    var result = await NativeRecordingService.Instance.StopRecordingAsync();
    Check(result.WavBytes == null && result.Transcript == "", "Cancelled startup has no sendable result");
});

await Test("a stale failed or completed request cannot activate the next PTT session", async () =>
{
    var telecom = TelecomManager.Instance;
    telecom.AutoConnect = false;
    using var cancellation = new CancellationTokenSource();
    var first = PttConnectionService.StartPttCallAsync(cancellation.Token);
    var stale = telecom.LastRequest;
    cancellation.Cancel();
    Check(!await first, "First request should cancel");
    var second = PttConnectionService.StartPttCallAsync();
    Check(telecom.Service.OnCreateOutgoingConnection(null, stale).State == "disconnected", "Reject old request");
    telecom.Service.OnCreateOutgoingConnectionFailed(null, stale);
    Check(!second.IsCompleted, "Old failure must not cancel new request");
    var connection = telecom.Service.OnCreateOutgoingConnection(null, telecom.LastRequest);
    connection.WasReturned = true;
    telecom.Service.OnConnectionServiceFocusGained();
    connection.OnCallEndpointChanged(new());
    Check(await second, "Current request should activate");
});

await Test("audio registration arriving before call focus waits for both notifications", async () =>
{
    var telecom = TelecomManager.Instance;
    telecom.AutoConnect = false;
    var starting = PttConnectionService.StartPttCallAsync();
    var connection = telecom.Service.OnCreateOutgoingConnection(null, telecom.LastRequest);
    connection.WasReturned = true;
    connection.OnCallEndpointChanged(new());
    Check(!starting.IsCompleted && connection.State == "dialing", "Do not acquire call resources without focus");
    telecom.Service.OnConnectionServiceFocusGained();
    Check(await starting && connection.State == "active", "Activate after both notifications");
});

await Test("consecutive PTT calls can retain Telecom service focus without a duplicate focus event", async () =>
{
    var telecom = TelecomManager.Instance;
    Check(await PttConnectionService.StartPttCallAsync(), "First call acquires service focus");
    PttConnectionService.EndPttCall();
    telecom.AutoConnect = false;
    var second = PttConnectionService.StartPttCallAsync();
    var connection = telecom.Service.OnCreateOutgoingConnection(null, telecom.LastRequest);
    connection.WasReturned = true;
    connection.OnCallEndpointChanged(new());
    Check(await second.WaitAsync(TimeSpan.FromSeconds(1)), "Service still owns focus until Telecom reports focus loss");
});

await Test("Telecom rejection and exceptions fail startup without acquiring the microphone", async () =>
{
    foreach (bool throwing in new[] { false, true })
    {
        TelecomManager.Instance.Reject = !throwing;
        TelecomManager.Instance.ThrowOnPlaceCall = throwing;
        Check(!await NativeRecordingService.Instance.StartRecordingAsync(), "Do not continue after Telecom failure");
        Check(AudioRecord.Latest == null && NativeAudioService.Instance.StartTones == 0, "No false ready indication");
    }
});

await Test("recording warmup errors release the call and leave no empty message", async () =>
{
    AudioRecord.WarmupError = -3;
    Check(!await NativeRecordingService.Instance.StartRecordingAsync(), "Reject failed PCM reads");
    Check(TelecomManager.Instance.Connection!.Destroyed, "Release failed call");
    Check(AudioManager.Instance.Mode == Mode.Normal && !AudioDeviceService.IsInputCommunicationActive, "Restore audio mode");
    var result = await NativeRecordingService.Instance.StopRecordingAsync();
    Check(result.WavBytes == null && result.Transcript == "" && NativeAudioService.Instance.StartTones == 0, "Nothing to send");
});

await Test("AudioRecord start exceptions clean up the call and permit a later recording", async () =>
{
    AudioRecord.FailStart = true;
    Check(!await NativeRecordingService.Instance.StartRecordingAsync(), "Reject AudioRecord failure");
    Check(TelecomManager.Instance.Connection!.Destroyed, "Close failed call");
    AudioRecord.FailStart = false;
    Check(await NativeRecordingService.Instance.StartRecordingAsync(), "Failure must not wedge subsequent startup");
});

await Test("route rejection times out without a start tone and restores the normal audio mode", async () =>
{
    AudioManager.Instance.AcceptRoute = false;
    Check(!await NativeRecordingService.Instance.StartRecordingAsync(), "Reject an unavailable route");
    Check(NativeAudioService.Instance.StartTones == 0 && AudioManager.Instance.Mode == Mode.Normal, "No false readiness");
    Check(TelecomManager.Instance.Connection!.Destroyed, "Timeout must close the call");
});

await Test("header-only capture is not converted into an audio message placeholder", async () =>
{
    NativeAudioService.Instance.OnStartTone = () => AudioRecord.NoFrames = true;
    Check(await NativeRecordingService.Instance.StartRecordingAsync(), "Preparation received data");
    await Task.Delay(50);
    var result = await NativeRecordingService.Instance.StopRecordingAsync();
    Check(result.WavBytes == null && result.Transcript == "" && !result.NeedsTranscription, "Do not send empty audio");
});

await Test("a cancelled second recording cannot reuse the first recording bytes", async () =>
{
    Check(await NativeRecordingService.Instance.StartRecordingAsync(), "First recording starts");
    await Task.Delay(60);
    Check((await NativeRecordingService.Instance.StopRecordingAsync()).WavBytes is { Length: > 44 }, "First recording contains audio");
    TelecomManager.Instance.AutoConnect = false;
    var starting = NativeRecordingService.Instance.StartRecordingAsync();
    var stopped = await NativeRecordingService.Instance.StopRecordingAsync();
    Check(!await starting && stopped.WavBytes == null && stopped.Transcript == "", "No previous audio leakage");
});

await Test("built-in microphone recording does not register a Telecom call", async () =>
{
    AudioManager.Instance.Input.Type = AudioDeviceType.BuiltinMic;
    AppConfig.PreferredAudioInputKey = AudioDeviceService.BuildDeviceKey(AudioManager.Instance.Input);
    Check(await NativeRecordingService.Instance.StartRecordingAsync(), "Built-in microphone starts");
    Check(TelecomManager.Instance.LastRequest == null, "No call is required for the built-in microphone");
});

await Test("API 26 activates after Telecom audio notification and restores SCO on stop", async () =>
{
    TestOperatingSystem.ApiLevel = 26;
    Android.OS.Build.VERSION.SdkInt = (Android.OS.BuildVersionCodes)26;
    AppConfig.PreferredAudioInputKey = AudioDeviceService.BuildDeviceKey(AudioManager.Instance.Input);
    Check(await NativeRecordingService.Instance.StartRecordingAsync(), "Legacy audio callback activates call");
    Check(AudioManager.Instance.BluetoothScoOn, "Legacy SCO route is established");
    await NativeRecordingService.Instance.StopRecordingAsync();
    Check(!AudioManager.Instance.BluetoothScoOn && AudioManager.Instance.Mode == Mode.Normal, "Release legacy SCO");
});

await Test("API 28 activates after Telecom focus notification", async () =>
{
    TestOperatingSystem.ApiLevel = 28;
    Check(await NativeRecordingService.Instance.StartRecordingAsync(), "Focus callback activates call");
    Check(TelecomManager.Instance.Connection!.State == "active", "Call should be active");
});

await Test("losing Telecom focus cancels recording and releases resources without sending", async () =>
{
    Check(await NativeRecordingService.Instance.StartRecordingAsync(), "Start recording");
    TelecomManager.Instance.Service.OnConnectionServiceFocusLost();
    await WaitUntil(() => TelecomManager.Instance.Service.FocusReleased);
    Check(!NativeRecordingService.Instance.IsRecording && TelecomManager.Instance.Connection!.Destroyed, "Release microphone and call");
    Check(TransceiverForegroundService.StopRequests == 0, "Focus loss must not send a message");
});

await Test("another Bluetooth device of the same type is not accepted as the selected microphone", () =>
{
    AudioManager.Instance.Output.Address = "other-device";
    AudioDeviceService.BeginInputRouting(AudioManager.Instance.Input);
    Check(!AudioDeviceService.IsInputRouteReady(AudioManager.Instance.Input, AudioManager.Instance.Input), "Do not route to a different receiver");
    Check(AudioManager.Instance.Mode == Mode.Normal, "Failed routing must release communication mode");
    return Task.CompletedTask;
});

await Test("Bluetooth input/output names may differ when their physical address matches", () =>
{
    AudioManager.Instance.Output.ProductName = "EC002 Hands-Free Output";
    AudioDeviceService.BeginInputRouting(AudioManager.Instance.Input);
    Check(AudioDeviceService.IsInputRouteReady(AudioManager.Instance.Input, AudioManager.Instance.Input),
        "Same receiver should be matched by address rather than a direction-specific product name");
    return Task.CompletedTask;
});

Console.WriteLine($"PTT regression tests: {passed} passed, {failed} failed");
return failed == 0 ? 0 : 1;
