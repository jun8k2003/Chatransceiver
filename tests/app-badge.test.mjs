import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const quietConsole = { log() {}, warn() {}, error() {} };

function loadTypeScript(path, globals = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 }
  });
  const context = vm.createContext({ exports: {}, console: quietConsole, ...globals });
  vm.runInContext(outputText, context);
  return context;
}

function badgeService(getUnreadCount, navigator) {
  const { exports } = loadTypeScript('../src/services/appbadge.ts', { navigator });
  return new exports.AppBadgeService({ getUnreadCount });
}

test('unsupported devices perform no unread query', async () => {
  const service = badgeService(() => assert.fail('unexpected query'), {});
  await service.refresh('user');
  await service.refresh(null);
});

test('unread totals set the badge; zero and logout clear it', async () => {
  const calls = [];
  let count = 7;
  const service = badgeService(async (userId) => {
    assert.equal(userId, 'user');
    return count;
  }, {
    setAppBadge: async (value) => calls.push(value),
    clearAppBadge: async () => calls.push('clear')
  });
  await service.refresh('user');
  count = 0;
  await service.refresh('user');
  await service.refresh(null);
  assert.deepEqual(calls, [7, 'clear', 'clear']);
});

test('stale count responses cannot overwrite newer counts or logout', async () => {
  const responses = [];
  const calls = [];
  const service = badgeService(() => new Promise((resolve) => responses.push(resolve)), {
    setAppBadge: async (value) => calls.push(value),
    clearAppBadge: async () => calls.push('clear')
  });
  const older = service.refresh('user');
  const newer = service.refresh('user');
  responses[1](2);
  await newer;
  responses[0](8);
  await older;
  const pending = service.refresh('user');
  await service.refresh(null);
  responses[2](5);
  await pending;
  assert.deepEqual(calls, [2, 'clear']);
});

test('count failures preserve the existing badge and API failures are contained', async () => {
  const service = badgeService(async () => { throw new Error('offline'); }, {
    setAppBadge: () => assert.fail('unexpected badge update'),
    clearAppBadge: () => assert.fail('unexpected clear')
  });
  await service.refresh('user');
  const rejected = badgeService(async () => 3, {
    setAppBadge: async () => { throw new Error('permission denied'); },
    clearAppBadge: async () => { throw new Error('permission denied'); }
  });
  await rejected.refresh('user');
  await rejected.refresh(null);
});

async function push({ unreadCount, navigator = {}, windowClients = [], indexedDB = undefined }) {
  const handlers = {};
  const notifications = [];
  const context = vm.createContext({
    navigator, URL, URLSearchParams, console: quietConsole, importScripts() {},
    indexedDB,
    location: { search: '' },
    clients: { matchAll: async () => windowClients },
    self: {
      addEventListener: (name, handler) => { handlers[name] = handler; },
      registration: { showNotification: async (...args) => notifications.push(args) }
    }
  });
  vm.runInContext(readFileSync(new URL('../public/firebase-messaging-sw.js', import.meta.url), 'utf8'), context);
  let completion;
  handlers.push({
    data: { json: () => ({ data: { communitySlug: 'example', unreadCount } }) },
    waitUntil: (promise) => { completion = promise; }
  });
  await completion;
  return notifications;
}

function mockIndexedDB(storedValues) {
  return {
    open() {
      const req = {};
      queueMicrotask(() => {
        const db = {
          objectStoreNames: { contains: () => true },
          transaction() {
            return {
              objectStore() {
                return {
                  get(key) {
                    const getReq = {};
                    queueMicrotask(() => {
                      getReq.result = storedValues[key];
                      getReq.onsuccess?.();
                    });
                    return getReq;
                  }
                };
              }
            };
          },
          close() {}
        };
        req.result = db;
        req.onsuccess?.({ target: req });
      });
      return req;
    }
  };
}

test('disabling unread badge clears app badge and skips unread query', async () => {
  const calls = [];
  const service = badgeService(() => assert.fail('unexpected query'), {
    setAppBadge: async (value) => calls.push(value),
    clearAppBadge: async () => calls.push('clear')
  });
  await service.refresh('user', false);
  assert.deepEqual(calls, ['clear']);
});

test('background pushes clear badge without setting it when unread badge setting is disabled', async () => {
  const calls = [];
  const notifications = await push({
    unreadCount: '5',
    indexedDB: mockIndexedDB({ unread_badge_enabled: false }),
    navigator: {
      setAppBadge: async (count) => calls.push(count),
      clearAppBadge: async () => calls.push('clear')
    }
  });
  assert.deepEqual(calls, ['clear']);
  assert.equal(notifications.length, 1);

  const enabledCalls = [];
  await push({
    unreadCount: '5',
    indexedDB: mockIndexedDB({ unread_badge_enabled: true }),
    navigator: {
      setAppBadge: async (count) => enabledCalls.push(count),
      clearAppBadge: async () => enabledCalls.push('clear')
    }
  });
  assert.deepEqual(enabledCalls, [5]);
});

test('background pushes set/clear numeric badges and tolerate old or invalid payloads', async () => {
  for (const [unreadCount, expected] of [['6', 6], ['0', 'clear'], [undefined, undefined], ['-1', undefined], ['invalid', undefined]]) {
    const calls = [];
    const notifications = await push({ unreadCount, navigator: {
      setAppBadge: async (count) => calls.push(count),
      clearAppBadge: async () => calls.push('clear')
    } });
    assert.deepEqual(calls, [expected]);
    assert.equal(notifications.length, 1);
  }
});

test('unsupported or rejected badges never prevent background notifications', async () => {
  for (const navigator of [{}, { setAppBadge: async () => { throw new Error('denied'); } }]) {
    assert.equal((await push({ unreadCount: '4', navigator })).length, 1);
  }
});

test('badge updates still run when existing foreground logic suppresses the notification', async () => {
  const calls = [];
  const notifications = await push({
    unreadCount: '2', navigator: { setAppBadge: async (count) => calls.push(count) },
    windowClients: [{ visibilityState: 'visible', url: 'https://example.test/?c=example' }]
  });
  assert.equal(notifications.length, 0);
  assert.deepEqual(calls, [2]);
});

test('sender includes the unread total as FCM string data and still sends when counting fails', async () => {
  for (const failure of [null, 'error', 'throw']) {
    const sent = [];
    let handler;
    const client = { from(table) {
      const filters = [];
      const query = {
        select() { return this; },
        eq(...args) { filters.push(args); return this; },
        single() { return this; },
        then(resolve, reject) {
          if (table === 'user_inboxes') {
            assert.deepEqual(filters, [['user_id', 'recipient'], ['is_read', false]]);
            if (failure === 'throw') return Promise.reject(new Error('offline')).then(resolve, reject);
            return Promise.resolve({ count: failure ? null : 9, error: failure }).then(resolve, reject);
          }
          const data = table === 'fcm_tokens' ? [{ fcm_token: 'test-token' }]
            : table === 'users' ? { discord_webhook_url: '' }
            : table === 'messages' ? { text_content: 'hello', users: { name: 'Sender' } }
            : [];
          return Promise.resolve({ data }).then(resolve, reject);
        }
      };
      return query;
    } };
    loadTypeScript('../supabase/functions/send-push-notification/index.ts', {
      require: (id) => id.includes('/http/server') ? { serve: (callback) => { handler = callback; } }
        : id.includes('supabase') ? { createClient: () => client } : { create: async () => 'jwt' },
      Deno: { env: { get: (key) => key === 'FIREBASE_SERVICE_ACCOUNT'
        ? JSON.stringify({ private_key: '-----BEGIN PRIVATE KEY-----AA==-----END PRIVATE KEY-----', project_id: 'test' }) : '' } },
      crypto: { subtle: { importKey: async () => ({}) } }, atob, Response,
      fetch: async (url, options) => {
        if (url.includes('oauth2')) return { json: async () => ({ access_token: 'token' }) };
        sent.push(JSON.parse(options.body));
        return { ok: true };
      }
    });
    await handler({ json: async () => ({ type: 'INSERT', record: { user_id: 'recipient', message_id: 'message' } }) });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.data.unreadCount, failure ? undefined : '9');
    assert.equal(sent[0].message.data.textContent, 'hello');
  }
});
