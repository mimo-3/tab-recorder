import test from 'node:test';
import assert from 'node:assert/strict';
import {createConnection, ensureReconnectAlarm, instanceId, RECONNECT_ALARM, READY_TIMEOUT_MS} from '../extension/lib/connection.js';

function event() {
  const listeners = [];
  return {addListener: fn => listeners.push(fn), fire: (...args) => listeners.forEach(fn => fn(...args))};
}

function mockChrome({failConnect = 0} = {}) {
  const local = {};
  const ports = [];
  const alarms = new Map();
  const chrome = {
    storage: {local: {
      get: async key => (key in local ? {[key]: local[key]} : {}),
      set: async value => { Object.assign(local, value); },
    }},
    alarms: {
      get: async name => alarms.get(name),
      create: async (name, info) => { alarms.set(name, {name, ...info}); },
    },
    runtime: {
      connectNative: name => {
        if (failConnect-- > 0) throw new Error('no host');
        const port = {name, sent: [], onMessage: event(), onDisconnect: event(), postMessage: value => port.sent.push(value)};
        ports.push(port);
        return port;
      },
    },
  };
  return {chrome, local, ports, alarms};
}

function timers() {
  const pending = [];
  const retries = () => pending.filter(p => p.ms !== READY_TIMEOUT_MS);
  return {pending, retries, set: (fn, ms) => { pending.push({fn, ms}); return pending.length; }, clear: () => {}};
}

const quiet = {warn: () => {}};

test('instance ID is generated once and persisted', async () => {
  const m = mockChrome();
  const first = await instanceId(m.chrome);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(await instanceId(m.chrome), first);
  assert.equal(m.local.instanceId, first);
});

test('a stored instance ID that is not a UUID is replaced', async () => {
  const m = mockChrome();
  m.local.instanceId = '../escape';
  const replaced = await instanceId(m.chrome);
  assert.match(replaced, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(m.local.instanceId, replaced);
});

test('connect waits for cleanup but gives up waiting after the time limit', async () => {
  const m = mockChrome();
  let finish;
  const cleanup = new Promise(resolve => { finish = resolve; });
  const c = createConnection(m.chrome, {hostName: 'host', onMessage: () => {}, ready: () => cleanup, logger: quiet});
  const opening = c.connect();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(m.ports.length, 0);
  finish();
  await opening;
  assert.equal(m.ports.length, 1);
  const hung = mockChrome();
  const stuck = createConnection(hung.chrome, {hostName: 'host', onMessage: () => {}, ready: () => new Promise(() => {}), readyTimeoutMs: 20, logger: quiet});
  await stuck.connect();
  assert.equal(hung.ports.length, 1);
});

test('connect sends hello first and concurrent wake-ups open one port', async () => {
  const m = mockChrome();
  const messages = [];
  const c = createConnection(m.chrome, {hostName: 'host', onMessage: value => messages.push(value), logger: quiet});
  await Promise.all([c.connect(), c.connect(), c.connect()]);
  assert.equal(m.ports.length, 1);
  assert.deepEqual(m.ports[0].sent, [{type: 'hello', instanceId: m.local.instanceId}]);
  m.ports[0].onMessage.fire({type: 'tabs', id: '1'});
  c.send({type: 'result'});
  assert.deepEqual(messages, [{type: 'tabs', id: '1'}]);
  assert.deepEqual(m.ports[0].sent.at(-1), {type: 'result'});
});

test('disconnect cleans up, retries soon and the alarm path reconnects with the same ID', async () => {
  const m = mockChrome();
  const t = timers();
  let cleanups = 0;
  const c = createConnection(m.chrome, {hostName: 'host', onMessage: () => {}, onDisconnect: () => cleanups++,
    setTimer: t.set, clearTimer: t.clear, logger: quiet});
  await c.connect();
  m.ports[0].onDisconnect.fire();
  assert.equal(cleanups, 1);
  assert.equal(c.connected(), false);
  assert.equal(t.retries()[0].ms, 1_000);
  // The worker may be suspended before the timer fires; an alarm wake-up must still reconnect.
  await c.connect();
  assert.equal(m.ports.length, 2);
  assert.equal(m.ports[1].sent[0].instanceId, m.ports[0].sent[0].instanceId);
  await c.connect();
  assert.equal(m.ports.length, 2);
});

test('failed connections back off up to 30 seconds', async () => {
  const m = mockChrome({failConnect: 10});
  const t = timers();
  const c = createConnection(m.chrome, {hostName: 'host', onMessage: () => {}, setTimer: t.set, clearTimer: t.clear, logger: quiet});
  for (let i = 0; i < 7; i++) await c.connect();
  assert.deepEqual(t.retries().map(p => p.ms), [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  assert.equal(c.connected(), false);
});

test('reconnect alarm is created once with a 30 second period', async () => {
  const m = mockChrome();
  await ensureReconnectAlarm(m.chrome);
  const created = m.alarms.get(RECONNECT_ALARM);
  assert.equal(created.periodInMinutes, 0.5);
  await ensureReconnectAlarm(m.chrome);
  assert.equal(m.alarms.get(RECONNECT_ALARM), created);
});

test('service worker registers the alarm listener at top level and reconnects on wake-up', async () => {
  const m = mockChrome();
  const session = {};
  Object.assign(m.chrome.storage, {session: {get: async () => ({...session}), set: async () => {}, remove: async () => {}}});
  m.chrome.alarms.onAlarm = event();
  m.chrome.runtime.onStartup = event();
  m.chrome.runtime.onInstalled = event();
  m.chrome.runtime.id = 'self';
  m.chrome.debugger = {onEvent: event(), onDetach: event()};
  m.chrome.management = {getAll: async () => []};
  globalThis.chrome = m.chrome;
  try {
    await import(`../extension/background.js?worker=${Date.now()}`);
    const settle = () => new Promise(resolve => setTimeout(resolve, 20));
    await settle();
    assert.equal(m.alarms.get(RECONNECT_ALARM).periodInMinutes, 0.5);
    assert.equal(m.ports.length, 1);
    assert.equal(m.ports[0].sent[0].type, 'hello');
    m.ports[0].onDisconnect.fire();
    m.chrome.alarms.onAlarm.fire({name: 'other'});
    await settle();
    assert.equal(m.ports.length, 1);
    m.chrome.alarms.onAlarm.fire({name: RECONNECT_ALARM});
    await settle();
    assert.equal(m.ports.length, 2);
    assert.equal(m.ports[1].sent[0].instanceId, m.ports[0].sent[0].instanceId);
    // A dispatch that never settles must not block the alarm path.
    m.chrome.tabs = {query: () => new Promise(() => {})};
    m.ports[1].onMessage.fire({type: 'tabs', id: 'hung'});
    m.ports[1].onDisconnect.fire();
    m.chrome.alarms.onAlarm.fire({name: RECONNECT_ALARM});
    await new Promise(resolve => setTimeout(resolve, READY_TIMEOUT_MS + 100));
    assert.equal(m.ports.length, 3);
  } finally {
    delete globalThis.chrome;
  }
});
