/**
 * WakeLockService (src/services/wakelock.ts)
 * 常時表示機能 (DEC-026) — Screen Wake Lock API による画面自動消灯の抑止を管理します。
 *
 * ユーザーが能動的にONにしている間、画面の自動ロック・サスペンドを防ぎます。
 * 画面が点いたままになるためアプリは停止されず、メッセージの自動再生 (TTS含む) が
 * 通常どおり動作し続けます。
 *
 * 注意: タブが非表示になるとOSがロックを自動解放する仕様のため、
 * visibilitychange での再取得を内蔵しています。
 */
export class WakeLockService {
  private sentinel: WakeLockSentinel | null = null;

  // ユーザーの意思としてのON/OFF (システムによる一時解放と区別する)
  private enabled = false;

  constructor() {
    // 別アプリから戻ってきた際などにロックを自動で再取得する
    document.addEventListener('visibilitychange', () => {
      if (this.enabled && document.visibilityState === 'visible' && !this.sentinel) {
        this.acquire().catch((e) => {
          console.warn('Wake Lock re-acquisition failed:', e);
        });
      }
    });
  }

  /**
   * Screen Wake Lock API が利用可能な環境か判定
   */
  static isSupported(): boolean {
    return 'wakeLock' in navigator;
  }

  get isActive(): boolean {
    return this.enabled;
  }

  /**
   * 常時表示をONにする (ユーザー操作のハンドラ内から呼び出すこと)
   */
  async enable(): Promise<void> {
    if (this.enabled) return;
    await this.acquire();
    this.enabled = true;
  }

  /**
   * 常時表示をOFFにする
   */
  async disable(): Promise<void> {
    this.enabled = false;
    if (this.sentinel) {
      try {
        await this.sentinel.release();
      } catch (e) {
        // 既に解放済みの場合は無視
      }
      this.sentinel = null;
    }
  }

  private async acquire(): Promise<void> {
    const sentinel = await navigator.wakeLock.request('screen');
    this.sentinel = sentinel;
    sentinel.addEventListener('release', () => {
      // システムによる解放 (タブ非表示等)。enabled は維持し、visibilitychange で再取得する
      if (this.sentinel === sentinel) {
        this.sentinel = null;
      }
    });
  }
}
