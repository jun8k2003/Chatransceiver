using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace Chatransceiver.Maui.Models;

public class SupabaseUser
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
}

public class SupabaseCommunity
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Slug { get; set; } = string.Empty;
}

public class SupabaseMember
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public int UserNumber { get; set; }
    public bool IsOnline { get; set; }
    public int UnreadCount { get; set; }
    public long LatestUnreadTime { get; set; }
}

public class SupabaseGroup
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string? CustomName { get; set; }
    public string MemberNames { get; set; } = string.Empty;
    public int MemberCount { get; set; }
    public int UnreadCount { get; set; }
    public long LatestUnreadTime { get; set; }
}

/// <summary>
/// 統合リスト（個別メンバー行・グループ行）の1行を表すViewModelモデル (DEC-024)
/// </summary>
public class UnifiedListItem : INotifyPropertyChanged
{
    public string Id { get; set; } = string.Empty;
    public bool IsGroup { get; set; }
    public string DisplayTitle { get; set; } = string.Empty;
    public string Subtitle { get; set; } = string.Empty;
    public bool IsOnline { get; set; }
    public int UnreadCount { get; set; }
    public bool HasUnread => UnreadCount > 0;
    public string UnreadBadgeText => UnreadCount > 99 ? "99+" : UnreadCount.ToString();

    private bool _isPlaying;
    public bool IsPlaying
    {
        get => _isPlaying;
        set { _isPlaying = value; OnPropertyChanged(); }
    }

    private bool _isSelectedForGroup;
    public bool IsSelectedForGroup
    {
        get => _isSelectedForGroup;
        set { _isSelectedForGroup = value; OnPropertyChanged(); }
    }

    private bool _isActiveRoom;
    public bool IsActiveRoom
    {
        get => _isActiveRoom;
        set { _isActiveRoom = value; OnPropertyChanged(); OnPropertyChanged(nameof(RowBackgroundColor)); }
    }

    public Color RowBackgroundColor => IsActiveRoom
        ? Color.FromArgb("#1E3A8A")
        : Colors.Transparent;

    public event PropertyChangedEventHandler? PropertyChanged;
    protected void OnPropertyChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

public class SupabaseMessage : INotifyPropertyChanged
{
    public string Id { get; set; } = string.Empty;
    public string RoomId { get; set; } = string.Empty;
    public string SenderId { get; set; } = string.Empty;
    public string SenderName { get; set; } = string.Empty;
    public string? AudioUrl { get; set; }
    public string TextContent { get; set; } = string.Empty;
    public bool IsRevoked { get; set; }
    public DateTime CreatedAt { get; set; }
    public bool IsMine { get; set; }

    public bool HasAudio => !IsRevoked && !string.IsNullOrEmpty(AudioUrl);
    public bool CanPlay => !IsRevoked && (!string.IsNullOrEmpty(AudioUrl) || !string.IsNullOrEmpty(TextContent));
    public bool CanRevoke => IsMine && !IsRevoked;

    public string DisplayText => IsRevoked
        ? "この発言は取り消しされました。"
        : (string.IsNullOrEmpty(TextContent) ? "🎤 音声メッセージ" : TextContent);

    public string TimeText => CreatedAt.ToLocalTime().ToString("HH:mm");
    public string PlayButtonLabel => HasAudio ? "▶ 音声再生" : "🔊 読み上げ";

    public event PropertyChangedEventHandler? PropertyChanged;
    public void NotifyChanged()
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(IsRevoked)));
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(DisplayText)));
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(CanPlay)));
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(CanRevoke)));
    }
}

public class QueueItem
{
    public string Id { get; set; } = string.Empty;
    public string Type { get; set; } = "audio"; // "audio" | "text"
    public string Content { get; set; } = string.Empty;
    public string SenderName { get; set; } = string.Empty;
    public string RoomId { get; set; } = string.Empty;
    public Action? OnPlayStart { get; set; }
    public Action? OnPlayEnd { get; set; }
}

public class RecordingResult
{
    public byte[]? WavBytes { get; set; }
    public string Transcript { get; set; } = string.Empty;
    public bool NeedsTranscription { get; set; }
}
