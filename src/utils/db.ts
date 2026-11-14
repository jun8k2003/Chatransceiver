export const DB_NAME = 'ChatransceiverDB';
export const STORE_NAME = 'backgroundStore';
export const BG_IMAGE_KEY = 'custom_bg_image';
export const UNREAD_BADGE_KEY = 'unread_badge_enabled';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = (event) => {
      resolve((event.target as IDBOpenDBRequest).result);
    };

    request.onerror = (event) => {
      reject((event.target as IDBOpenDBRequest).error);
    };
  });
}

async function putValue<T>(key: string, value: T): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(value, key);

    request.onsuccess = () => resolve();
    request.onerror = (event) => reject((event.target as IDBRequest).error);
  });
}

export async function saveBackgroundImage(blob: Blob): Promise<void> {
  return putValue(BG_IMAGE_KEY, blob);
}

export async function saveUnreadBadgeEnabled(enabled: boolean): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  return putValue(UNREAD_BADGE_KEY, enabled);
}

export async function loadBackgroundImage(): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(BG_IMAGE_KEY);

    request.onsuccess = (event) => {
      resolve((event.target as IDBRequest).result || null);
    };
    request.onerror = (event) => reject((event.target as IDBRequest).error);
  });
}

export async function deleteBackgroundImage(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(BG_IMAGE_KEY);

    request.onsuccess = () => resolve();
    request.onerror = (event) => reject((event.target as IDBRequest).error);
  });
}
