using Chatransceiver.Maui.Models;
using Chatransceiver.Maui.Services;

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
        CallSignSwitch.IsToggled = AppConfig.CallSignEnabled;
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
    }

    private void OnBatteryOptimizationClicked(object? sender, EventArgs e)
    {
        MainActivity.Instance?.RequestIgnoreBatteryOptimizations();
    }

    private async void OnSaveClicked(object? sender, EventArgs e)
    {
        try
        {
            AppConfig.AutoPlayEnabled = AutoPlaySwitch.IsToggled;
            AppConfig.CallSignEnabled = CallSignSwitch.IsToggled;
            AppConfig.Theme = LightThemeSwitch.IsToggled ? "light" : "dark";
            App.ApplyTheme(AppConfig.Theme);

            AppConfig.RecordingMode = RecordingModePicker.SelectedIndex switch
            {
                1 => "audio_only",
                2 => "text_only",
                _ => "both"
            };

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
    }

    private async void OnSignOutClicked(object? sender, EventArgs e)
    {
        bool confirm = await DisplayAlert(
            "ログアウト",
            "アカウントからログアウトしますか？（チャット履歴やグループは削除されません）",
            "ログアウト",
            "キャンセル");
        if (!confirm) return;

        await Navigation.PopModalAsync();
        if (_onSignOutRequested != null)
        {
            await _onSignOutRequested();
        }
    }

    private async void OnCloseClicked(object? sender, EventArgs e)
    {
        await Navigation.PopModalAsync();
    }
}
