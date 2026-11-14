using Chatransceiver.Maui.Models;
using Chatransceiver.Maui.Services;
#if ANDROID
using Chatransceiver.Maui.Platforms.Android.Services;
#endif

namespace Chatransceiver.Maui.Views;

public partial class SettingsModalPage : ContentPage
{
    private readonly SupabaseUser? _currentUser;
    private readonly Func<Task>? _onSettingsSaved;
    private readonly Func<Task>? _onSignOutRequested;

    public SettingsModalPage(
        SupabaseUser? currentUser,
        Func<Task>? onSettingsSaved,
        Func<Task>? onSignOutRequested)
    {
        InitializeComponent();
        _currentUser = currentUser;
        _onSettingsSaved = onSettingsSaved;
        _onSignOutRequested = onSignOutRequested;

        NicknameEntry.Text = _currentUser?.Name ?? string.Empty;
        AutoPlaySwitch.IsToggled = AppConfig.AutoPlayEnabled;
        EchoSentSwitch.IsToggled = AppConfig.EchoSentEnabled;
        CallSignSwitch.IsToggled = AppConfig.CallSignEnabled;
        UnreadBadgeSwitch.IsToggled = AppConfig.UnreadBadgeEnabled;
        LightThemeSwitch.IsToggled = AppConfig.Theme == "light";
        SupabaseUrlEntry.Text = AppConfig.SupabaseUrl;
        SupabaseKeyEntry.Text = AppConfig.SupabaseAnonKey;
        AppVersionLabel.Text = $"Chatransceiver Android v{AppInfo.Current.VersionString} (Build {AppInfo.Current.BuildString})";

        RecordingModePicker.SelectedIndex = AppConfig.RecordingMode switch
        {
            "audio_only" => 1,
            "text_only" => 2,
            _ => 0
        };

        LoadAudioDevicePickers();
    }

    private void LoadAudioDevicePickers(string? overrideOutputKey = null, string? overrideOutputLabel = null, string? overrideInputKey = null, string? overrideInputLabel = null)
    {
        var savedOutKey = overrideOutputKey ?? AppConfig.PreferredAudioOutputKey;
        var savedOutLabel = overrideOutputLabel ?? AppConfig.PreferredAudioOutputLabel;
        var savedInKey = overrideInputKey ?? AppConfig.PreferredAudioInputKey;
        var savedInLabel = overrideInputLabel ?? AppConfig.PreferredAudioInputLabel;

#if ANDROID
        var outputOptions = AudioDeviceService.GetOutputDeviceOptions();
        var inputOptions = AudioDeviceService.GetInputDeviceOptions();
#else
        var outputOptions = new List<AudioDeviceOption> { new(string.Empty, "システム規定に従う") };
        var inputOptions = new List<AudioDeviceOption> { new(string.Empty, "システム規定に従う") };
#endif

        PopulateDevicePicker(OutputDevicePicker, outputOptions, savedOutKey, savedOutLabel);
        PopulateDevicePicker(InputDevicePicker, inputOptions, savedInKey, savedInLabel);
    }

    private static void PopulateDevicePicker(Picker picker, List<AudioDeviceOption> options, string savedKey, string savedLabel)
    {
        int selectedIndex = 0;
        if (!string.IsNullOrEmpty(savedKey))
        {
            int idx = options.FindIndex(o => o.Key == savedKey);
            if (idx >= 0)
            {
                selectedIndex = idx;
            }
            else
            {
                var label = string.IsNullOrWhiteSpace(savedLabel) ? savedKey : savedLabel;
                const string suffix = " (未接続・規定で代用)";
                if (!label.EndsWith(suffix, StringComparison.Ordinal))
                {
                    label += suffix;
                }
                options.Insert(1, new AudioDeviceOption(savedKey, label));
                selectedIndex = 1;
            }
        }

        picker.ItemsSource = options;
        picker.SelectedIndex = selectedIndex;
    }

    private void OnRefreshAudioDevicesClicked(object? sender, EventArgs e)
    {
        var currentOut = OutputDevicePicker.SelectedItem as AudioDeviceOption;
        var currentIn = InputDevicePicker.SelectedItem as AudioDeviceOption;
        LoadAudioDevicePickers(
            overrideOutputKey: currentOut?.Key,
            overrideOutputLabel: StripDisconnectedSuffix(currentOut?.DisplayName),
            overrideInputKey: currentIn?.Key,
            overrideInputLabel: StripDisconnectedSuffix(currentIn?.DisplayName));
    }

    private static string? StripDisconnectedSuffix(string? label)
    {
        if (string.IsNullOrEmpty(label)) return label;
        const string suffix = " (未接続・規定で代用)";
        return label.EndsWith(suffix, StringComparison.Ordinal)
            ? label[..^suffix.Length]
            : label;
    }

    private void OnBatteryOptimizationClicked(object? sender, EventArgs e)
    {
        MainActivity.Instance?.RequestIgnoreBatteryOptimizations();
    }

    private void SetBusy(bool busy, string message = "処理中...")
    {
        SettingsBusyLabel.Text = message;
        SettingsBusyIndicator.IsRunning = busy;
        SettingsBusyOverlay.IsVisible = busy;
    }

    private async void OnSaveClicked(object? sender, EventArgs e)
    {
        SetBusy(true, "設定を保存中...");
        try
        {
            AppConfig.AutoPlayEnabled = AutoPlaySwitch.IsToggled;
            AppConfig.EchoSentEnabled = EchoSentSwitch.IsToggled;
            AppConfig.CallSignEnabled = CallSignSwitch.IsToggled;
            AppConfig.UnreadBadgeEnabled = UnreadBadgeSwitch.IsToggled;
#if ANDROID
            if (!AppConfig.UnreadBadgeEnabled)
            {
                Chatransceiver.Maui.Platforms.Android.Services.ChatFcmService.ClearBadgeEnabledNotifications(
                    global::Android.App.Application.Context);
            }
#endif
            AppConfig.Theme = LightThemeSwitch.IsToggled ? "light" : "dark";
            App.ApplyTheme(AppConfig.Theme);

            AppConfig.RecordingMode = RecordingModePicker.SelectedIndex switch
            {
                1 => "audio_only",
                2 => "text_only",
                _ => "both"
            };

            if (OutputDevicePicker.SelectedItem is AudioDeviceOption selectedOut)
            {
                AppConfig.PreferredAudioOutputKey = selectedOut.Key;
                AppConfig.PreferredAudioOutputLabel = StripDisconnectedSuffix(selectedOut.DisplayName) ?? "システム規定に従う";
            }
            if (InputDevicePicker.SelectedItem is AudioDeviceOption selectedIn)
            {
                AppConfig.PreferredAudioInputKey = selectedIn.Key;
                AppConfig.PreferredAudioInputLabel = StripDisconnectedSuffix(selectedIn.DisplayName) ?? "システム規定に従う";
            }

            if (!string.IsNullOrWhiteSpace(SupabaseUrlEntry.Text))
            {
                AppConfig.SupabaseUrl = SupabaseUrlEntry.Text.Trim();
            }
            if (!string.IsNullOrWhiteSpace(SupabaseKeyEntry.Text))
            {
                AppConfig.SupabaseAnonKey = SupabaseKeyEntry.Text.Trim();
            }

            if (_currentUser != null &&
                !string.IsNullOrWhiteSpace(NicknameEntry.Text) &&
                NicknameEntry.Text.Trim() != _currentUser.Name)
            {
                await SupabaseClientService.Instance.UpdateNicknameAsync(_currentUser.Id, NicknameEntry.Text.Trim());
                _currentUser.Name = NicknameEntry.Text.Trim();
            }

            if (_onSettingsSaved != null)
            {
                await _onSettingsSaved();
            }

            await Navigation.PopModalAsync();
        }
        catch (Exception ex)
        {
            await DisplayAlert("保存エラー", ex.Message, "OK");
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async void OnSignOutClicked(object? sender, EventArgs e)
    {
        bool confirm = await DisplayAlert(
            "ログアウト",
            "アカウントからログアウトしますか？（チャット履歴やグループは削除されません）",
            "ログアウト",
            "キャンセル");
        if (!confirm) return;

        SetBusy(true, "ログアウト処理中...");
        try
        {
            if (_onSignOutRequested != null)
            {
                await _onSignOutRequested();
            }
            await Navigation.PopModalAsync();
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async void OnCloseClicked(object? sender, EventArgs e)
    {
        await Navigation.PopModalAsync();
    }
}
