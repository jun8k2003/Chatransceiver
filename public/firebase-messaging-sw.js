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

// Firebase SDKが notification ペイロードを自動処理するため、
// 手動での onBackgroundMessage による showNotification は削除します。
// （これにより、Android Chromeの「不正な通知」警告が完全に防止されます）

}

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
