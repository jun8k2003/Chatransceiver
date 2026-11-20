import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const appCode = ts.transpileModule(readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 }
}).outputText;

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};
const message = id => ({ id, senderId: 'peer', createdAt: new Date('2026-11-21T00:00:00Z') });

function fixture({ mobile = true, visible = true } = {}) {
  const handlers = {};
  const document = {
    visibilityState: visible ? 'visible' : 'hidden',
    addEventListener: (name, callback) => { handlers[name] = callback; }
  };
  const calls = [];
  class Stub { onButtonPress() {} }
  const exports = {};
  vm.runInNewContext(appCode, {
    exports, document, window: { matchMedia: () => ({ matches: mobile }) },
    console: { error() {} },
    require: () => ({
      AudioManager: Stub, AudioPlaybackQueue: Stub, UIController: Stub,
      SupabaseService: Stub, FCMService: Stub, AppBadgeService: Stub,
      WakeLockService: Stub, MediaButtonPttService: Stub
    })
  });
  const app = new exports.App();
  Object.assign(app.state, {
    currentUser: { id: 'me' }, currentCommunity: { id: 'community' },
    activeChatHistoryId: 'individual', selectedUserIds: ['peer'],
    members: [{ id: 'peer', userNumber: 1, unreadCount: 2, latestUnreadTime: 10 }],
    groups: [{ id: 'group', unreadCount: 3, latestUnreadTime: 20 }],
    messages: [message('old')], isLoading: false, mobileChatForceOpen: true,
    autoplayEnabled: false
  });
  app.loadedChatHistoryId = 'individual';
  app.supabaseService = {
    getOrCreateIndividualRoom: async () => 'individual',
    getRoomMessages: async roomId => { calls.push(['fetch', roomId]); return [message('new')]; },
    markAsRead: async (...args) => {
      calls.push(['read', ...args]);
      assert.ok(app.state.messages.some(m => m.id === 'new'), 'history must be loaded before reading');
      assert.ok(calls.some(c => c[0] === 'render' && c[1]), 'history must be rendered before reading');
    },
    subscribeRoomMessages: () => ({ unsubscribe() {} })
  };
  app.uiController = { render: state => calls.push(['render', state.messages.some(m => m.id === 'new')]) };
  app.appBadgeService = { refresh: async () => { calls.push(['badge']); } };
  app.loadCommunityData = async () => { calls.push(['reload']); };
  return { app, calls, document, handlers };
}

test('opening an individual chat reads it only after fetching and rendering history', async () => {
  const { app, calls } = fixture();
  const response = deferred();
  app.supabaseService.getRoomMessages = () => response.promise;
  const opening = app.handleOpenUser('peer');
  await flush();
  assert.equal(calls.filter(c => c[0] === 'read').length, 0);
  response.resolve([message('new')]);
  await opening;
  assert.deepEqual(calls.find(c => c[0] === 'read'), ['read', 'individual', 'me']);
  assert.equal(app.state.members[0].unreadCount, 0);
  app.handleBackToSidebar();
  assert.equal(app.state.members[0].unreadCount, 0);
});

test('opening a group clears its unread badge, including an existing group matched by members', async () => {
  for (const matchMembers of [false, true]) {
    const { app, calls } = fixture();
    app.groupMembersMap = { group: ['me', 'peer', 'another'] };
    if (matchMembers) await app.handleCreateGroup(['peer', 'another']);
    else await app.handleOpenGroup('group');
    assert.deepEqual(calls.find(c => c[0] === 'read'), ['read', 'group', 'me']);
    assert.equal(app.state.groups[0].unreadCount, 0);
    assert.equal(app.state.members[0].unreadCount, 2);
  }
});

test('returning from a notification refreshes missed history and clears the visible room badge', async () => {
  const { app, calls, document, handlers } = fixture({ visible: false });
  document.visibilityState = 'visible';
  handlers.visibilitychange();
  await flush();
  assert.deepEqual(calls.find(c => c[0] === 'read'), ['read', 'individual', 'me']);
  assert.equal(app.state.members[0].unreadCount, 0);
  assert.ok(app.state.messages.some(m => m.id === 'new'));
});

test('incoming messages in a visible room are displayed and read regardless of realtime event order', async () => {
  const { app, calls } = fixture();
  app.handleNewInboxItem({ id: 'new', roomId: 'individual' });
  await flush();
  assert.equal(calls.filter(c => c[0] === 'read').length, 1);
  assert.equal(app.state.members[0].unreadCount, 0);
});

test('background, mobile list, and other-room arrivals preserve unread state and autoplay', async () => {
  for (const situation of ['background', 'list', 'other-room']) {
    const { app, calls, document } = fixture();
    if (situation === 'background') document.visibilityState = 'hidden';
    if (situation === 'list') app.state.mobileChatForceOpen = false;
    const roomId = situation === 'other-room' ? 'group' : 'individual';
    app.state.autoplayEnabled = true;
    app.enqueuePlaybackItem = item => calls.push(['play', item.id]);
    app.handleNewInboxItem({ id: 'new', roomId });
    await flush();
    assert.equal(calls.filter(c => c[0] === 'read').length, 0, situation);
    assert.equal(app.state.members[0].unreadCount, 2, situation);
    assert.ok(calls.some(c => c[0] === 'reload'), situation);
    assert.ok(calls.some(c => c[0] === 'play'), situation);
  }
});

test('desktop visible chat is read even without the mobile navigation flag', async () => {
  const { app, calls } = fixture({ mobile: false });
  app.state.mobileChatForceOpen = false;
  await app.resyncRoomMessages('individual');
  assert.equal(calls.filter(c => c[0] === 'read').length, 1);
});

test('opening a chat while the page is hidden does not read it', async () => {
  for (const group of [false, true]) {
    const { app, calls } = fixture({ visible: false });
    if (group) await app.handleOpenGroup('group');
    else await app.handleOpenUser('peer');
    assert.equal(calls.filter(c => c[0] === 'read').length, 0);
    assert.equal(app.state.members[0].unreadCount, 2);
    assert.equal(app.state.groups[0].unreadCount, 3);
  }
});

test('a history response after switching rooms cannot overwrite or read the next room', async () => {
  const { app, calls } = fixture();
  const response = deferred();
  app.supabaseService.getRoomMessages = () => response.promise;
  const refreshing = app.resyncRoomMessages('individual');
  app.state.activeChatHistoryId = 'group';
  app.state.messages = [message('group-message')];
  response.resolve([message('new')]);
  await refreshing;
  assert.equal(app.state.messages[0].id, 'group-message');
  assert.equal(calls.filter(c => c[0] === 'read').length, 0);
});

test('hiding the app during history fetch preserves unread until it becomes visible again', async () => {
  const { app, calls, document } = fixture();
  const response = deferred();
  app.supabaseService.getRoomMessages = () => response.promise;
  const refreshing = app.resyncRoomMessages('individual');
  document.visibilityState = 'hidden';
  response.resolve([message('new')]);
  await refreshing;
  assert.equal(calls.filter(c => c[0] === 'read').length, 0);
  assert.equal(app.state.members[0].unreadCount, 2);
});

test('failed history fetches and failed read updates do not clear unread badges', async () => {
  for (const failure of ['fetch', 'read']) {
    const { app, calls } = fixture();
    if (failure === 'fetch') {
      app.supabaseService.getRoomMessages = async () => { throw new Error('offline'); };
    } else {
      app.supabaseService.markAsRead = async () => { throw new Error('denied'); };
    }
    await app.handleOpenUser('peer');
    assert.equal(app.state.members[0].unreadCount, 2, failure);
    if (failure === 'fetch') assert.equal(calls.filter(c => c[0] === 'read').length, 0);
  }
});

test('an unread count fetch started before reading cannot bring back a cleared badge', async () => {
  for (const staleResult of ['members', 'groups']) {
    const { app } = fixture();
    const response = deferred();
    app.supabaseService.getCommunityMembers = async () => [{ id: 'peer', userNumber: 1 }];
    app.supabaseService.getUnreadIndividualCounts = () => staleResult === 'members'
      ? response.promise : Promise.resolve({ peer: { count: 2, latestTime: 10 } });
    app.supabaseService.getCommunityGroups = () => response.promise;
    if (staleResult === 'groups') {
      app.state.activeChatHistoryId = 'group';
      app.loadedChatHistoryId = 'group';
    }
    const loading = Object.getPrototypeOf(app).loadCommunityData.call(app);
    await flush();
    app.state.messages = [message('new')];
    app.updateUI();
    await app.markVisibleChatAsRead();
    response.resolve(staleResult === 'members'
      ? { peer: { count: 2, latestTime: 10 } }
      : [{ id: 'group', unreadCount: 3, latestUnreadTime: 20 }]);
    await loading;
    assert.equal(staleResult === 'members' ? app.state.members[0].unreadCount : app.state.groups[0].unreadCount, 0);
  }
});

test('the read API scopes updates to the user and room and reports rejected updates', async () => {
  const source = readFileSync(new URL('../src/services/supabase.ts', import.meta.url), 'utf8')
    .replaceAll('import.meta.env', '({})');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 }
  }).outputText;
  for (const error of [null, new Error('permission denied')]) {
    const filters = [];
    const query = {
      update(value) {
        assert.equal(value.is_read, true);
        assert.deepEqual(Object.keys(value), ['is_read']);
        return this;
      },
      eq(...args) { filters.push(args); return this; },
      then(resolve, reject) { return Promise.resolve({ error }).then(resolve, reject); }
    };
    const exports = {};
    vm.runInNewContext(code, {
      exports,
      require: () => ({ createClient: () => ({ from(table) {
        assert.equal(table, 'user_inboxes');
        return query;
      } }) })
    });
    const request = new exports.SupabaseService().markAsRead('room', 'user');
    if (error) await assert.rejects(request, /permission denied/);
    else await request;
    assert.deepEqual(filters, [['room_id', 'room'], ['user_id', 'user'], ['is_read', false]]);
  }
});
