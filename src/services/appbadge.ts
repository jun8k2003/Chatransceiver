import type { SupabaseService } from './supabase';

/** ホーム画面のバッジは補助機能。非対応・通信失敗でもチャットを妨げない。 */
export class AppBadgeService {
  private revision = 0;
  private readonly supabaseService: Pick<SupabaseService, 'getUnreadCount'>;

  constructor(supabaseService: Pick<SupabaseService, 'getUnreadCount'>) {
    this.supabaseService = supabaseService;
  }

  async refresh(userId: string | null, enabled: boolean = true): Promise<void> {
    const revision = ++this.revision;
    if (typeof navigator.setAppBadge !== 'function') return;

    try {
      if (!enabled) {
        if (typeof navigator.clearAppBadge === 'function') {
          await navigator.clearAppBadge();
        }
        return;
      }

      const count = userId ? await this.supabaseService.getUnreadCount(userId) : 0;
      // 古い取得結果で、既読後やログアウト後のバッジを上書きしない。
      if (revision !== this.revision) return;
      if (count === 0) {
        await navigator.clearAppBadge();
      } else {
        await navigator.setAppBadge(count);
      }
    } catch (error) {
      console.warn('Failed to refresh app badge:', error);
    }
  }
}
