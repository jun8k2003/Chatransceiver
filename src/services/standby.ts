/**
 * StandbyService (src/services/standby.ts)
 * バックグラウンド待機状態 (DEC-025) の管理を行います。
 *
 * 仕組み:
 * - 極小音量のホワイトノイズを <audio loop> で連続再生し、OSに「メディア再生中」と
 *   認識させることでバックグラウンドでのインスタンス停止を防ぎます。
 *   (Web Audio API のみの再生では Media Session のハードウェアキー捕捉対象に
 *    ならないため、HTMLAudioElement を使用します)
 * - Media Session API の play/pause ハンドラでイヤフォンのセンターボタンを捕捉します。
 * - マイクはバックグラウンドから新規取得できないため、待機開始時(フォアグラウンド・
 *   ユーザージェスチャー確定時)に事前取得し、ストリームを保持し続けます。
 */
export class StandbyService {
  private noiseAudioEl: HTMLAudioElement | null = null;
  private noiseUrl: string | null = null;
  private micStream: MediaStream | null = null;
  private beepContext: AudioContext | null = null;
  private active = false;

  private buttonCallback: (() => void) | null = null;
  private micLostCallback: (() => void) | null = null;

  // イヤフォンボタンの連打防止 (OSがplay/pauseを連続発火させる場合がある)
  private lastButtonPressTime = 0;
  private static readonly BUTTON_DEBOUNCE_MS = 600;

  /**
   * 待機状態が利用可能な環境か判定 (Android + MediaSession + AudioContext)
   * iOSはバックグラウンドでのマイク維持が不安定なため対象外 (DEC-025)
   */
  static isSupported(): boolean {
    const isAndroid = /Android/i.test(navigator.userAgent);
    const hasMediaSession = 'mediaSession' in navigator;
    const hasAudioContext = !!(window.AudioContext || (window as any).webkitAudioContext);
    return isAndroid && hasMediaSession && hasAudioContext;
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * 保持中のマイクストリーム (録音時に再利用する)
   */
  get preAcquiredMicStream(): MediaStream | null {
    return this.micStream;
  }

  /**
   * イヤフォンボタン押下時のコールバック設定
   */
  onButtonPress(callback: () => void): void {
    this.buttonCallback = callback;
  }

  /**
   * マイクストリームがOSにより停止された際のコールバック設定
   */
  onMicLost(callback: () => void): void {
    this.micLostCallback = callback;
  }

  /**
   * 待機状態をONにする。
   * 必ずユーザージェスチャー (クリック等) のハンドラ内から呼び出すこと。
   */
  async activate(): Promise<void> {
    if (this.active) return;

    // 1. マイクの事前取得 (バックグラウンドでは新規取得できないため)
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    this.micStream.getTracks().forEach((track) => {
      track.onended = () => {
        // OSによる強制停止を検知
        if (this.active) {
          this.deactivate();
          if (this.micLostCallback) this.micLostCallback();
        }
      };
    });

    // 2. 極小音量ホワイトノイズの連続ループ再生
    try {
      this.noiseUrl = URL.createObjectURL(StandbyService.generateNoiseWavBlob());
      this.noiseAudioEl = new Audio(this.noiseUrl);
      this.noiseAudioEl.loop = true;
      this.noiseAudioEl.volume = 0.001; // 耳には聞こえない音量
      await this.noiseAudioEl.play();
    } catch (e) {
      this.releaseMicStream();
      this.releaseNoise();
      throw e;
    }

    this.active = true;

    // 3. Media Session の設定 (イヤフォンボタン捕捉)
    this.setupMediaSession();

    // 4. ビープ音用 AudioContext (ユーザージェスチャー中に作成しロック解除)
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    this.beepContext = new AudioCtx();
  }

  /**
   * 待機状態をOFFにする (リソースをすべて解放)
   */
  deactivate(): void {
    if (!this.active) return;
    this.active = false;

    this.releaseNoise();
    this.releaseMicStream();

    if (this.beepContext && this.beepContext.state !== 'closed') {
      this.beepContext.close().catch(() => {});
    }
    this.beepContext = null;

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.playbackState = 'none';
        navigator.mediaSession.metadata = null;
      } catch (e) {
        // 一部ブラウザでは未対応のアクションで例外が出るが無視してよい
      }
    }
  }

  /**
   * Media Session 上の表示タイトル更新 (録音中の可視化)
   */
  setRecordingState(isRecording: boolean): void {
    if (!this.active || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: isRecording ? '🔴 録音中... (もう一度押すと送信)' : '待機中 (ボタンで録音開始)',
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

  private setupMediaSession(): void {
    this.setRecordingState(false);
    navigator.mediaSession.playbackState = 'playing';

    const handler = () => {
      // ノイズ再生をOSに止められないよう常にplaying扱いに戻す
      if (this.noiseAudioEl && this.noiseAudioEl.paused) {
        this.noiseAudioEl.play().catch(() => {});
      }
      navigator.mediaSession.playbackState = 'playing';

      // play/pause が同時に連続発火するケースをデバウンスで1回の押下にまとめる
      const now = Date.now();
      if (now - this.lastButtonPressTime < StandbyService.BUTTON_DEBOUNCE_MS) return;
      this.lastButtonPressTime = now;

      if (this.buttonCallback) this.buttonCallback();
    };

    navigator.mediaSession.setActionHandler('play', handler);
    navigator.mediaSession.setActionHandler('pause', handler);
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

  private releaseMicStream(): void {
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
      this.micStream = null;
    }
  }

  /**
   * 1秒分の極小振幅ホワイトノイズWAVを生成する (8kHz / 16bit / モノラル)
   * 外部ファイル不要でループ再生用の音源を用意するためのもの。
   */
  private static generateNoiseWavBlob(): Blob {
    const sampleRate = 8000;
    const numSamples = sampleRate; // 1秒
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

    // 振幅 ±30 (16bitフルスケールの約0.1%) のノイズ。さらに volume 0.001 を掛けて再生する
    for (let i = 0; i < numSamples; i++) {
      view.setInt16(headerSize + i * 2, Math.floor((Math.random() * 2 - 1) * 30), true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }
}
