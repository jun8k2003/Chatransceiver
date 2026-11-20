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
        var mainPage = new MainPage();
        var window = new Window(new NavigationPage(mainPage)
        {
            BarBackgroundColor = Color.FromArgb("#0F172A"),
            BarTextColor = Colors.White
        });
        window.Activated += async (_, _) => await mainPage.OnAppResumedAsync();
        window.Deactivated += (_, _) => mainPage.OnAppDeactivated();
        window.Stopped += (_, _) => mainPage.OnAppDeactivated();
        return window;
    }

    public static void ApplyTheme(string theme)
    {
        if (Current == null) return;
        Current.UserAppTheme = theme == "light" ? AppTheme.Light : AppTheme.Dark;
    }
}
