/**
 * AudioManager (src/audio/manager.ts)
 * 録音、音量メーター解析、音声再生、音声認識(SpeechRecognition)、音声合成(SpeechSynthesis)の
 * ブラウザ標準ハードウェアAPIの制御を一括管理します。
 */
export class AudioManager {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private micStream: MediaStream | null = null;
  private levelIntervalId: number | null = null;
  
  private recognition: any = null; // SpeechRecognition (録音時文字おこし用)
  private isRecognitionActive: boolean = false;
  private activeAudioElement: HTMLAudioElement | null = null;

  // ウェイクワード監視用 SpeechRecognition (TTT モード専用)
  private wakeRecognition: any = null;
  private wakeListening: boolean = false;
  private wakeWordRegex: RegExp | null = null;
  private wakeMatchCallback: (() => void) | null = null;
  private wakeTextCallback: ((text: string) => void) | null = null;
  private wakeFatalCallback: ((reason: string) => void) | null = null;
  private wakeRestartTimerId: number | null = null;
  private wakeConsecutiveErrors: number = 0;

  constructor() {
    this.initSpeechRecognition();
  }

  /**
   * SpeechRecognition (音声認識) の初期化
   */
  private initSpeechRecognition() {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    
    if (SpeechRecognition) {
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = false;
      this.recognition.interimResults = false;
      this.recognition.lang = 'ja-JP';
    } else {
      console.warn('このブラウザは Web Speech API (SpeechRecognition) をサポートしていません。');
    }
  }

  /**
   * 録音の開始
   * @param onLevelUpdate リアルタイムの音量レベルを受け取るコールバック (0 ~ 100)
   */
  async startRecording(onLevelUpdate: (level: number) => void): Promise<void> {
    this.audioChunks = [];

    // マイクストリームの取得（OSデフォルトマイク）
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    // Web Audio API で音量レベルメーターを設定
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioCtx();
    const source = this.audioContext.createMediaStreamSource(this.micStream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    source.connect(this.analyser);

    // 音量検知ループ
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    const updateLevel = () => {
      if (!this.analyser) return;
      this.analyser.getByteFrequencyData(dataArray);
      
      // 平均音量を計算
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;
      // 0 ~ 100 に正規化 (マイク感度調整含む)
      const normalizedLevel = Math.min(100, Math.floor((average / 128) * 100));
      onLevelUpdate(normalizedLevel);
      
      this.levelIntervalId = requestAnimationFrame(updateLevel);
    };
    
    updateLevel();

    // 録音開始 (32kbpsで通信量を削減)
    this.mediaRecorder = new MediaRecorder(this.micStream, { audioBitsPerSecond: 32000 });
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.audioChunks.push(event.data);
      }
    };
    this.mediaRecorder.start();
  }

  /**
   * 録音の停止と音声Blobの取得
   * @returns 録音された音声のBlob
   */
  stopRecording(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
        this.cleanupRecordingResources();
        resolve(audioBlob);
        return;
      }

      let isResolved = false;
      const timeoutId = setTimeout(() => {
        if (!isResolved) {
          console.warn('MediaRecorder stop timeout');
          isResolved = true;
          const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
          this.cleanupRecordingResources();
          resolve(audioBlob);
        }
      }, 1500);

      this.mediaRecorder.onstop = () => {
        if (isResolved) return;
        isResolved = true;
        clearTimeout(timeoutId);
        
        // 音声データ (WebM形式等) の結合
        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
        
        // ハードウェアリソースの解放
        this.cleanupRecordingResources();
        
        resolve(audioBlob);
      };

      try {
        this.mediaRecorder.stop();
      } catch (e) {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          reject(e);
        }
      }
    });
  }

  /**
   * 録音リソースの解放
   */
  private cleanupRecordingResources() {
    if (this.levelIntervalId) {
      cancelAnimationFrame(this.levelIntervalId);
      this.levelIntervalId = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.analyser = null;
  }

  /**
   * Blobから音声を直接再生する（プレビュー用）
   */
  playBlob(blob: Blob): Promise<void> {
    const url = URL.createObjectURL(blob);
    return this.playAudio(url).finally(() => {
      URL.revokeObjectURL(url);
    });
  }

  /**
   * 音声ファイルの再生
   * @param url 音声ファイルのURL (ローカルの Blob URL またはクラウドの Storage URL)
   * @param volume 音量 (0.0 ~ 1.0, デフォルトは 1.0)
   */
  playAudio(url: string, volume: number = 1.0): Promise<void> {
    return new Promise((resolve, reject) => {
      // 既存の再生があれば停止
      this.stopAllPlayback();

      const audio = new Audio(url);
      audio.volume = volume;
      this.activeAudioElement = audio;
      this.activeAudioResolve = resolve;

      audio.onended = () => {
        this.activeAudioElement = null;
        if (this.activeAudioResolve) {
          this.activeAudioResolve();
          this.activeAudioResolve = null;
        }
      };

      audio.onerror = (e) => {
        this.activeAudioElement = null;
        this.activeAudioResolve = null;
        reject(e);
      };

      audio.play().catch((err) => {
        this.activeAudioElement = null;
        this.activeAudioResolve = null;
        reject(err);
      });
    });
  }

  /**
   * 音声合成 (TTS) によるテキストの読み上げ
   * @param text 読み上げるテキスト
   */
  speakText(text: string): Promise<void> {
    return new Promise((resolve) => {
      // 既存の再生・読み上げがあれば停止
      this.stopAllPlayback();

      if (!('speechSynthesis' in window)) {
        console.warn('このブラウザは音声合成 (SpeechSynthesis) をサポートしていません。');
        resolve();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'ja-JP';
      utterance.rate = 1.0; // 読み上げ速度

      utterance.onend = () => {
        resolve();
      };

      utterance.onerror = () => {
        resolve(); // エラー時もキューを停滞させないため解決する
      };

      window.speechSynthesis.speak(utterance);
    });
  }

  private activeAudioResolve: (() => void) | null = null;

  /**
   * 現在実行中のすべての再生・音声読み上げを即座に停止する
   */
  stopAllPlayback(): void {
    // 音声ファイルの再生停止
    if (this.activeAudioElement) {
      this.activeAudioElement.pause();
      this.activeAudioElement = null;
    }
    if (this.activeAudioResolve) {
      this.activeAudioResolve();
      this.activeAudioResolve = null;
    }
    // 音声合成の読み上げ停止
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  private recognizedText: string = '';
  private dictationResolver: ((text: string) => void) | null = null;

  /**
   * リアルタイム音声認識 (ディクテーション) の開始
   */
  startDictation(): void {
    this.recognizedText = '';
    this.dictationResolver = null;
    if (!this.recognition) return;

    this.isRecognitionActive = true;

    this.recognition.onresult = (event: any) => {
      this.recognizedText = event.results[0][0].transcript;
      if (this.dictationResolver) {
        this.dictationResolver(this.recognizedText);
        this.dictationResolver = null;
      }
    };

    this.recognition.onerror = (event: any) => {
      console.error('Speech Recognition Error:', event.error);
      this.isRecognitionActive = false;
      if (this.dictationResolver) {
        this.dictationResolver('');
        this.dictationResolver = null;
      }
    };

    this.recognition.onend = () => {
      this.isRecognitionActive = false;
      if (this.dictationResolver) {
        this.dictationResolver(this.recognizedText);
        this.dictationResolver = null;
      }
    };

    try {
      this.recognition.start();
    } catch (e) {
      this.isRecognitionActive = false;
      // すでに開始されている場合は無視
    }
  }

  /**
   * 音声認識の停止と結果の取得
   * @returns 認識されたテキスト
   */
  stopDictation(): Promise<string> {
    return new Promise((resolve) => {
      if (!this.recognition) {
        resolve('');
        return;
      }

      // すでに認識結果が出ている、または認識が終了している場合は即座に返す
      if (this.recognizedText || !this.isRecognitionActive) {
        resolve(this.recognizedText);
        return;
      }

      // タイムアウトを設定してハングを防止
      let isResolved = false;
      const timeoutId = setTimeout(() => {
        if (!isResolved) {
          console.warn('Speech recognition stop timeout');
          isResolved = true;
          resolve(this.recognizedText);
        }
      }, 1500);

      this.dictationResolver = (text: string) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          resolve(text);
        }
      };

      try {
        this.recognition.stop();
      } catch (e) {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          resolve(this.recognizedText);
        }
      }
    });
  }

  /**
   * TTT ウェイクワード監視の開始
   * continuous SpeechRecognition でテキストを常時監視し、正規表現ヒット時にコールバックを呼ぶ
   *
   * Android Chrome では continuous 指定でも発話・無音のたびに認識が頻繁に終了するため、
   * onend からの遅延再起動でループを維持する。終了直後の start() は InvalidStateError を
   * 投げることがあるため、同期再起動ではなくタイマー経由でリトライする。
   *
   * @param onFatalError 回復不能なエラー (権限剥奪・連続失敗) で監視を断念した時に呼ばれる
   */
  startWakeWordListening(
    regex: RegExp,
    onMatch: () => void,
    onTextUpdate: (text: string) => void,
    onFatalError?: (reason: string) => void
  ): void {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('SpeechRecognition はサポートされていません。');
      onFatalError?.('unsupported');
      return;
    }

    // 二重起動防止: 既存の監視があれば先に破棄する (バックグラウンド復帰時の再開で重要)
    this.stopWakeWordListening();

    this.wakeWordRegex = regex;
    this.wakeMatchCallback = onMatch;
    this.wakeTextCallback = onTextUpdate;
    this.wakeFatalCallback = onFatalError || null;
    this.wakeListening = true;
    this.wakeConsecutiveErrors = 0;

    this.wakeRecognition = new SpeechRecognition();
    this.wakeRecognition.continuous = true;
    this.wakeRecognition.interimResults = true;
    this.wakeRecognition.lang = 'ja-JP';

    this.wakeRecognition.onresult = (event: any) => {
      // 認識が機能している間はエラーカウンタをリセット
      this.wakeConsecutiveErrors = 0;

      // 最新の認識セグメントを取得
      // (Android では interim が届かず final のみ通知される端末があるが、いずれも onresult に乗る)
      let recent = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        recent += event.results[i][0].transcript;
      }
      this.wakeTextCallback?.(recent);

      if (this.wakeWordRegex?.test(recent)) {
        // ヒット: 監視を即時停止してコールバック
        // stop() ではなく abort() を使う。Android は stop() だとマイク解放が遅く、
        // 直後の録音開始 (getUserMedia) と競合するため。
        this.wakeListening = false;
        try { this.wakeRecognition?.abort(); } catch (_) {
          try { this.wakeRecognition?.stop(); } catch (_) {}
        }
        this.wakeMatchCallback?.();
      }
    };

    this.wakeRecognition.onerror = (event: any) => {
      // no-speech: 無音タイムアウト (Android では数秒おきに頻発する正常系) / aborted: 自前の停止
      if (event.error === 'no-speech' || event.error === 'aborted') return;

      // 権限系のエラーは再起動しても回復しないため即座に断念する
      // (再起動ループを続けると Android では開始音が鳴り続ける)
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        console.warn('Wake word recognition permission error:', event.error);
        this.failWakeWordListening(event.error);
        return;
      }

      // network / audio-capture 等は一時障害の可能性があるためカウントして再起動に委ねる
      console.warn('Wake word recognition error:', event.error);
      this.wakeConsecutiveErrors++;
      if (this.wakeConsecutiveErrors >= 5) {
        this.failWakeWordListening(event.error);
      }
    };

    this.wakeRecognition.onend = () => {
      if (this.wakeListening) {
        // Android は発話のたびに認識が終了する。マイク解放を待ってから遅延再起動する
        this.scheduleWakeRestart();
      }
    };

    try {
      this.wakeRecognition.start();
    } catch (e) {
      // 初回起動失敗 (まれに前セッションの解放待ち) はリトライに回す
      console.warn('Failed to start wake word recognition, retrying:', e);
      this.scheduleWakeRestart();
    }
  }

  /**
   * ウェイクワード認識の遅延再起動 (Android の頻繁な onend に対応)
   */
  private scheduleWakeRestart(): void {
    if (!this.wakeListening || this.wakeRestartTimerId !== null) return;
    this.wakeRestartTimerId = window.setTimeout(() => {
      this.wakeRestartTimerId = null;
      if (!this.wakeListening || !this.wakeRecognition) return;
      try {
        this.wakeRecognition.start();
      } catch (e) {
        // start() が InvalidStateError 等を投げた場合はリトライ。連続失敗は断念する
        this.wakeConsecutiveErrors++;
        if (this.wakeConsecutiveErrors >= 5) {
          this.failWakeWordListening('restart-failed');
        } else {
          this.scheduleWakeRestart();
        }
      }
    }, 300);
  }

  /**
   * 回復不能エラーによる監視の断念 (権限剥奪・連続失敗)
   */
  private failWakeWordListening(reason: string): void {
    const callback = this.wakeFatalCallback;
    this.stopWakeWordListening();
    callback?.(reason);
  }

  /**
   * TTT ウェイクワード監視の停止
   */
  stopWakeWordListening(): void {
    this.wakeListening = false;
    this.wakeWordRegex = null;
    this.wakeMatchCallback = null;
    this.wakeTextCallback = null;
    this.wakeFatalCallback = null;
    this.wakeConsecutiveErrors = 0;
    if (this.wakeRestartTimerId !== null) {
      clearTimeout(this.wakeRestartTimerId);
      this.wakeRestartTimerId = null;
    }
    if (this.wakeRecognition) {
      try { this.wakeRecognition.abort(); } catch (_) {
        try { this.wakeRecognition.stop(); } catch (_) {}
      }
      this.wakeRecognition = null;
    }
  }

  /**
   * 自動再生ロックを解除するための初期ダミー処理
   * ユーザーのクリックイベントハンドラ内で一度だけ呼び出します。
   */
  unlockAudio(): void {
    // 1. Web Audio API (音声ファイル再生等) のロック解除
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      ctx.resume().then(() => ctx.close()).catch(console.error);
    }

    // 2. SpeechSynthesis (音声読み上げ) のロック解除 (iOS/iPadOS対応)
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance('');
      utterance.volume = 0; // 無音で再生
      window.speechSynthesis.speak(utterance);
    }
  }
}
