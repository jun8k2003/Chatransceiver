/**
 * BluetoothのスリープおよびOSのサスペンドを防止するキープアライブクラス
 */
export class AudioKeepAliveManager {
  private context: AudioContext;
  private noiseBufferCache: AudioBuffer | null = null;
  private currentSourceNode: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;

  /**
   * @param audioContext 活性化済みのAudioContextインスタンス
   */
  constructor(audioContext: AudioContext) {
    this.context = audioContext;
  }

  /**
   * 1. 起動時（または待ち受け開始時）に1回だけ実行し、メモリ上にノイズデータをキャッシュする
   */
  preloadBuffer(): void {
    if (this.noiseBufferCache) return;

    const sampleRate = this.context.sampleRate;
    const bufferSize = sampleRate * 1.0; // 1.0秒分の領域を確保
    
    // モノラル（1チャンネル）のバッファを作成
    this.noiseBufferCache = this.context.createBuffer(1, bufferSize, sampleRate);
    const channelData = this.noiseBufferCache.getChannelData(0);
    
    // 配列を -1.0 から 1.0 のランダム値で埋め尽くす（ホワイトノイズ）
    for (let i = 0; i < bufferSize; i++) {
        channelData[i] = (Math.random() * 2) - 1;
    }
    console.log("AudioKeepAlive: ホワイトノイズのメモリキャッシュが完了しました。");
  }

  /**
   * 2. 待ち受けセッション開始時に、キャッシュを再利用して常時ループ再生を開始する
   * @param volume 補正音量（デフォルトは人間の耳にほぼ聞こえない0.002）
   */
  startInaudibleNoise(volume: number = 0.002): void {
    // キャッシュがない場合は生成
    if (!this.noiseBufferCache) {
      this.preloadBuffer();
    }

    // 二重起動を防止
    this.stopInaudibleNoise();

    // Source Nodeは使い捨てのため都度生成
    this.currentSourceNode = this.context.createBufferSource();
    this.currentSourceNode.buffer = this.noiseBufferCache;
    this.currentSourceNode.loop = true;

    // Gain Nodeの生成
    this.gainNode = this.context.createGain();
    this.gainNode.gain.value = volume;

    // パイプライン接続
    this.currentSourceNode.connect(this.gainNode);
    this.gainNode.connect(this.context.destination);

    // 再生開始
    this.currentSourceNode.start();
    console.log(`AudioKeepAlive: スリープ防止信号を配信中... (Gain: ${volume})`);
  }

  /**
   * 3. トークモード（マイク送信中）など、ノイズを一時的に止めるタイミングで呼び出す
   */
  stopInaudibleNoise(): void {
    if (this.currentSourceNode) {
      try {
        this.currentSourceNode.stop();
      } catch (e) {
        // 既に停止している場合の例外を無視
      }
      this.currentSourceNode.disconnect();
      this.currentSourceNode = null;
    }
    
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    console.log("AudioKeepAlive: スリープ防止信号を停止しました。");
  }
}
