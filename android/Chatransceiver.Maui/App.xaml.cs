using Chatransceiver.Maui.Services;
using Chatransceiver.Maui.Views;

namespace Chatransceiver.Maui;

public partial class App : Application
{
    public App()
    {
        InitializeComponent();
        ApplyTheme(AppConfig.Theme);
    }

    protected override Window CreateWindow(IActivationState? activationState)
    {
        return new Window(new NavigationPage(new MainPage())
        {
            BarBackgroundColor = Color.FromArgb("#0F172A"),
            BarTextColor = Colors.White
        });
    }

    protected override void OnResume()
    {
        base.OnResume();
        if (Windows.Count > 0 && Windows[0].Page is NavigationPage nav && nav.CurrentPage is MainPage mainPage)
        {
            _ = mainPage.OnAppResumedAsync();
        }
    }

    public static void ApplyTheme(string theme)
    {
        if (Current == null) return;
        Current.UserAppTheme = theme == "light" ? AppTheme.Light : AppTheme.Dark;
    }
}
