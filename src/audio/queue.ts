import { AudioManager } from './manager';
import pttStartUrl from '../assets/ptt-start.wav';

export interface QueueItem {
  id: string;              // メッセージのユニークID
  type: 'audio' | 'text';  // 再生タイプ (音声ファイルか、テキスト読み上げか)
  content: string;         // 音声URL または 読み上げるテキスト内容
  senderName: string;      // 発話者の名前（ログやインジケータ表示用）
  roomId: string;          // 配信されたチャット部屋のID
  onPlayStart?: () => void; // 再生開始時にUI側で実行したい処理
  onPlayEnd?: () => void;   // 再生終了時にUI側で実行したい処理
}

/**
 * AudioPlaybackQueue (src/audio/queue.ts)
 * 届いた音声メッセージやTTSテキストをグローバルなキューに溜め、
 * 重複することなく順序よく1つずつ連続再生します。
 */
export class AudioPlaybackQueue {
  private queue: QueueItem[] = [];
  private isPlaying = false;
  private isPaused = false;
  // ハードストップ要求フラグ。再生中の playNext に「後続チャイム・次アイテム送りを
  // 中断せよ」と伝えるための信号 (DEC-032)
  private stopRequested = false;
  private audioManager: AudioManager;

  public callSignEnabled: boolean = true;

  constructor(audioManager: AudioManager) {
    this.audioManager = audioManager;
  }

  /**
   * 再生キューへの追加
   * @param item キューに追加する再生アイテム
   */
  enqueue(item: QueueItem): void {
    // 重複登録防止 (同じメッセージが何度もキューに入るのを防ぐ)
    if (this.queue.some((q) => q.id === item.id)) {
      return;
    }

    this.queue.push(item);

    // 再生中でなく、かつ一時停止中でなければ再生を開始する
    if (!this.isPlaying && !this.isPaused) {
      this.playNext();
    }
  }


  /**
   * 次のアイテムの再生実行
   */
  private async playNext(): Promise<void> {
    if (this.queue.length === 0 || this.isPaused) {
      this.isPlaying = false;
      return;
    }

    // 新しいアイテムの再生を始める時点で停止フラグをリセットする。
    // アイドル中に stopAll() が呼ばれてフラグが残っていても、次の再生を取りこぼさない (DEC-032)
    this.stopRequested = false;

    this.isPlaying = true;
    const currentItem = this.queue.shift()!;

    try {
      // 再生開始のUI通知コールバック
      if (currentItem.onPlayStart) {
        currentItem.onPlayStart();
      }

      // 再生前チャイム (停止要求中はスキップ)
      if (this.callSignEnabled && !this.stopRequested) {
        try {
          await this.audioManager.playAudio(pttStartUrl, 0.3);
        } catch (error) {
          console.warn('Failed to play ptt-start before:', error);
        }
      }

      // データのタイプに応じて再生処理を分岐 (DEC-018)。
      // 各 await 後に stopRequested を再チェックし、停止要求があれば本体・後続を鳴らさない (DEC-032)
      if (!this.stopRequested) {
        if (currentItem.type === 'audio') {
          // 音声ファイル再生
          await this.audioManager.playAudio(currentItem.content);
        } else {
          // テキスト音声合成 (TTS) 再生
          await this.audioManager.speakText(currentItem.content);
        }
      }

      // 再生後チャイム (停止要求中は鳴らさない)
      if (this.callSignEnabled && !this.stopRequested) {
        try {
          await this.audioManager.playAudio(pttStartUrl, 0.3);
        } catch (error) {
          console.warn('Failed to play ptt-start after:', error);
        }
      }
    } catch (error) {
      console.error('AudioPlaybackQueue playback error:', error);
    } finally {
      // 再生終了のUI通知コールバック (停止時もUI状態を戻すため必ず呼ぶ)
      if (currentItem.onPlayEnd) {
        currentItem.onPlayEnd();
      }

      // 停止要求があれば次へ進めずに終了する (後続アイテムを鳴らさない)
      if (this.stopRequested) {
        this.stopRequested = false;
        this.isPlaying = false;
        return;
      }

      // 次のアイテムを再生
      this.playNext();
    }
  }

  /**
   * キューの再生を一時停止する（現在再生中のものはそのまま最後まで再生させる、または停止させる）
   */
  pause(): void {
    this.isPaused = true;
  }

  /**
   * キューの再生を再開する
   */
  resume(): void {
    this.isPaused = false;
    if (!this.isPlaying && this.queue.length > 0) {
      this.playNext();
    }
  }

  /**
   * 自動再生のハードストップ (DEC-032)
   * 未再生のキューを全消去し、再生中の音声・TTS を即座に止める。
   * 再生中の場合は stopRequested で in-flight の playNext に中断を伝え、
   * 後続チャイムや次アイテムの再生が走らないようにする（再生パイプラインの安全な停止）。
   */
  stopAll(): void {
    this.queue = [];
    if (this.isPlaying) {
      this.stopRequested = true;
    }
    // 現在再生中の音声/TTS を停止する。これにより in-flight の await が解決し、
    // playNext の finally で停止処理 (次アイテムへ進めない) が実行される。
    this.audioManager.stopAllPlayback();
  }

  /**
   * キューのクリアと再生中の音声の停止。
   * ハードストップ (stopAll) に統一し、停止時に後続チャイムが鳴る不具合を防ぐ。
   */
  clear(): void {
    this.stopAll();
  }

  /**
   * キューに積まれているアイテムの数を取得
   */
  get length(): number {
    return this.queue.length;
  }
}
