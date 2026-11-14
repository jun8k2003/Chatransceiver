using System.Text.Json;

namespace Chatransceiver.Maui.Services;

/// <summary>
/// アプリ設定および認証セッション・環境変数の永続化管理
/// </summary>
public static partial class AppConfig
{
    // GitHub Actions 等のビルド時に AppConfig.Defaults.cs から注入可能
    static partial void LoadBuildDefaults(ref string url, ref string anonKey);

    private static string _defaultUrl = "https://placeholder.supabase.co";
    private static string _defaultAnonKey = "";

    static AppConfig()
    {
        LoadBuildDefaults(ref _defaultUrl, ref _defaultAnonKey);
    }

    public static string SupabaseUrl
    {
        get => Preferences.Default.Get("supabase_url", _defaultUrl).TrimEnd('/');
        set => Preferences.Default.Set("supabase_url", value.TrimEnd('/'));
    }

    public static string SupabaseAnonKey
    {
        get => Preferences.Default.Get("supabase_anon_key", _defaultAnonKey);
        set => Preferences.Default.Set("supabase_anon_key", value);
    }

    public static string? AccessToken
    {
        get => Preferences.Default.Get<string?>("auth_access_token", null);
        set
        {
            if (string.IsNullOrEmpty(value)) Preferences.Default.Remove("auth_access_token");
            else Preferences.Default.Set("auth_access_token", value);
        }
    }

    public static string? RefreshToken
    {
        get => Preferences.Default.Get<string?>("auth_refresh_token", null);
        set
        {
            if (string.IsNullOrEmpty(value)) Preferences.Default.Remove("auth_refresh_token");
            else Preferences.Default.Set("auth_refresh_token", value);
        }
    }

    public static string? CurrentUserId
    {
        get => Preferences.Default.Get<string?>("auth_user_id", null);
        set
        {
            if (string.IsNullOrEmpty(value)) Preferences.Default.Remove("auth_user_id");
            else Preferences.Default.Set("auth_user_id", value);
        }
    }

    public static string? CurrentCommunitySlug
    {
        get => Preferences.Default.Get<string?>("current_community_slug", null);
        set
        {
            if (string.IsNullOrEmpty(value)) Preferences.Default.Remove("current_community_slug");
            else Preferences.Default.Set("current_community_slug", value);
        }
    }

    public static string? ActiveRoomId
    {
        get => Preferences.Default.Get<string?>("active_room_id", null);
        set
        {
            if (string.IsNullOrEmpty(value)) Preferences.Default.Remove("active_room_id");
            else Preferences.Default.Set("active_room_id", value);
        }
    }

    public static string? ActiveRoomTitle
    {
        get => Preferences.Default.Get<string?>("active_room_title", null);
        set
        {
            if (string.IsNullOrEmpty(value)) Preferences.Default.Remove("active_room_title");
            else Preferences.Default.Set("active_room_title", value);
        }
    }

    public static bool AutoPlayEnabled
    {
        get => Preferences.Default.Get("autoplay_enabled", true);
        set => Preferences.Default.Set("autoplay_enabled", value);
    }

    public static bool EchoSentEnabled
    {
        get => Preferences.Default.Get("echo_sent_enabled", true);
        set => Preferences.Default.Set("echo_sent_enabled", value);
    }

    public static bool CallSignEnabled
    {
        get => Preferences.Default.Get("callsign_enabled", true);
        set => Preferences.Default.Set("callsign_enabled", value);
    }

    public static bool UnreadBadgeEnabled
    {
        get => Preferences.Default.Get("unread_badge_enabled", true);
        set => Preferences.Default.Set("unread_badge_enabled", value);
    }

    /// <summary>
    /// 録音モード: "both" (音声+文字起こし) | "audio_only" (録音のみ) | "text_only" (文字起こしのみ)
    /// </summary>
    public static string RecordingMode
    {
        get => Preferences.Default.Get("recording_mode", "both");
        set => Preferences.Default.Set("recording_mode", value);
    }

    /// <summary>
    /// カラーテーマ: "dark" | "light"
    /// </summary>
    public static string Theme
    {
        get => Preferences.Default.Get("app_theme", "dark");
        set => Preferences.Default.Set("app_theme", value);
    }

    public static bool FcmRegistered
    {
        get => Preferences.Default.Get("fcm_registered", false);
        set => Preferences.Default.Set("fcm_registered", value);
    }

    public static string? PendingFcmToken
    {
        get => Preferences.Default.Get<string?>("pending_fcm_token", null);
        set
        {
            if (string.IsNullOrEmpty(value)) Preferences.Default.Remove("pending_fcm_token");
            else Preferences.Default.Set("pending_fcm_token", value);
        }
    }

    public static string GetDeviceUuid()
    {
        var uuid = Preferences.Default.Get<string?>("chatransceiver_device_uuid", null);
        if (string.IsNullOrEmpty(uuid))
        {
            uuid = Guid.NewGuid().ToString();
            Preferences.Default.Set("chatransceiver_device_uuid", uuid);
        }
        return uuid;
    }

    public static List<string> GetCommunityHistory()
    {
        var raw = Preferences.Default.Get("community_history_json", "[]");
        try
        {
            return JsonSerializer.Deserialize<List<string>>(raw) ?? new List<string>();
        }
        catch
        {
            return new List<string>();
        }
    }

    public static void AddCommunityHistory(string slug)
    {
        if (string.IsNullOrWhiteSpace(slug)) return;
        var list = GetCommunityHistory();
        list.RemoveAll(s => string.Equals(s, slug, StringComparison.OrdinalIgnoreCase));
        list.Insert(0, slug);
        Preferences.Default.Set("community_history_json", JsonSerializer.Serialize(list));
    }

    public static void RemoveCommunityHistory(string slug)
    {
        var list = GetCommunityHistory();
        list.RemoveAll(s => string.Equals(s, slug, StringComparison.OrdinalIgnoreCase));
        Preferences.Default.Set("community_history_json", JsonSerializer.Serialize(list));
    }
}
