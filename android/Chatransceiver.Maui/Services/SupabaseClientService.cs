using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Chatransceiver.Maui.Models;

namespace Chatransceiver.Maui.Services;

/// <summary>
/// SupabaseClientService (src/services/supabase.ts 相当)
/// PostgREST / GoTrue (Auth) / Storage / Edge Functions を HttpClient で直接呼び出す。
/// </summary>
public class SupabaseClientService
{
    public static SupabaseClientService Instance { get; } = new();

    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(25) };

    public const string AuthCallbackScheme = "chatransceiver://auth-callback";

    public event Action<SupabaseUser>? AuthStateChanged;

    private HttpRequestMessage CreateRequest(HttpMethod method, string relativeOrAbsoluteUrl, HttpContent? content = null)
    {
        var url = relativeOrAbsoluteUrl.StartsWith("http", StringComparison.OrdinalIgnoreCase)
            ? relativeOrAbsoluteUrl
            : $"{AppConfig.SupabaseUrl}{relativeOrAbsoluteUrl}";

        var req = new HttpRequestMessage(method, url);
        var anonKey = AppConfig.SupabaseAnonKey;
        var token = !string.IsNullOrEmpty(AppConfig.AccessToken) ? AppConfig.AccessToken : anonKey;

        if (!string.IsNullOrEmpty(anonKey))
        {
            req.Headers.TryAddWithoutValidation("apikey", anonKey);
        }
        if (!string.IsNullOrEmpty(token))
        {
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }

        if (content != null)
        {
            req.Content = content;
        }
        return req;
    }

    private static StringContent JsonBody(object obj)
    {
        var json = JsonSerializer.Serialize(obj);
        return new StringContent(json, Encoding.UTF8, "application/json");
    }

    /// <summary>
    /// 招待URL (https://.../?c=slug&amp;code=...) または slug 文字列からコミュニティ slug を抽出する
    /// </summary>
    public static string ParseCommunitySlugFromInput(string input)
    {
        var trimmed = (input ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(trimmed)) return string.Empty;

        if (trimmed.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
            trimmed.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            if (Uri.TryCreate(trimmed, UriKind.Absolute, out var uri))
            {
                var query = uri.Query.TrimStart('?');
                foreach (var pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
                {
                    var kv = pair.Split('=', 2);
                    if (kv.Length == 2 && kv[0] == "c")
                    {
                        return Uri.UnescapeDataString(kv[1]).Trim();
                    }
                }
            }
        }
        return trimmed;
    }

    /// <summary>
    /// Google OAuth ログイン (chatransceiver://auth-callback)
    /// </summary>
    public async Task<SupabaseUser?> SignInWithGoogleAsync()
    {
        var authUrl = $"{AppConfig.SupabaseUrl}/auth/v1/authorize?provider=google&redirect_to={Uri.EscapeDataString(AuthCallbackScheme)}";
        try
        {
            var result = await WebAuthenticator.Default.AuthenticateAsync(
                new Uri(authUrl),
                new Uri(AuthCallbackScheme));

            if (result.Properties.TryGetValue("access_token", out var accessToken) && !string.IsNullOrEmpty(accessToken))
            {
                AppConfig.AccessToken = accessToken;
                if (result.Properties.TryGetValue("refresh_token", out var refreshToken))
                {
                    AppConfig.RefreshToken = refreshToken;
                }
                var user = await GetCurrentUserAsync();
                if (user != null)
                {
                    AuthStateChanged?.Invoke(user);
                }
                return user;
            }
        }
        catch (TaskCanceledException)
        {
            // ユーザーがブラウザを閉じた場合
        }
        catch (Exception ex)
        {
            // WebAuthenticator が使えない環境向けに外部ブラウザ起動にフォールバック
            System.Diagnostics.Debug.WriteLine($"WebAuthenticator fallback: {ex.Message}");
            await Launcher.Default.OpenAsync(new Uri(authUrl));
        }
        return null;
    }

    /// <summary>
    /// Magic Link (メールOTP) 送信
    /// </summary>
    public async Task SignInWithMagicLinkAsync(string email)
    {
        var url = $"/auth/v1/otp?redirect_to={Uri.EscapeDataString(AuthCallbackScheme)}";
        using var req = CreateRequest(HttpMethod.Post, url, JsonBody(new
        {
            email = email.Trim(),
            create_user = true
        }));
        using var res = await _http.SendAsync(req);
        res.EnsureSuccessStatusCode();
    }

    /// <summary>
    /// chatransceiver://auth-callback#access_token=... のURIからトークンを抽出してセッションを確立する
    /// </summary>
    public async Task<SupabaseUser?> HandleAuthCallbackUriAsync(string uriString)
    {
        try
        {
            var fragmentIndex = uriString.IndexOf('#');
            var queryIndex = uriString.IndexOf('?');
            var paramPart = fragmentIndex >= 0
                ? uriString[(fragmentIndex + 1)..]
                : (queryIndex >= 0 ? uriString[(queryIndex + 1)..] : string.Empty);

            var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var part in paramPart.Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var kv = part.Split('=', 2);
                if (kv.Length == 2)
                {
                    dict[Uri.UnescapeDataString(kv[0])] = Uri.UnescapeDataString(kv[1]);
                }
            }

            if (dict.TryGetValue("access_token", out var accessToken) && !string.IsNullOrEmpty(accessToken))
            {
                AppConfig.AccessToken = accessToken;
                if (dict.TryGetValue("refresh_token", out var refreshToken))
                {
                    AppConfig.RefreshToken = refreshToken;
                }

                var user = await GetCurrentUserAsync();
                if (user != null)
                {
                    MainThread.BeginInvokeOnMainThread(() => AuthStateChanged?.Invoke(user));
                }
                return user;
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"HandleAuthCallbackUriAsync error: {ex.Message}");
        }
        return null;
    }

    /// <summary>
    /// トークンのリフレッシュ
    /// </summary>
    public async Task<bool> RefreshSessionAsync()
    {
        var refresh = AppConfig.RefreshToken;
        if (string.IsNullOrEmpty(refresh)) return false;

        try
        {
            using var req = CreateRequest(HttpMethod.Post, "/auth/v1/token?grant_type=refresh_token", JsonBody(new
            {
                refresh_token = refresh
            }));
            using var res = await _http.SendAsync(req);
            if (!res.IsSuccessStatusCode) return false;

            using var doc = await JsonDocument.ParseAsync(await res.Content.ReadAsStreamAsync());
            var root = doc.RootElement;
            if (root.TryGetProperty("access_token", out var at))
            {
                AppConfig.AccessToken = at.GetString();
            }
            if (root.TryGetProperty("refresh_token", out var rt))
            {
                AppConfig.RefreshToken = rt.GetString();
            }
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// サインアウト (DEC-031: 非破壊切断・データは消さない)
    /// </summary>
    public async Task SignOutAsync()
    {
        try
        {
            if (!string.IsNullOrEmpty(AppConfig.AccessToken))
            {
                using var req = CreateRequest(HttpMethod.Post, "/auth/v1/logout");
                await _http.SendAsync(req);
            }
        }
        catch
        {
            // ネットワーク失敗時もローカルセッションは破棄する
        }
        finally
        {
            AppConfig.AccessToken = null;
            AppConfig.RefreshToken = null;
            AppConfig.CurrentUserId = null;
            AppConfig.CurrentCommunitySlug = null;
            AppConfig.ActiveRoomId = null;
            AppConfig.ActiveRoomTitle = null;
        }
    }

    /// <summary>
    /// 現在のログインユーザー取得 (usersテーブル未登録時は自動Upsert修復)
    /// </summary>
    public async Task<SupabaseUser?> GetCurrentUserAsync()
    {
        if (string.IsNullOrEmpty(AppConfig.AccessToken)) return null;

        using var authReq = CreateRequest(HttpMethod.Get, "/auth/v1/user");
        using var authRes = await _http.SendAsync(authReq);
        if (authRes.StatusCode == System.Net.HttpStatusCode.Unauthorized)
        {
            if (await RefreshSessionAsync())
            {
                using var retryReq = CreateRequest(HttpMethod.Get, "/auth/v1/user");
                using var retryRes = await _http.SendAsync(retryReq);
                if (!retryRes.IsSuccessStatusCode) return null;
                return await ParseAndEnsureUserProfileAsync(await retryRes.Content.ReadAsStringAsync());
            }
            return null;
        }
        if (!authRes.IsSuccessStatusCode) return null;

        return await ParseAndEnsureUserProfileAsync(await authRes.Content.ReadAsStringAsync());
    }

    private async Task<SupabaseUser?> ParseAndEnsureUserProfileAsync(string authUserJson)
    {
        using var doc = JsonDocument.Parse(authUserJson);
        var root = doc.RootElement;
        var uid = root.GetProperty("id").GetString() ?? string.Empty;
        if (string.IsNullOrEmpty(uid)) return null;

        var email = root.TryGetProperty("email", out var em) ? (em.GetString() ?? "") : "";
        var fallbackName = "No Name";
        if (root.TryGetProperty("user_metadata", out var meta) && meta.ValueKind == JsonValueKind.Object)
        {
            if (meta.TryGetProperty("name", out var n) && !string.IsNullOrEmpty(n.GetString()))
                fallbackName = n.GetString()!;
            else if (meta.TryGetProperty("full_name", out var fn) && !string.IsNullOrEmpty(fn.GetString()))
                fallbackName = fn.GetString()!;
        }

        AppConfig.CurrentUserId = uid;

        // users テーブルを検索
        using var profReq = CreateRequest(HttpMethod.Get, $"/rest/v1/users?id=eq.{uid}&select=name");
        using var profRes = await _http.SendAsync(profReq);
        if (profRes.IsSuccessStatusCode)
        {
            using var profDoc = JsonDocument.Parse(await profRes.Content.ReadAsStringAsync());
            if (profDoc.RootElement.ValueKind == JsonValueKind.Array && profDoc.RootElement.GetArrayLength() > 0)
            {
                var first = profDoc.RootElement[0];
                var dbName = first.TryGetProperty("name", out var dn) ? dn.GetString() : null;
                return new SupabaseUser
                {
                    Id = uid,
                    Name = !string.IsNullOrEmpty(dbName) ? dbName! : fallbackName,
                    Email = email
                };
            }
        }

        // プロフィールが存在しない場合は自動作成 (Upsert)
        using var upsertReq = CreateRequest(HttpMethod.Post, "/rest/v1/users?on_conflict=id", JsonBody(new
        {
            id = uid,
            name = fallbackName,
            email = email,
            avatar_url = ""
        }));
        upsertReq.Headers.TryAddWithoutValidation("Prefer", "resolution=merge-duplicates,return=representation");
        using var upsertRes = await _http.SendAsync(upsertReq);

        return new SupabaseUser
        {
            Id = uid,
            Name = fallbackName,
            Email = email
        };
    }

    public async Task UpdateNicknameAsync(string userId, string newName)
    {
        using var req = CreateRequest(HttpMethod.Patch, $"/rest/v1/users?id=eq.{userId}", JsonBody(new
        {
            name = newName.Trim()
        }));
        using var res = await _http.SendAsync(req);
        res.EnsureSuccessStatusCode();
    }

    /// <summary>
    /// コミュニティへの接続 (未存在時は作成、未所属時は user_number を自動採番して参加)
    /// </summary>
    public async Task<SupabaseCommunity> ConnectCommunityAsync(string userId, string slugOrInviteUrl)
    {
        var slug = ParseCommunitySlugFromInput(slugOrInviteUrl);
        if (string.IsNullOrWhiteSpace(slug))
            throw new ArgumentException("コミュニティIDが空です。");

        SupabaseCommunity? community = null;

        // 1. 既存コミュニティの検索
        using (var getReq = CreateRequest(HttpMethod.Get, $"/rest/v1/communities?slug=eq.{Uri.EscapeDataString(slug)}&select=*"))
        using (var getRes = await _http.SendAsync(getReq))
        {
            if (getRes.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(await getRes.Content.ReadAsStringAsync());
                if (doc.RootElement.ValueKind == JsonValueKind.Array && doc.RootElement.GetArrayLength() > 0)
                {
                    var el = doc.RootElement[0];
                    community = new SupabaseCommunity
                    {
                        Id = el.GetProperty("id").GetString()!,
                        Name = el.GetProperty("name").GetString() ?? slug,
                        Slug = el.GetProperty("slug").GetString() ?? slug
                    };
                }
            }
        }

        // 無ければ新規作成
        if (community == null)
        {
            using var createReq = CreateRequest(HttpMethod.Post, "/rest/v1/communities", JsonBody(new
            {
                name = $"{slug.ToUpperInvariant()} コミュニティ",
                slug = slug,
                invite_code = "code_" + slug
            }));
            createReq.Headers.TryAddWithoutValidation("Prefer", "return=representation");
            using var createRes = await _http.SendAsync(createReq);
            createRes.EnsureSuccessStatusCode();

            using var doc = JsonDocument.Parse(await createRes.Content.ReadAsStringAsync());
            var el = doc.RootElement[0];
            community = new SupabaseCommunity
            {
                Id = el.GetProperty("id").GetString()!,
                Name = el.GetProperty("name").GetString() ?? slug,
                Slug = el.GetProperty("slug").GetString() ?? slug
            };
        }

        // 2. 既に参加しているか確認
        bool isMember = false;
        using (var memReq = CreateRequest(HttpMethod.Get, $"/rest/v1/community_members?community_id=eq.{community.Id}&user_id=eq.{userId}&select=user_number"))
        using (var memRes = await _http.SendAsync(memReq))
        {
            if (memRes.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(await memRes.Content.ReadAsStringAsync());
                isMember = doc.RootElement.ValueKind == JsonValueKind.Array && doc.RootElement.GetArrayLength() > 0;
            }
        }

        if (!isMember)
        {
            // 最大 user_number を取得して +1
            int nextNumber = 1;
            using (var maxReq = CreateRequest(HttpMethod.Get, $"/rest/v1/community_members?community_id=eq.{community.Id}&select=user_number&order=user_number.desc&limit=1"))
            using (var maxRes = await _http.SendAsync(maxReq))
            {
                if (maxRes.IsSuccessStatusCode)
                {
                    using var doc = JsonDocument.Parse(await maxRes.Content.ReadAsStringAsync());
                    if (doc.RootElement.ValueKind == JsonValueKind.Array && doc.RootElement.GetArrayLength() > 0)
                    {
                        nextNumber = doc.RootElement[0].GetProperty("user_number").GetInt32() + 1;
                    }
                }
            }

            using var joinReq = CreateRequest(HttpMethod.Post, "/rest/v1/community_members?on_conflict=community_id,user_id", JsonBody(new
            {
                community_id = community.Id,
                user_id = userId,
                user_number = nextNumber
            }));
            joinReq.Headers.TryAddWithoutValidation("Prefer", "resolution=merge-duplicates");
            using var joinRes = await _http.SendAsync(joinReq);
            joinRes.EnsureSuccessStatusCode();
        }

        AppConfig.CurrentCommunitySlug = community.Slug;
        AppConfig.AddCommunityHistory(community.Slug);
        return community;
    }

    /// <summary>
    /// コミュニティからの退会 (leave_community_and_cleanup RPC)
    /// </summary>
    public async Task LeaveCommunityAsync(string userId, string communityId)
    {
        using var req = CreateRequest(HttpMethod.Post, "/rest/v1/rpc/leave_community_and_cleanup", JsonBody(new
        {
            p_user_id = userId,
            p_community_id = communityId
        }));
        using var res = await _http.SendAsync(req);
        res.EnsureSuccessStatusCode();
    }

    /// <summary>
    /// コミュニティ所属メンバー一覧取得 (自分自身は除外 DEC-021)
    /// </summary>
    public async Task<List<SupabaseMember>> GetCommunityMembersAsync(string communityId, string currentUserId)
    {
        using var req = CreateRequest(HttpMethod.Get, $"/rest/v1/community_members?community_id=eq.{communityId}&select=user_number,users(id,name)&order=user_number.asc");
        using var res = await _http.SendAsync(req);
        res.EnsureSuccessStatusCode();

        var list = new List<SupabaseMember>();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            if (!item.TryGetProperty("users", out var u) || u.ValueKind != JsonValueKind.Object) continue;
            var uid = u.GetProperty("id").GetString() ?? "";
            if (uid == currentUserId) continue;

            list.Add(new SupabaseMember
            {
                Id = uid,
                Name = u.TryGetProperty("name", out var n) ? (n.GetString() ?? "No Name") : "No Name",
                UserNumber = item.TryGetProperty("user_number", out var un) ? un.GetInt32() : 0
            });
        }
        return list;
    }

    /// <summary>
    /// 個別チャットの未読件数集計 (DEC-034: 接続中コミュニティで絞り込み)
    /// </summary>
    public async Task<Dictionary<string, (int Count, long LatestTime)>> GetUnreadIndividualCountsAsync(string userId, string communityId)
    {
        var result = new Dictionary<string, (int Count, long LatestTime)>();
        var url = $"/rest/v1/user_inboxes?user_id=eq.{userId}&is_read=eq.false&select=messages!inner(sender_id,created_at),chat_rooms!inner(type,community_id)&chat_rooms.type=eq.individual&chat_rooms.community_id=eq.{communityId}";

        using var req = CreateRequest(HttpMethod.Get, url);
        using var res = await _http.SendAsync(req);
        if (!res.IsSuccessStatusCode) return result;

        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            if (!item.TryGetProperty("messages", out var msg) || msg.ValueKind != JsonValueKind.Object) continue;
            var senderId = msg.TryGetProperty("sender_id", out var sid) ? sid.GetString() : null;
            if (string.IsNullOrEmpty(senderId)) continue;

            long createdMs = 0;
            if (msg.TryGetProperty("created_at", out var ca) && DateTimeOffset.TryParse(ca.GetString(), out var dto))
            {
                createdMs = dto.ToUnixTimeMilliseconds();
            }

            if (result.TryGetValue(senderId!, out var prev))
            {
                result[senderId!] = (prev.Count + 1, Math.Max(prev.LatestTime, createdMs));
            }
            else
            {
                result[senderId!] = (1, createdMs);
            }
        }
        return result;
    }

    /// <summary>
    /// コミュニティ内のグループチャット一覧を取得
    /// </summary>
    public async Task<List<SupabaseGroup>> GetCommunityGroupsAsync(string communityId, string userId)
    {
        var result = new List<SupabaseGroup>();
        using var req = CreateRequest(HttpMethod.Get, $"/rest/v1/chat_room_members?user_id=eq.{userId}&select=room_id,chat_rooms(id,type,community_id,name)");
        using var res = await _http.SendAsync(req);
        if (!res.IsSuccessStatusCode) return result;

        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        var groupRooms = new List<(string Id, string? CustomName)>();
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            if (!item.TryGetProperty("chat_rooms", out var cr) || cr.ValueKind != JsonValueKind.Object) continue;
            var type = cr.TryGetProperty("type", out var t) ? t.GetString() : "";
            var cid = cr.TryGetProperty("community_id", out var c) ? c.GetString() : "";
            if (type == "group" && cid == communityId)
            {
                var id = cr.GetProperty("id").GetString()!;
                var name = cr.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null;
                groupRooms.Add((id, name));
            }
        }

        foreach (var room in groupRooms)
        {
            using var mReq = CreateRequest(HttpMethod.Get, $"/rest/v1/chat_room_members?room_id=eq.{room.Id}&select=users(name)");
            using var mRes = await _http.SendAsync(mReq);
            if (!mRes.IsSuccessStatusCode) continue;

            using var mDoc = JsonDocument.Parse(await mRes.Content.ReadAsStringAsync());
            if (mDoc.RootElement.ValueKind != JsonValueKind.Array || mDoc.RootElement.GetArrayLength() <= 2)
                continue;

            var names = new List<string>();
            foreach (var m in mDoc.RootElement.EnumerateArray())
            {
                if (m.TryGetProperty("users", out var u) && u.ValueKind == JsonValueKind.Object && u.TryGetProperty("name", out var n))
                {
                    names.Add(n.GetString() ?? "No Name");
                }
            }
            var memberNames = string.Join(", ", names);
            var groupName = !string.IsNullOrEmpty(room.CustomName) ? room.CustomName! : memberNames;

            // 未読件数
            int unreadCount = 0;
            using var uReq = CreateRequest(HttpMethod.Get, $"/rest/v1/user_inboxes?room_id=eq.{room.Id}&user_id=eq.{userId}&is_read=eq.false&select=id");
            using var uRes = await _http.SendAsync(uReq);
            if (uRes.IsSuccessStatusCode)
            {
                using var uDoc = JsonDocument.Parse(await uRes.Content.ReadAsStringAsync());
                if (uDoc.RootElement.ValueKind == JsonValueKind.Array)
                {
                    unreadCount = uDoc.RootElement.GetArrayLength();
                }
            }

            result.Add(new SupabaseGroup
            {
                Id = room.Id,
                Name = string.IsNullOrEmpty(groupName) ? "名称未設定グループ" : groupName,
                CustomName = room.CustomName,
                MemberNames = memberNames,
                MemberCount = names.Count,
                UnreadCount = unreadCount
            });
        }

        return result;
    }

    /// <summary>
    /// グループ名（あだ名）の更新 (DEC-023)
    /// </summary>
    public async Task UpdateRoomNameAsync(string roomId, string newName)
    {
        var trimmed = (newName ?? string.Empty).Trim();
        using var req = CreateRequest(HttpMethod.Patch, $"/rest/v1/chat_rooms?id=eq.{roomId}", JsonBody(new
        {
            name = string.IsNullOrEmpty(trimmed) ? null : trimmed
        }));
        using var res = await _http.SendAsync(req);
        res.EnsureSuccessStatusCode();
    }

    /// <summary>
    /// 1対1の個別チャットルームを取得または作成
    /// </summary>
    public async Task<string> GetOrCreateIndividualRoomAsync(string communityId, string currentUserId, string targetUserId)
    {
        using var myReq = CreateRequest(HttpMethod.Get, $"/rest/v1/chat_room_members?user_id=eq.{currentUserId}&select=room_id,chat_rooms(id,type,community_id)");
        using var myRes = await _http.SendAsync(myReq);
        myRes.EnsureSuccessStatusCode();

        var candidateRoomIds = new List<string>();
        using (var doc = JsonDocument.Parse(await myRes.Content.ReadAsStringAsync()))
        {
            foreach (var r in doc.RootElement.EnumerateArray())
            {
                if (!r.TryGetProperty("chat_rooms", out var cr) || cr.ValueKind != JsonValueKind.Object) continue;
                var type = cr.TryGetProperty("type", out var t) ? t.GetString() : "";
                var cid = cr.TryGetProperty("community_id", out var c) ? c.GetString() : "";
                if (type == "individual" && cid == communityId)
                {
                    candidateRoomIds.Add(r.GetProperty("room_id").GetString()!);
                }
            }
        }

        if (candidateRoomIds.Count > 0)
        {
            var inList = string.Join(",", candidateRoomIds);
            using var matchReq = CreateRequest(HttpMethod.Get, $"/rest/v1/chat_room_members?room_id=in.({inList})&user_id=eq.{targetUserId}&select=room_id&limit=1");
            using var matchRes = await _http.SendAsync(matchReq);
            if (matchRes.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(await matchRes.Content.ReadAsStringAsync());
                if (doc.RootElement.ValueKind == JsonValueKind.Array && doc.RootElement.GetArrayLength() > 0)
                {
                    return doc.RootElement[0].GetProperty("room_id").GetString()!;
                }
            }
        }

        // 新規作成
        using var createRoomReq = CreateRequest(HttpMethod.Post, "/rest/v1/chat_rooms", JsonBody(new
        {
            type = "individual",
            community_id = communityId
        }));
        createRoomReq.Headers.TryAddWithoutValidation("Prefer", "return=representation");
        using var createRoomRes = await _http.SendAsync(createRoomReq);
        createRoomRes.EnsureSuccessStatusCode();

        string newRoomId;
        using (var doc = JsonDocument.Parse(await createRoomRes.Content.ReadAsStringAsync()))
        {
            newRoomId = doc.RootElement[0].GetProperty("id").GetString()!;
        }

        using var addMemReq = CreateRequest(HttpMethod.Post, "/rest/v1/chat_room_members", JsonBody(new[]
        {
            new { room_id = newRoomId, user_id = currentUserId },
            new { room_id = newRoomId, user_id = targetUserId }
        }));
        using var addMemRes = await _http.SendAsync(addMemReq);
        addMemRes.EnsureSuccessStatusCode();

        return newRoomId;
    }

    /// <summary>
    /// 複数選択されたメンバーでグループチャットを作成（同一メンバー構成の既存グループがあればそれを返す DEC-011）
    /// </summary>
    public async Task<string> CreateGroupRoomAsync(string communityId, string currentUserId, List<string> memberUserIds)
    {
        var allUserIds = memberUserIds.Append(currentUserId).Distinct().OrderBy(x => x).ToList();

        // 既存グループでメンバー構成が完全一致するものがあるかチェック
        using (var myReq = CreateRequest(HttpMethod.Get, $"/rest/v1/chat_room_members?user_id=eq.{currentUserId}&select=room_id,chat_rooms(id,type,community_id)"))
        using (var myRes = await _http.SendAsync(myReq))
        {
            if (myRes.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(await myRes.Content.ReadAsStringAsync());
                foreach (var r in doc.RootElement.EnumerateArray())
                {
                    if (!r.TryGetProperty("chat_rooms", out var cr) || cr.ValueKind != JsonValueKind.Object) continue;
                    if (cr.TryGetProperty("type", out var t) && t.GetString() == "group" &&
                        cr.TryGetProperty("community_id", out var c) && c.GetString() == communityId)
                    {
                        var rid = r.GetProperty("room_id").GetString()!;
                        using var mReq = CreateRequest(HttpMethod.Get, $"/rest/v1/chat_room_members?room_id=eq.{rid}&select=user_id");
                        using var mRes = await _http.SendAsync(mReq);
                        if (mRes.IsSuccessStatusCode)
                        {
                            using var mDoc = JsonDocument.Parse(await mRes.Content.ReadAsStringAsync());
                            var rMembers = mDoc.RootElement.EnumerateArray()
                                .Select(x => x.GetProperty("user_id").GetString() ?? "")
                                .OrderBy(x => x)
                                .ToList();
                            if (rMembers.SequenceEqual(allUserIds))
                            {
                                return rid;
                            }
                        }
                    }
                }
            }
        }

        // 新規作成
        using var createReq = CreateRequest(HttpMethod.Post, "/rest/v1/chat_rooms", JsonBody(new
        {
            type = "group",
            community_id = communityId
        }));
        createReq.Headers.TryAddWithoutValidation("Prefer", "return=representation");
        using var createRes = await _http.SendAsync(createReq);
        createRes.EnsureSuccessStatusCode();

        string newRoomId;
        using (var doc = JsonDocument.Parse(await createRes.Content.ReadAsStringAsync()))
        {
            newRoomId = doc.RootElement[0].GetProperty("id").GetString()!;
        }

        var inserts = allUserIds.Select(uid => new { room_id = newRoomId, user_id = uid }).ToArray();
        using var memInsertReq = CreateRequest(HttpMethod.Post, "/rest/v1/chat_room_members", JsonBody(inserts));
        using var memInsertRes = await _http.SendAsync(memInsertReq);
        memInsertRes.EnsureSuccessStatusCode();

        return newRoomId;
    }

    /// <summary>
    /// 指定したルームの過去メッセージ履歴を取得
    /// </summary>
    public async Task<List<SupabaseMessage>> GetRoomMessagesAsync(string roomId, string currentUserId)
    {
        var url = $"/rest/v1/messages?room_id=eq.{roomId}&select=id,room_id,sender_id,audio_url,text_content,is_revoked,created_at,users(name)&order=created_at.asc";
        using var req = CreateRequest(HttpMethod.Get, url);
        using var res = await _http.SendAsync(req);
        res.EnsureSuccessStatusCode();

        var list = new List<SupabaseMessage>();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        foreach (var el in doc.RootElement.EnumerateArray())
        {
            list.Add(ParseMessageElement(el, currentUserId));
        }
        return list;
    }

    public static SupabaseMessage ParseMessageElement(JsonElement el, string currentUserId)
    {
        var senderId = el.TryGetProperty("sender_id", out var sid) && sid.ValueKind == JsonValueKind.String
            ? sid.GetString()!
            : "";
        var senderName = "No Name";
        if (el.TryGetProperty("users", out var u) && u.ValueKind == JsonValueKind.Object && u.TryGetProperty("name", out var n))
        {
            senderName = n.GetString() ?? "No Name";
        }

        var createdAt = DateTime.UtcNow;
        if (el.TryGetProperty("created_at", out var ca) && DateTime.TryParse(ca.GetString(), out var parsedDate))
        {
            createdAt = parsedDate;
        }

        return new SupabaseMessage
        {
            Id = el.GetProperty("id").GetString() ?? "",
            RoomId = el.TryGetProperty("room_id", out var rid) ? (rid.GetString() ?? "") : "",
            SenderId = senderId,
            SenderName = senderName,
            AudioUrl = el.TryGetProperty("audio_url", out var au) && au.ValueKind == JsonValueKind.String ? au.GetString() : null,
            TextContent = el.TryGetProperty("text_content", out var tc) && tc.ValueKind == JsonValueKind.String ? (tc.GetString() ?? "") : "",
            IsRevoked = el.TryGetProperty("is_revoked", out var ir) && ir.ValueKind == JsonValueKind.True,
            CreatedAt = createdAt,
            IsMine = senderId == currentUserId
        };
    }

    /// <summary>
    /// メッセージ送信（WAV音声アップロード + messages INSERT）
    /// </summary>
    public async Task<SupabaseMessage> SendMessageAsync(
        string roomId,
        string senderId,
        string text,
        byte[]? wavBytes = null,
        bool needsTranscription = false)
    {
        string? audioUrl = null;

        if (wavBytes != null && wavBytes.Length > 0)
        {
            var fileName = $"{senderId}/{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.wav";
            var uploadContent = new ByteArrayContent(wavBytes);
            uploadContent.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");

            using var uploadReq = CreateRequest(HttpMethod.Post, $"/storage/v1/object/voice-messages/{fileName}", uploadContent);
            uploadReq.Headers.TryAddWithoutValidation("cache-control", "3600");
            using var uploadRes = await _http.SendAsync(uploadReq);
            uploadRes.EnsureSuccessStatusCode();

            audioUrl = $"{AppConfig.SupabaseUrl}/storage/v1/object/public/voice-messages/{fileName}";
        }

        using var insertReq = CreateRequest(
            HttpMethod.Post,
            "/rest/v1/messages?select=id,room_id,sender_id,audio_url,text_content,is_revoked,created_at,users(name)",
            JsonBody(new
            {
                room_id = roomId,
                sender_id = senderId,
                audio_url = audioUrl,
                text_content = text,
                needs_transcription = needsTranscription
            }));
        insertReq.Headers.TryAddWithoutValidation("Prefer", "return=representation");

        using var insertRes = await _http.SendAsync(insertReq);
        insertRes.EnsureSuccessStatusCode();

        using var doc = JsonDocument.Parse(await insertRes.Content.ReadAsStringAsync());
        return ParseMessageElement(doc.RootElement[0], senderId);
    }

    /// <summary>
    /// 発言の取り消し (Storageから音声ファイル削除 + messages行を無効化)
    /// </summary>
    public async Task RevokeMessageAsync(string messageId, string currentUserId)
    {
        using var getReq = CreateRequest(HttpMethod.Get, $"/rest/v1/messages?id=eq.{messageId}&select=audio_url,sender_id");
        using var getRes = await _http.SendAsync(getReq);
        getRes.EnsureSuccessStatusCode();

        string? audioUrl = null;
        using (var doc = JsonDocument.Parse(await getRes.Content.ReadAsStringAsync()))
        {
            if (doc.RootElement.GetArrayLength() == 0) return;
            var el = doc.RootElement[0];
            var senderId = el.GetProperty("sender_id").GetString();
            if (senderId != currentUserId) throw new UnauthorizedAccessException("自分の発言のみ取り消し可能です。");
            if (el.TryGetProperty("audio_url", out var au) && au.ValueKind == JsonValueKind.String)
            {
                audioUrl = au.GetString();
            }
        }

        if (!string.IsNullOrEmpty(audioUrl))
        {
            const string marker = "/voice-messages/";
            var idx = audioUrl.IndexOf(marker, StringComparison.Ordinal);
            if (idx >= 0)
            {
                var filePath = audioUrl[(idx + marker.Length)..].Split('?')[0];
                using var delStorageReq = CreateRequest(HttpMethod.Delete, "/storage/v1/object/voice-messages", JsonBody(new
                {
                    prefixes = new[] { filePath }
                }));
                await _http.SendAsync(delStorageReq);
            }
        }

        using var patchReq = CreateRequest(HttpMethod.Patch, $"/rest/v1/messages?id=eq.{messageId}", JsonBody(new
        {
            is_revoked = true,
            text_content = (string?)null,
            audio_url = (string?)null
        }));
        using var patchRes = await _http.SendAsync(patchReq);
        patchRes.EnsureSuccessStatusCode();
    }

    /// <summary>
    /// 部屋を開いた際の既読化
    /// </summary>
    public async Task MarkAsReadAsync(string roomId, string userId)
    {
        try
        {
            using var req = CreateRequest(HttpMethod.Patch, $"/rest/v1/user_inboxes?room_id=eq.{roomId}&user_id=eq.{userId}&is_read=eq.false", JsonBody(new
            {
                is_read = true
            }));
            await _http.SendAsync(req);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"MarkAsReadAsync error: {ex.Message}");
        }
    }

    /// <summary>
    /// グループまたは個別チャット履歴の削除
    /// </summary>
    public async Task DeleteGroupAsync(string roomId)
    {
        using var req = CreateRequest(HttpMethod.Delete, $"/rest/v1/chat_rooms?id=eq.{roomId}");
        using var res = await _http.SendAsync(req);
        res.EnsureSuccessStatusCode();
    }

    public async Task DeleteMessagesAsync(string roomId)
    {
        using var req = CreateRequest(HttpMethod.Delete, $"/rest/v1/messages?room_id=eq.{roomId}");
        using var res = await _http.SendAsync(req);
        res.EnsureSuccessStatusCode();
    }

    /// <summary>
    /// FCMトークンを register-fcm-token Edge Function に登録
    /// </summary>
    public async Task<bool> RegisterFcmTokenAsync(string fcmToken)
    {
        if (string.IsNullOrEmpty(AppConfig.AccessToken) || string.IsNullOrEmpty(fcmToken)) return false;

        try
        {
            using var req = CreateRequest(HttpMethod.Post, "/functions/v1/register-fcm-token", JsonBody(new
            {
                action = "register",
                device_uuid = AppConfig.GetDeviceUuid(),
                fcm_token = fcmToken
            }));
            using var res = await _http.SendAsync(req);
            if (res.IsSuccessStatusCode)
            {
                AppConfig.FcmRegistered = true;
                return true;
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"RegisterFcmTokenAsync error: {ex.Message}");
        }
        return false;
    }

    /// <summary>
    /// FCMトークンの登録解除 (ログアウト時 DEC-031)
    /// </summary>
    public async Task<bool> UnregisterFcmTokenAsync()
    {
        if (string.IsNullOrEmpty(AppConfig.AccessToken)) return false;

        try
        {
            using var req = CreateRequest(HttpMethod.Post, "/functions/v1/register-fcm-token", JsonBody(new
            {
                action = "unregister",
                device_uuid = AppConfig.GetDeviceUuid()
            }));
            using var res = await _http.SendAsync(req);
            if (res.IsSuccessStatusCode)
            {
                AppConfig.FcmRegistered = false;
                return true;
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"UnregisterFcmTokenAsync error: {ex.Message}");
        }
        return false;
    }
}
