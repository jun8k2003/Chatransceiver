/**
 * MediaButtonPttService (src/services/mediabutton.ts)
 * メディアボタンPTTモード (DEC-027) — イヤフォン等のMediaPlay/Pauseボタンによる
 * 録音開始・送信トグル操作を管理します。
 *
 * 仕組み:
 * - メディアキーがWebページに配送されるのは「音声を再生中」とブラウザに認識されて
 *   いる間だけ (Chromeの仕様)。そのためモードON中は微小音量のノイズを連続ループ再生する。
 * - 音量はChromeの可聴判定 (audibility detection) を通過する必要がある。
 *   小さくしすぎると「無音」と分類されメディアキーが配送されない (DEC-025での失敗原因)。
 * - Media Session API の play/pause ハンドラでボタン押下を捕捉する。
 */
export class MediaButtonPttService {
  // ノイズの再生音量。Chromeに可聴と判定される下限を狙った値で、実機調整の対象。
  // (ノイズ源の振幅は約1%FSのため、実効レベルはこの値 × 0.01 ≒ -60dBFS)
  private static readonly NOISE_VOLUME = 0.1;

  private noiseAudioEl: HTMLAudioElement | null = null;
  private noiseUrl: string | null = null;
  private beepContext: AudioContext | null = null;
  private active = false;

  private buttonCallback: (() => void) | null = null;

  // play/pause が連続発火するケースを1回の押下にまとめるためのデバウンス
  private lastButtonPressTime = 0;
  private static readonly BUTTON_DEBOUNCE_MS = 600;

  /**
   * メディアボタンPTTが利用可能な環境か判定
   */
  static isSupported(): boolean {
    const hasMediaSession = 'mediaSession' in navigator;
    const hasAudioContext = !!(window.AudioContext || (window as any).webkitAudioContext);
    return hasMediaSession && hasAudioContext;
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * ボタン押下時のコールバック設定
   */
  onButtonPress(callback: () => void): void {
    this.buttonCallback = callback;
  }

  /**
   * モードをONにする。必ずユーザージェスチャーのハンドラ内から呼び出すこと。
   */
  async activate(): Promise<void> {
    if (this.active) return;

    // 1. 微小音量ノイズの連続ループ再生 (メディアキー捕捉の前提条件)
    try {
      this.noiseUrl = URL.createObjectURL(MediaButtonPttService.generateNoiseWavBlob());
      this.noiseAudioEl = new Audio(this.noiseUrl);
      this.noiseAudioEl.loop = true;
      this.noiseAudioEl.volume = MediaButtonPttService.NOISE_VOLUME;
      await this.noiseAudioEl.play();
    } catch (e) {
      this.releaseNoise();
      throw e;
    }

    this.active = true;

    // 2. Media Session の設定 (ボタン捕捉)
    this.setRecordingState(false);
    navigator.mediaSession.playbackState = 'playing';

    const handler = () => {
      // OSにノイズ再生を止められたら再開し、常にplaying扱いを維持する
      if (this.noiseAudioEl && this.noiseAudioEl.paused) {
        this.noiseAudioEl.play().catch(() => {});
      }
      navigator.mediaSession.playbackState = 'playing';

      const now = Date.now();
      if (now - this.lastButtonPressTime < MediaButtonPttService.BUTTON_DEBOUNCE_MS) return;
      this.lastButtonPressTime = now;

      if (this.buttonCallback) this.buttonCallback();
    };
    navigator.mediaSession.setActionHandler('play', handler);
    navigator.mediaSession.setActionHandler('pause', handler);

    // 3. ビープ音用 AudioContext (ユーザージェスチャー中に作成しロック解除)
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    this.beepContext = new AudioCtx();
  }

  /**
   * モードをOFFにする (リソースをすべて解放)
   */
  deactivate(): void {
    if (!this.active) return;
    this.active = false;

    this.releaseNoise();

    if (this.beepContext && this.beepContext.state !== 'closed') {
      this.beepContext.close().catch(() => {});
    }
    this.beepContext = null;

    try {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
    } catch (e) {
      // 一部ブラウザでは未対応のアクションで例外が出るが無視してよい
    }
  }

  /**
   * Media Session 上の表示タイトル更新 (録音中の可視化)
   */
  setRecordingState(isRecording: boolean): void {
    if (!this.active || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: isRecording ? '🔴 録音中... (もう一度押すと送信)' : 'PTT待機中 (ボタンで録音開始)',
      artist: 'Chatransceiver',
      artwork: [{ src: '/chatora.png', sizes: '512x512', type: 'image/png' }]
    });
  }

  /**
   * 録音開始ビープ (低→高の上昇音: 「今しゃべれる」)
   */
  beepStart(): void {
    this.playTones([
      { freq: 800, duration: 0.08 },
      { freq: 1200, duration: 0.08 }
    ]);
  }

  /**
   * 録音停止・送信ビープ (高→低の下降音: 「送信した」)
   */
  beepEnd(): void {
    this.playTones([
      { freq: 1200, duration: 0.08 },
      { freq: 800, duration: 0.08 }
    ]);
  }

  /**
   * エラービープ (低音2回: 操作が受け付けられなかった)
   */
  beepError(): void {
    this.playTones([
      { freq: 400, duration: 0.12 },
      { freq: 0, duration: 0.06 }, // 無音区間
      { freq: 400, duration: 0.12 }
    ]);
  }

  private playTones(tones: { freq: number; duration: number }[]): void {
    if (!this.beepContext || this.beepContext.state === 'closed') return;
    const ctx = this.beepContext;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    let t = ctx.currentTime;
    for (const tone of tones) {
      if (tone.freq > 0) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = tone.freq;
        // クリックノイズ防止のため音量を短時間でフェードイン/アウト
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.3, t + 0.01);
        gain.gain.setValueAtTime(0.3, t + tone.duration - 0.01);
        gain.gain.linearRampToValueAtTime(0, t + tone.duration);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + tone.duration);
      }
      t += tone.duration;
    }
  }

  private releaseNoise(): void {
    if (this.noiseAudioEl) {
      this.noiseAudioEl.pause();
      this.noiseAudioEl.src = '';
      this.noiseAudioEl = null;
    }
    if (this.noiseUrl) {
      URL.revokeObjectURL(this.noiseUrl);
      this.noiseUrl = null;
    }
  }

  /**
   * 5秒分の微小振幅ホワイトノイズWAVを生成する (8kHz / 16bit / モノラル)
   * 振幅は約1%FS。再生時の実効レベルは NOISE_VOLUME を掛けた値になる。
   */
  private static generateNoiseWavBlob(): Blob {
    const sampleRate = 8000;
    const numSamples = sampleRate * 5; // 5秒 (短すぎるループはメディア扱いされにくいため)
    const headerSize = 44;
    const dataSize = numSamples * 2;
    const buffer = new ArrayBuffer(headerSize + dataSize);
    const view = new DataView(buffer);

    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);          // fmt チャンクサイズ
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, 1, true);           // モノラル
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // バイトレート
    view.setUint16(32, 2, true);           // ブロックアライン
    view.setUint16(34, 16, true);          // ビット深度
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    // 振幅 ±330 (16bitフルスケールの約1%)
    for (let i = 0; i < numSamples; i++) {
      view.setInt16(headerSize + i * 2, Math.floor((Math.random() * 2 - 1) * 330), true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }
}
