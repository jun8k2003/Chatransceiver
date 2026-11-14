using Android.Content;
using Android.Media;
using Android.OS;
using Chatransceiver.Maui.Models;
using Chatransceiver.Maui.Services;

namespace Chatransceiver.Maui.Platforms.Android.Services;

/// <summary>
/// Android オーディオ出力（スピーカー）および入力（マイク）デバイスの列挙・選択・ルーティング補助。
/// 保存値は端末再起動や再接続でも識別しやすい "Type|ProductName|Address" を用いる。
/// </summary>
public static class AudioDeviceService
{
    public const string SystemDefaultLabel = "システム規定に従う";

    private static readonly object RouteLock = new();
    private static bool _inputCommActive;
    private static bool _outputCommActive;

    private static AudioManager? GetAudioManager()
        => (AudioManager?)global::Android.App.Application.Context.GetSystemService(Context.AudioService);

    public static List<AudioDeviceOption> GetOutputDeviceOptions()
    {
        return BuildDeviceOptions(GetDevicesTargets.Outputs, IsSupportedOutputType, isInput: false);
    }

    public static List<AudioDeviceOption> GetInputDeviceOptions()
    {
        return BuildDeviceOptions(GetDevicesTargets.Inputs, IsSupportedInputType, isInput: true);
    }

    public static AudioDeviceInfo? FindPreferredOutputDevice()
        => FindDeviceByKey(GetDevicesTargets.Outputs, AppConfig.PreferredAudioOutputKey, IsSupportedOutputType);

    public static AudioDeviceInfo? FindPreferredInputDevice()
        => FindDeviceByKey(GetDevicesTargets.Inputs, AppConfig.PreferredAudioInputKey, IsSupportedInputType);

    public static bool RequiresCommunicationUsage(AudioDeviceInfo? outputDevice)
    {
        if (outputDevice == null) return false;
        return outputDevice.Type is AudioDeviceType.BuiltinEarpiece
            or AudioDeviceType.BluetoothSco;
    }

    public static void BeginOutputCommunicationRoute(AudioDeviceInfo? outputDevice)
    {
        if (outputDevice == null || !RequiresCommunicationUsage(outputDevice)) return;
        lock (RouteLock)
        {
            ApplyCommunicationDeviceLocked(outputDevice, isInput: false);
        }
    }

    public static void EndOutputCommunicationRoute()
    {
        lock (RouteLock)
        {
            if (!_outputCommActive) return;
            _outputCommActive = false;
            ClearCommunicationRouteIfIdleLocked();
        }
    }

    public static void BeginInputRouting(AudioDeviceInfo? inputDevice)
    {
        if (inputDevice == null) return;
        bool isBleHeadset = OperatingSystem.IsAndroidVersionAtLeast(31) && inputDevice.Type == AudioDeviceType.BleHeadset;
        if (inputDevice.Type != AudioDeviceType.BluetoothSco && !isBleHeadset) return;

        lock (RouteLock)
        {
            ApplyCommunicationDeviceLocked(inputDevice, isInput: true);
        }
    }

    public static void EndInputRouting()
    {
        lock (RouteLock)
        {
            if (!_inputCommActive) return;
            _inputCommActive = false;
            ClearCommunicationRouteIfIdleLocked();
        }
    }

    private static void ApplyCommunicationDeviceLocked(AudioDeviceInfo targetDevice, bool isInput)
    {
        var am = GetAudioManager();
        if (am == null) return;

        try
        {
            am.Mode = Mode.InCommunication;

            if (OperatingSystem.IsAndroidVersionAtLeast(31))
            {
                var commDevices = am.AvailableCommunicationDevices;
                AudioDeviceInfo? match = null;
                if (commDevices != null)
                {
                    match = commDevices.FirstOrDefault(d => BuildDeviceKey(d) == BuildDeviceKey(targetDevice))
                         ?? commDevices.FirstOrDefault(d => d.Type == targetDevice.Type);
                }

                if (match != null)
                {
                    am.SetCommunicationDevice(match);
                }
            }
            else if (targetDevice.Type == AudioDeviceType.BluetoothSco)
            {
#pragma warning disable CS0618, CA1422
                am.BluetoothScoOn = true;
                am.StartBluetoothSco();
#pragma warning restore CS0618, CA1422
            }
            else if (targetDevice.Type == AudioDeviceType.BuiltinEarpiece)
            {
#pragma warning disable CS0618, CA1422
                am.SpeakerphoneOn = false;
#pragma warning restore CS0618, CA1422
            }

            if (isInput) _inputCommActive = true;
            else _outputCommActive = true;
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"ApplyCommunicationDeviceLocked error: {ex.Message}");
        }
    }

    private static void ClearCommunicationRouteIfIdleLocked()
    {
        if (_inputCommActive || _outputCommActive) return;

        var am = GetAudioManager();
        if (am == null) return;

        try
        {
            if (OperatingSystem.IsAndroidVersionAtLeast(31))
            {
                am.ClearCommunicationDevice();
            }
            else
            {
#pragma warning disable CS0618, CA1422
                if (am.BluetoothScoOn)
                {
                    am.StopBluetoothSco();
                    am.BluetoothScoOn = false;
                }
#pragma warning restore CS0618, CA1422
            }
            am.Mode = Mode.Normal;
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"ClearCommunicationRouteIfIdleLocked error: {ex.Message}");
        }
    }

    private static List<AudioDeviceOption> BuildDeviceOptions(
        GetDevicesTargets target,
        Func<AudioDeviceType, bool> filter,
        bool isInput)
    {
        var options = new List<AudioDeviceOption>
        {
            new(string.Empty, SystemDefaultLabel)
        };

        var am = GetAudioManager();
        var devices = am?.GetDevices(target);
        if (devices == null) return options;

        var filtered = devices.Where(d => filter(d.Type)).ToList();
        int builtinMicCount = filtered.Count(d => d.Type == AudioDeviceType.BuiltinMic);
        int builtinMicIndex = 0;

        var seenKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var device in filtered)
        {
            var key = BuildDeviceKey(device);
            if (!seenKeys.Add(key)) continue;

            string label = FormatDeviceLabel(
                device,
                isInput,
                device.Type == AudioDeviceType.BuiltinMic ? ++builtinMicIndex : 0,
                builtinMicCount);
            options.Add(new AudioDeviceOption(key, label));
        }

        return options;
    }

    private static AudioDeviceInfo? FindDeviceByKey(
        GetDevicesTargets target,
        string savedKey,
        Func<AudioDeviceType, bool> filter)
    {
        if (string.IsNullOrWhiteSpace(savedKey)) return null;

        var am = GetAudioManager();
        var devices = am?.GetDevices(target);
        if (devices == null) return null;

        var candidates = devices.Where(d => filter(d.Type)).ToList();
        var exact = candidates.FirstOrDefault(d => BuildDeviceKey(d) == savedKey);
        if (exact != null) return exact;

        // Address が OS 更新等で変化した場合のフォールバック (Type + ProductName 一致)
        var parts = savedKey.Split('|');
        if (parts.Length >= 2 && int.TryParse(parts[0], out int typeInt))
        {
            var savedType = (AudioDeviceType)typeInt;
            var savedProduct = parts[1];
            return candidates.FirstOrDefault(d =>
                d.Type == savedType &&
                string.Equals(d.ProductName?.ToString()?.Trim() ?? string.Empty, savedProduct, StringComparison.Ordinal));
        }

        return null;
    }

    public static string BuildDeviceKey(AudioDeviceInfo device)
    {
        var product = device.ProductName?.ToString()?.Trim() ?? string.Empty;
        var address = OperatingSystem.IsAndroidVersionAtLeast(28) ? (device.Address?.Trim() ?? string.Empty) : string.Empty;
        return $"{(int)device.Type}|{product}|{address}";
    }

    private static string FormatDeviceLabel(
        AudioDeviceInfo device,
        bool isInput,
        int builtinMicIndex,
        int builtinMicCount)
    {
        var product = device.ProductName?.ToString()?.Trim() ?? string.Empty;
        var address = OperatingSystem.IsAndroidVersionAtLeast(28) ? (device.Address?.Trim() ?? string.Empty) : string.Empty;
        bool includeProduct = !string.IsNullOrEmpty(product)
            && !string.Equals(product, Build.Model, StringComparison.OrdinalIgnoreCase);

        string baseLabel;
        if (OperatingSystem.IsAndroidVersionAtLeast(31) && device.Type == AudioDeviceType.BleHeadset)
        {
            baseLabel = isInput ? "🎤 Bluetooth LE マイク" : "🎧 Bluetooth LE Audio";
        }
        else if (OperatingSystem.IsAndroidVersionAtLeast(31) && device.Type == AudioDeviceType.BleSpeaker)
        {
            baseLabel = "🔊 Bluetooth LE スピーカー";
        }
        else if (OperatingSystem.IsAndroidVersionAtLeast(28) && device.Type == AudioDeviceType.HearingAid)
        {
            baseLabel = "🦻 補聴器";
        }
        else
        {
            baseLabel = device.Type switch
            {
                AudioDeviceType.BuiltinSpeaker => "📱 本体スピーカー",
                AudioDeviceType.BuiltinEarpiece => "📞 本体受話口 (イヤピース)",
                AudioDeviceType.BuiltinMic => FormatBuiltinMicLabel(address, builtinMicIndex, builtinMicCount),
                AudioDeviceType.WiredHeadset => isInput ? "🎤 有線マイク付きイヤホン" : "🎧 有線イヤホン / ヘッドセット",
                AudioDeviceType.WiredHeadphones => "🎧 有線ヘッドホン",
                AudioDeviceType.BluetoothA2dp => "🎧 Bluetooth オーディオ",
                AudioDeviceType.BluetoothSco => isInput ? "🎤 Bluetooth マイク" : "🎧 Bluetooth 通話 (HFP)",
                AudioDeviceType.UsbHeadset or AudioDeviceType.UsbDevice or AudioDeviceType.UsbAccessory =>
                    isInput ? "🔌 USB マイク" : "🔌 USB オーディオ",
                _ => device.Type.ToString()
            };
        }

        if (device.Type != AudioDeviceType.BuiltinMic &&
            device.Type != AudioDeviceType.BuiltinSpeaker &&
            device.Type != AudioDeviceType.BuiltinEarpiece &&
            includeProduct)
        {
            return $"{baseLabel} ({product})";
        }

        return baseLabel;
    }

    private static string FormatBuiltinMicLabel(string address, int index, int total)
    {
        if (total <= 1) return "🎙️ 本体マイク";
        if (!string.IsNullOrEmpty(address)) return $"🎙️ 本体マイク ({address})";
        return $"🎙️ 本体マイク #{index}";
    }

    private static bool IsSupportedOutputType(AudioDeviceType type)
    {
        if (OperatingSystem.IsAndroidVersionAtLeast(31) &&
            (type == AudioDeviceType.BleHeadset || type == AudioDeviceType.BleSpeaker))
        {
            return true;
        }
        if (OperatingSystem.IsAndroidVersionAtLeast(28) && type == AudioDeviceType.HearingAid)
        {
            return true;
        }
        return type is
            AudioDeviceType.BuiltinSpeaker or
            AudioDeviceType.BuiltinEarpiece or
            AudioDeviceType.WiredHeadset or
            AudioDeviceType.WiredHeadphones or
            AudioDeviceType.BluetoothA2dp or
            AudioDeviceType.BluetoothSco or
            AudioDeviceType.UsbHeadset or
            AudioDeviceType.UsbDevice or
            AudioDeviceType.UsbAccessory;
    }

    private static bool IsSupportedInputType(AudioDeviceType type)
    {
        if (OperatingSystem.IsAndroidVersionAtLeast(31) && type == AudioDeviceType.BleHeadset)
        {
            return true;
        }
        return type is
            AudioDeviceType.BuiltinMic or
            AudioDeviceType.WiredHeadset or
            AudioDeviceType.BluetoothSco or
            AudioDeviceType.UsbHeadset or
            AudioDeviceType.UsbDevice or
            AudioDeviceType.UsbAccessory;
    }
}
