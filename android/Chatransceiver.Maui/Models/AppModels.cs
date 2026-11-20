using System.ComponentModel;
using System.Runtime.CompilerServices;
using Microsoft.Maui.Controls.Shapes;

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

    private string _displayTitle = string.Empty;
    public string DisplayTitle
    {
        get => _displayTitle;
        set { if (_displayTitle == value) return; _displayTitle = value; OnPropertyChanged(); }
    }

    private string _subtitle = string.Empty;
    public string Subtitle
    {
        get => _subtitle;
        set { if (_subtitle == value) return; _subtitle = value; OnPropertyChanged(); }
    }

    private bool _isOnline;
    public bool IsOnline
    {
        get => _isOnline;
        set { if (_isOnline == value) return; _isOnline = value; OnPropertyChanged(); }
    }

    private int _unreadCount;
    public int UnreadCount
    {
        get => _unreadCount;
        set
        {
            if (_unreadCount == value) return;
            _unreadCount = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(HasUnread));
            OnPropertyChanged(nameof(UnreadBadgeText));
        }
    }

    private bool _showUnreadBadge = true;
    public bool ShowUnreadBadge
    {
        get => _showUnreadBadge;
        set
        {
            if (_showUnreadBadge == value) return;
            _showUnreadBadge = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(HasUnread));
        }
    }
    public bool HasUnread => ShowUnreadBadge && UnreadCount > 0;
    public string UnreadBadgeText => UnreadCount > 99 ? "99+" : UnreadCount.ToString();

    private bool _isPlaying;
    public bool IsPlaying
    {
        get => _isPlaying;
        set { if (_isPlaying == value) return; _isPlaying = value; OnPropertyChanged(); }
    }

    private bool _isGroupSelectMode;
    public bool IsGroupSelectMode
    {
        get => _isGroupSelectMode;
        set
        {
            if (_isGroupSelectMode == value) return;
            _isGroupSelectMode = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(ShowGroupCheckbox));
            OnPropertyChanged(nameof(GroupCheckboxText));
        }
    }

    private bool _isSelectedForGroup;
    public bool IsSelectedForGroup
    {
        get => _isSelectedForGroup;
        set
        {
            if (_isSelectedForGroup == value) return;
            _isSelectedForGroup = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(GroupCheckboxText));
        }
    }

    public bool ShowGroupCheckbox => IsGroupSelectMode && !IsGroup;
    public string GroupCheckboxText => IsSelectedForGroup ? "☑️" : "⬜";

    private bool _isActiveRoom;
    public bool IsActiveRoom
    {
        get => _isActiveRoom;
        set { if (_isActiveRoom == value) return; _isActiveRoom = value; OnPropertyChanged(); OnPropertyChanged(nameof(RowBackgroundColor)); }
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
    public bool IsWebhook { get; set; }
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

    public string TimeText => CreatedAt.ToLocalTime().ToString("yyyy/MM/dd HH:mm");
    public string PlayButtonLabel => HasAudio ? "▶ 音声再生" : "🔊 読み上げ";

    // 自分の発言は右寄せ（右上角を直角）、相手の発言は左寄せ（左上角を直角）
    public LayoutOptions BubbleHorizontalOptions => IsMine ? LayoutOptions.End : LayoutOptions.Start;
    public Thickness BubbleMargin => IsMine ? new Thickness(56, 4, 0, 4) : new Thickness(0, 4, 56, 4);
    public IShape BubbleStrokeShape => new RoundRectangle
    {
        CornerRadius = IsMine
            ? new CornerRadius(18, 0, 18, 18)
            : new CornerRadius(0, 18, 18, 18)
    };

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

public sealed record AudioDeviceOption(string Key, string DisplayName)
{
    public override string ToString() => DisplayName;
}
