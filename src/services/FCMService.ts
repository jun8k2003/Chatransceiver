import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, onMessage, deleteToken } from 'firebase/messaging';
import { SupabaseService } from './supabase'; // 依存性注入などでSupabaseインスタンスを取得

export class FCMService {
  private messaging: any = null;
  private app: any = null;
  private supabaseService: SupabaseService;
  private isIOS: boolean;

  constructor(supabaseService: SupabaseService) {
    this.supabaseService = supabaseService;
    
    // iOS判定 (UserAgentに iPhone, iPad, iPod が含まれるかどうか)
    const ua = window.navigator.userAgent.toLowerCase();
    this.isIOS = /iphone|ipad|ipod/.test(ua);

    // .env 等から設定を読み込む
    const firebaseConfig = {
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID
    };

    // Firebaseが初期化されていなければ初期化する
    if (firebaseConfig.apiKey && firebaseConfig.projectId) {
      this.app = initializeApp(firebaseConfig);
      // iOSの場合は FCM が未対応・制約が多いため messaging 初期化をスキップするなどの対応も可能ですが、
      // 念のため初期化だけは行い、登録ボタンを出さない方針とします。
      try {
        this.messaging = getMessaging(this.app);
      } catch (e) {
        console.warn('FCM is not supported in this browser.', e);
        this.messaging = null;
      }
    } else {
      console.warn('Firebase config is missing. FCMService will not work.');
    }
  }

  /**
   * 現在の端末がiOSかどうかを返す
   */
  public isIOSTerminal(): boolean {
    return this.isIOS;
  }

  /**
   * ローカルストレージからDevice UUIDを取得、無ければ生成して保存
   */
  private getDeviceUUID(): string {
    let uuid = localStorage.getItem('chatransceiver_device_uuid');
    if (!uuid) {
      uuid = crypto.randomUUID ? crypto.randomUUID() : 'fallback-' + Date.now() + Math.random();
      localStorage.setItem('chatransceiver_device_uuid', uuid);
    }
    return uuid;
  }

  /**
   * URLパラメータを含めてService Workerを登録する
   */
  private async registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    if (!('serviceWorker' in navigator)) return null;
    try {
      const swUrl = `/firebase-messaging-sw.js?apiKey=${import.meta.env.VITE_FIREBASE_API_KEY}&projectId=${import.meta.env.VITE_FIREBASE_PROJECT_ID}&messagingSenderId=${import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID}&appId=${import.meta.env.VITE_FIREBASE_APP_ID}`;
      return await navigator.serviceWorker.register(swUrl);
    } catch (e) {
      console.error('Service Worker registration failed:', e);
      return null;
    }
  }

  /**
   * 通知の登録処理
   * 1. 権限を要求する
   * 2. トークンを取得する
   * 3. バックエンド (Supabase Edge Function) に送信・登録する
   */
  public async registerNotification(): Promise<boolean> {
    if (this.isIOS) {
      alert('申し訳ありませんが、お使いの端末（iOS）はプッシュ通知登録に非対応です。');
      return false;
    }
    if (!this.messaging) {
      alert('プッシュ通知がサポートされていないブラウザか、設定が不足しています。');
      return false;
    }

    try {
      // 権限要求
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        alert('プッシュ通知の権限がブロックされました。ブラウザの設定から許可してください。');
        return false;
      }

      // トークン取得
      const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
      if (!vapidKey) {
        console.error('VITE_FIREBASE_VAPID_KEY is not defined');
        return false;
      }

      // Service Worker の明示的な登録 (Vite環境変数をURLパラメータとして渡すため)
      const registration = await this.registerServiceWorker();

      const currentToken = await getToken(this.messaging, { 
        vapidKey,
        serviceWorkerRegistration: registration || undefined
      });
      if (currentToken) {
        // バックエンドに登録
        const success = await this.registerToBackend(currentToken);
        if (success) {
          localStorage.setItem('chatransceiver_fcm_registered', 'true');
          // リスナーのセットアップ
          this.setupForegroundListener();
          return true;
        }
      } else {
        console.error('No registration token available. Request permission to generate one.');
      }
    } catch (err) {
      console.error('An error occurred while retrieving token. ', err);
    }
    return false;
  }

  /**
   * 通知の解除処理
   * 1. バックエンドのトークンを削除
   * 2. ローカルのトークンを削除
   */
  public async unregisterNotification(): Promise<boolean> {
    if (!this.messaging) return false;

    try {
      // バックエンドから削除
      const success = await this.unregisterFromBackend();
      if (success) {
        // ローカルのトークンを削除
        await deleteToken(this.messaging);
        localStorage.removeItem('chatransceiver_fcm_registered');
        return true;
      }
    } catch (err) {
      console.error('An error occurred while deleting token. ', err);
    }
    return false;
  }

  /**
   * すでに登録済みの場合は、アプリ起動時にリスナーのみセットアップする
   */
  public async setupIfRegistered(): Promise<void> {
    if (this.isIOS || !this.messaging) return;
    const isRegistered = localStorage.getItem('chatransceiver_fcm_registered');
    if (isRegistered === 'true') {
      await this.registerServiceWorker();
      this.setupForegroundListener();
    }
  }

  /**
   * フォアグラウンドでのメッセージ受信とトークン更新のリスナーを設定
   */
  private setupForegroundListener(): void {
    if (!this.messaging) return;

    // フォアグラウンドでメッセージを受け取った際の処理
    // ※アプリが開いている状態では Service Worker 側のバックグラウンド処理は呼ばれずこちらが呼ばれる。
    // ※アプリがアクティブな場合はUI側（Supabase Realtime）ですでにチャットが更新・再生されるため、
    //   基本的には何もしない（あるいは別コミュニティの通知の場合は自前で Notification を出す）
    onMessage(this.messaging, (payload) => {
      console.log('Message received in foreground: ', payload);
      // const data = payload.data || {};
      // const communitySlug = data.communitySlug || '';

      // 現在開いているコミュニティと違うコミュニティの通知が来た場合、システム通知を強制的に出すことも可能
      // const urlParams = new URLSearchParams(window.location.search);
      // const currentSlug = urlParams.get('c');
      // if (currentSlug !== communitySlug && Notification.permission === 'granted') {
      //   new Notification(`[${data.communityName}] ${data.senderName}`, {
      //     body: data.messageType === 'audio' ? '🎤 音声メッセージ' : data.textContent,
      //     icon: '/chatora.png'
      //   });
      // }
    });
  }

  /**
   * Supabase Edge Function にトークンを登録
   */
  private async registerToBackend(fcmToken: string): Promise<boolean> {
    const session = await this.supabaseService.getSession();
    if (!session) return false;

    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/register-fcm-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          action: 'register',
          device_uuid: this.getDeviceUUID(),
          fcm_token: fcmToken
        })
      });
      return response.ok;
    } catch (e) {
      console.error('Failed to register FCM token to backend', e);
      return false;
    }
  }

  /**
   * Supabase Edge Function からトークンを削除
   */
  private async unregisterFromBackend(): Promise<boolean> {
    const session = await this.supabaseService.getSession();
    if (!session) return false;

    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/register-fcm-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          action: 'unregister',
          device_uuid: this.getDeviceUUID()
        })
      });
      return response.ok;
    } catch (e) {
      console.error('Failed to unregister FCM token from backend', e);
      return false;
    }
  }
}
