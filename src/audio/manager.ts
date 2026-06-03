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
  
  private recognition: any = null; // SpeechRecognition
  private activeAudioElement: HTMLAudioElement | null = null;

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
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

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

    // 録音開始
    this.mediaRecorder = new MediaRecorder(this.micStream);
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
      if (!this.mediaRecorder) {
        reject(new Error('録音は開始されていません。'));
        return;
      }

      this.mediaRecorder.onstop = () => {
        // 音声データ (WebM形式等) の結合
        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
        
        // ハードウェアリソースの解放
        this.cleanupRecordingResources();
        
        resolve(audioBlob);
      };

      this.mediaRecorder.stop();
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
   * 音声ファイルの再生
   * @param url 音声ファイルのURL (ローカルの Blob URL またはクラウドの Storage URL)
   */
  playAudio(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // 既存の再生があれば停止
      this.stopAllPlayback();

      const audio = new Audio(url);
      this.activeAudioElement = audio;

      audio.onended = () => {
        this.activeAudioElement = null;
        resolve();
      };

      audio.onerror = (e) => {
        this.activeAudioElement = null;
        reject(e);
      };

      audio.play().catch((err) => {
        this.activeAudioElement = null;
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

  /**
   * 現在実行中のすべての再生・音声読み上げを即座に停止する
   */
  stopAllPlayback(): void {
    // 音声ファイルの再生停止
    if (this.activeAudioElement) {
      this.activeAudioElement.pause();
      this.activeAudioElement = null;
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

    this.recognition.onresult = (event: any) => {
      this.recognizedText = event.results[0][0].transcript;
      if (this.dictationResolver) {
        this.dictationResolver(this.recognizedText);
        this.dictationResolver = null;
      }
    };

    this.recognition.onerror = (event: any) => {
      console.error('Speech Recognition Error:', event.error);
      if (this.dictationResolver) {
        this.dictationResolver('');
        this.dictationResolver = null;
      }
    };

    this.recognition.onend = () => {
      if (this.dictationResolver) {
        this.dictationResolver(this.recognizedText);
        this.dictationResolver = null;
      }
    };

    try {
      this.recognition.start();
    } catch (e) {
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

      // すでに認識結果が出ている場合は即座に返す
      if (this.recognizedText) {
        resolve(this.recognizedText);
        return;
      }

      // まだ結果が出ていない場合は、stop()を呼んでコールバックを待つ
      this.dictationResolver = resolve;
      try {
        this.recognition.stop();
      } catch (e) {
        resolve('');
      }
    });
  }

  /**
   * 自動再生ロックを解除するための初期ダミー処理
   * ユーザーのクリックイベントハンドラ内で一度だけ呼び出します。
   */
  unlockAudio(): void {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      ctx.resume().then(() => ctx.close());
    }
  }
}
