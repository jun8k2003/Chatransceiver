using Android.App;
using Android.Content;
using Android.Content.PM;
using Android.OS;
using Chatransceiver.Maui.Services;

namespace Chatransceiver.Maui.Platforms.Android;

/// <summary>
/// Google OAuth および Magic Link のカスタムURLスキーム (chatransceiver://auth-callback) を受け取る Activity。
/// WebAuthenticator 経由およびメールアプリのリンクタップの両方に対応する。
/// </summary>
[Activity(NoHistory = true, LaunchMode = LaunchMode.SingleTop, Exported = true)]
[IntentFilter(
    new[] { Intent.ActionView },
    Categories = new[] { Intent.CategoryDefault, Intent.CategoryBrowsable },
    DataScheme = "chatransceiver",
    DataHost = "auth-callback")]
public class WebAuthCallbackActivity : Microsoft.Maui.Authentication.WebAuthenticatorCallbackActivity
{
    protected override void OnCreate(Bundle? savedInstanceState)
    {
        base.OnCreate(savedInstanceState);

        // Magic Link 等、WebAuthenticator セッション外から直接起動された場合もトークンを取り込む
        var uriStr = Intent?.Data?.ToString();
        if (!string.IsNullOrEmpty(uriStr))
        {
            _ = SupabaseClientService.Instance.HandleAuthCallbackUriAsync(uriStr);
        }
    }
}
