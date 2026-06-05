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

// バックグラウンドでプッシュ通知を受信した時の処理
messaging.onBackgroundMessage(function(payload) {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);

  const data = payload.data || {};
  const communitySlug = data.communitySlug || '';
  const messageId = data.messageId || '';
  const communityName = data.communityName || 'コミュニティ';
  const senderName = data.senderName || 'ユーザー';
  const messageType = data.messageType || 'text';
  const textContent = data.textContent || '';

  // 通知のタイトルと本文を動的に組み立て
  const notificationTitle = `[${communityName}] ${senderName}`;
  const notificationBody = messageType === 'audio' 
    ? `🎤 ${textContent}` 
    : textContent;

  const notificationOptions = {
    body: notificationBody,
    icon: '/chatora.png', // アプリのアイコンが public/chatora.png にあると想定
    // ダイレクトリンクURL。app.ts の handleDirectMessageLink が処理するパラメータ形式
      data: { url: `/?c=${communitySlug}&m=${messageId}` } 
    };

    return self.registration.showNotification(notificationTitle, notificationOptions);
  });
}

// 通知クリック時のイベントハンドラ
self.addEventListener('notificationclick', function(event) {
  console.log('[firebase-messaging-sw.js] Notification click received.');
  event.notification.close();

  if (!event.notification.data || !event.notification.data.url) return;
  const urlToOpen = new URL(event.notification.data.url, self.location.origin).href;
  
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
