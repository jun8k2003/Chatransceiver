using Android;
using Android.App;
using Android.Content;
using Android.Content.PM;
using Android.OS;
using AndroidX.Core.App;
using AndroidX.Core.Content;
using Chatransceiver.Maui.Services;

namespace Chatransceiver.Maui;

[Activity(
    Theme = "@style/Maui.SplashTheme",
    MainLauncher = true,
    LaunchMode = LaunchMode.SingleTop,
    ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode | ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
public class MainActivity : MauiAppCompatActivity
{
    public static MainActivity? Instance { get; private set; }

    protected override void OnCreate(Bundle? savedInstanceState)
    {
        base.OnCreate(savedInstanceState);
        Instance = this;
        RequestRuntimePermissionsIfNeeded();
        HandleIntent(Intent);
    }

    protected override void OnNewIntent(Intent? intent)
    {
        base.OnNewIntent(intent);
        HandleIntent(intent);
    }

    private void HandleIntent(Intent? intent)
    {
        if (intent?.Data != null)
        {
            var uriStr = intent.Data.ToString();
            if (!string.IsNullOrEmpty(uriStr) && uriStr.StartsWith("chatransceiver://", StringComparison.OrdinalIgnoreCase))
            {
                _ = SupabaseClientService.Instance.HandleAuthCallbackUriAsync(uriStr);
            }
        }
    }

    public void RequestRuntimePermissionsIfNeeded()
    {
        var needed = new List<string>();

        if (ContextCompat.CheckSelfPermission(this, Manifest.Permission.RecordAudio) != Permission.Granted)
        {
            needed.Add(Manifest.Permission.RecordAudio);
        }

        if (OperatingSystem.IsAndroidVersionAtLeast(33))
        {
            if (ContextCompat.CheckSelfPermission(this, Manifest.Permission.PostNotifications) != Permission.Granted)
            {
                needed.Add(Manifest.Permission.PostNotifications);
            }
        }

        if (OperatingSystem.IsAndroidVersionAtLeast(31))
        {
            if (ContextCompat.CheckSelfPermission(this, Manifest.Permission.BluetoothConnect) != Permission.Granted)
            {
                needed.Add(Manifest.Permission.BluetoothConnect);
            }
        }

        if (needed.Count > 0)
        {
            ActivityCompat.RequestPermissions(this, needed.ToArray(), 1001);
        }
    }

    /// <summary>
    /// DeepSleep中のFCM着信再生やPTTをOSに遮断されないよう、バッテリー最適化の除外設定画面を案内する
    /// </summary>
    public void RequestIgnoreBatteryOptimizations()
    {
        if (Build.VERSION.SdkInt >= BuildVersionCodes.M)
        {
            var pm = (PowerManager?)GetSystemService(PowerService);
            if (pm != null && !pm.IsIgnoringBatteryOptimizations(PackageName))
            {
                try
                {
                    var intent = new Intent(Android.Provider.Settings.ActionRequestIgnoreBatteryOptimizations);
                    intent.SetData(Android.Net.Uri.Parse($"package:{PackageName}"));
                    StartActivity(intent);
                }
                catch
                {
                    // 一部端末で非対応の場合は無視
                }
            }
        }
    }
}
