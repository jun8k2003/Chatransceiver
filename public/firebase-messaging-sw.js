importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

const urlParams = new URLSearchParams(location.search);
const apiKey = urlParams.get('apiKey');
const projectId = urlParams.get('projectId');
const messagingSenderId = urlParams.get('messagingSenderId');
const appId = urlParams.get('appId');

if (apiKey && projectId) {
  firebase.initializeApp({
    apiKey,
    projectId,
    messagingSenderId,
    appId
  });

  const messaging = firebase.messaging();
}

// ネイティブの push イベントリスナーで通知を処理します（Chromeの不正通知警告を完全に防ぐため）
self.addEventListener('push', function(event) {
  let payload = {};
  try {
    payload = event.data.json();
  } catch (e) {
    return;
  }

  const data = payload.data || {};
  const communitySlug = data.communitySlug || '';
  const messageId = data.messageId || '';
  const communityName = data.communityName || 'コミュニティ';
  const senderName = data.senderName || 'ユーザー';
  const messageType = data.messageType || 'text';
  const textContent = data.textContent || '';

  const notificationTitle = `[${communityName}] ${senderName}`;
  const notificationBody = messageType === 'audio' ? `🎤 ${textContent}` : textContent;

  // バイブレーション設定を Cache API から読み込む（非同期、失敗時はバイブレーションなし）
  const getVibrationEnabled = () => {
    if (!('caches' in self)) return Promise.resolve(false);
    return caches.open('chatransceiver-settings')
      .then(cache => cache.match('/vibration-enabled'))
      .then(res => res ? res.text() : '0')
      .then(val => val === '1')
      .catch(() => false);
  };

  event.waitUntil(
    Promise.all([
      clients.matchAll({ type: 'window', includeUncontrolled: true }),
      getVibrationEnabled()
    ]).then(([windowClients, vibrationEnabled]) => {
      // 画面が開いていて、アクティブで、同じコミュニティを見ている場合は通知を出さない
      let isVisibleAndSameCommunity = false;
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.visibilityState === 'visible') {
          const url = new URL(client.url);
          if (url.searchParams.get('c') === communitySlug) {
            isVisibleAndSameCommunity = true;
            break;
          }
        }
      }

      if (isVisibleAndSameCommunity) {
        return Promise.resolve(); // 通知不要
      }

      const notificationOptions = {
        body: notificationBody,
        icon: '/chatora.png',
        data: { url: `/?c=${communitySlug}&m=${messageId}` },
        ...(vibrationEnabled ? { vibrate: [200, 100, 200] } : {})
      };
      return self.registration.showNotification(notificationTitle, notificationOptions);
    })
  );
});

// 通知クリック時のイベントハンドラ
self.addEventListener('notificationclick', function(event) {
  console.log('[firebase-messaging-sw.js] Notification click received.', event.notification.data);
  event.notification.close();

  // Firebase SDKが自動生成した通知の場合、dataは FCM_MSG の中に入っている
  let urlToOpen = '/';
  if (event.notification.data) {
    if (event.notification.data.FCM_MSG && event.notification.data.FCM_MSG.data && event.notification.data.FCM_MSG.data.url) {
      urlToOpen = new URL(event.notification.data.FCM_MSG.data.url, self.location.origin).href;
    } else if (event.notification.data.url) {
      urlToOpen = new URL(event.notification.data.url, self.location.origin).href;
    }
  }
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // 既に開いているタブがあればフォーカスして該当URLへ遷移
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.indexOf(self.location.origin) !== -1 && 'focus' in client) {
          // すでに現在のタブで開いているので URL だけ変更してフォーカス
          client.navigate(urlToOpen);
          return client.focus();
        }
      }
      // なければ新しくウィンドウを開く
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
