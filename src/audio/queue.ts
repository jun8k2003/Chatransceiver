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

    this.isPlaying = true;
    const currentItem = this.queue.shift()!;

    try {
      // 再生開始のUI通知コールバック
      if (currentItem.onPlayStart) {
        currentItem.onPlayStart();
      }

      // 再生前チャイム
      if (this.callSignEnabled) {
        try {
          await this.audioManager.playAudio(pttStartUrl);
        } catch (error) {
          console.warn('Failed to play ptt-start before:', error);
        }
      }

      // データのタイプに応じて再生処理を分岐 (DEC-018)
      if (currentItem.type === 'audio') {
        // 音声ファイル再生
        await this.audioManager.playAudio(currentItem.content);
      } else {
        // テキスト音声合成 (TTS) 再生
        await this.audioManager.speakText(currentItem.content);
      }

      // 再生後チャイム
      if (this.callSignEnabled) {
        try {
          await this.audioManager.playAudio(pttStartUrl);
        } catch (error) {
          console.warn('Failed to play ptt-start after:', error);
        }
      }
    } catch (error) {
      console.error('AudioPlaybackQueue playback error:', error);
    } finally {
      // 再生終了のUI通知コールバック
      if (currentItem.onPlayEnd) {
        currentItem.onPlayEnd();
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
   * キューのクリアと再生中の音声の停止
   */
  clear(): void {
    this.queue = [];
    this.isPlaying = false;
    this.audioManager.stopAllPlayback();
  }

  /**
   * キューに積まれているアイテムの数を取得
   */
  get length(): number {
    return this.queue.length;
  }
}
