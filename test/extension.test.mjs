import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecorder} from '../extension/lib/recorder.js';

function mockChrome() {
  const calls = [];
  const local = {paused: []};
  const session = {};
  const chrome = {
    runtime: {id: 'self'},
    storage: {
      local: {
        get: async () => ({...local}),
        set: async value => { calls.push(['storage', structuredClone(value)]); Object.assign(local, value); },
      },
      session: {
        get: async () => ({...session}),
        set: async value => { calls.push(['session', value]); Object.assign(session, value); },
        remove: async key => { delete session[key]; },
      },
    },
    management: {
      getAll: async () => [{id: 'a', enabled: true}, {id: 'fixed', enabled: true, mayDisable: false}],
      setEnabled: async (id, enabled) => { calls.push(['enabled', id, enabled]); },
    },
    tabs: {query: async () => [{id: 1, title: 'Example'}],
      onUpdated: {addListener(fn) { this.listener = fn; }, removeListener() {}},
      reload: async id => chrome.tabs.onUpdated.listener(id, {status: 'complete'}),
    },
    debugger: {
      attach: async target => { calls.push(['attach', target]); },
      detach: async target => { calls.push(['detach', target]); },
      sendCommand: async (target, method, params) => { calls.push(['command', method, params]); },
    },
    action: {
      setBadgeText: async value => { calls.push(['badge', value.text]); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async value => { calls.push(['title', value.title]); },
    },
  };
  return {chrome, calls, local, session};
}

const start = {type: 'start', tab: 'active', quality: 80, maxWidth: 5000, pauseExtensions: [], generation: 'g'};

test('acquire persists intent and ignores missing and protected extensions', async () => {
  const {chrome, calls, local} = mockChrome();
  const recorder = createRecorder(chrome, () => {});
  await recorder.dispatch({...start, pauseExtensions: ['a', 'gone', 'fixed']});
  assert.deepEqual(local.paused, ['a']);
  const disabled = calls.findIndex(c => c[0] === 'enabled' && c[2] === false);
  assert.ok(calls.findIndex(c => c[0] === 'storage' && c[1].paused.includes('a')) < disabled);
  await recorder.dispatch({type: 'stop', generation: 'g'});
  assert.deepEqual(local.paused, []);
});

test('acquire refuses itself without disabling any extension', async () => {
  const {chrome, calls} = mockChrome();
  await assert.rejects(createRecorder(chrome, () => {}).dispatch({...start, pauseExtensions: ['a', 'self']}), /Cannot pause/);
  assert.equal(calls.filter(c => c[0] === 'enabled' && c[2] === false).length, 0);
});

test('failed restoration does not block start or stop of other targets', async () => {
  const {chrome, local, session} = mockChrome();
  local.paused = ['a', 'fixed', 'gone'];
  chrome.management.setEnabled = async id => { if (id === 'a') throw new Error('denied'); };
  chrome.tabs.query = async () => [{id: 1}, {id: 2}];
  const recorder = createRecorder(chrome, () => {}, {logger: {error() {}}});
  for (const id of [1, 2]) await recorder.dispatch({...start, tab: String(id), generation: String(id)});
  for (const id of [1, 2]) {
    const result = await recorder.dispatch({type: 'stop', generation: String(id)});
    assert.match(result.restoreFailed, /restore/);
  }
  assert.deepEqual(local.paused, ['a']);
  assert.equal(session.capture, undefined);
});

test('capture persists target and generation, clamps width and shows REC', async () => {
  const {chrome, calls, session} = mockChrome();
  const recorder = createRecorder(chrome, () => {});
  await recorder.dispatch(start);
  assert.deepEqual(session.capture, [{tabId: 1, generation: 'g', paused: []}]);
  assert.ok(calls.some(call => call[0] === 'badge' && call[1] === 'REC'));
  const capture = calls.find(call => call[1] === 'Page.startScreencast');
  assert.equal(capture[2].maxWidth, 3840);
  assert.ok(calls.findIndex(call => call[0] === 'session') < calls.indexOf(capture));
});

test('new worker cleanup detaches persisted capture', async () => {
  const {chrome, calls, session} = mockChrome();
  session.capture = {tabId: 42, generation: 'old'};
  await createRecorder(chrome, () => {}).cleanup();
  assert.ok(calls.some(call => call[0] === 'detach' && call[1].tabId === 42));
  assert.equal(session.capture, undefined);
  assert.ok(calls.some(call => call[0] === 'badge' && call[1] === ''));
});

test('cleanup failure preserves original capture error', async () => {
  const {chrome} = mockChrome();
  const original = new Error('original capture failure');
  chrome.debugger.sendCommand = async () => { throw original; };
  chrome.storage.session.remove = async () => { throw new Error('cleanup failure'); };
  const errors = [];
  const recorder = createRecorder(chrome, () => {}, {logger: {error: (...args) => errors.push(args)}});
  await assert.rejects(recorder.dispatch(start), error => error === original);
  assert.equal(errors.length, 2);
});

test('missing timestamp uses receipt time and stale generation acknowledgments are ignored', async () => {
  const {chrome, calls} = mockChrome();
  const messages = [];
  const recorder = createRecorder(chrome, value => messages.push(value), {now: () => 123});
  await recorder.dispatch(start);
  recorder.onFrame({tabId: 1}, 'Page.screencastFrame', {sessionId: 4, data: 'jpeg'});
  assert.equal(messages[0].ts, 123);
  await recorder.acknowledge({generation: 'stale', ack: 4});
  assert.equal(calls.filter(call => call[1] === 'Page.screencastFrameAck').length, 0);
  await recorder.detached({tabId: 1});
  assert.deepEqual(messages[1], {type: 'detached', generation: 'g', tabId: 1, stoppedAt: 123});
});

test('failed detach logs failures and retains capture and REC until retry succeeds', async () => {
  const {chrome, session, calls} = mockChrome();
  const errors = [];
  const recorder = createRecorder(chrome, () => {}, {logger: {error: (...args) => errors.push(args)}});
  await recorder.dispatch(start);
  const detach = chrome.debugger.detach;
  chrome.debugger.detach = async () => { throw new Error('temporary debugger error'); };
  chrome.debugger.sendCommand = async () => { throw new Error('stop failed'); };
  await assert.rejects(recorder.cleanup(), /temporary debugger error/);
  assert.deepEqual(session.capture, [{tabId: 1, generation: 'g', paused: []}]);
  assert.equal(calls.filter(call => call[0] === 'badge' && call[1] === '').length, 0);
  assert.equal(errors.length, 2);
  chrome.debugger.detach = detach;
  await recorder.cleanup();
  assert.equal(session.capture, undefined);
  assert.ok(calls.some(call => call[0] === 'badge' && call[1] === ''));
});

test('already detached tab clears stale persisted capture while logging Chrome errors', async () => {
  const {chrome, session} = mockChrome();
  session.capture = {tabId: 42, generation: 'old'};
  chrome.debugger.detach = async () => { throw new Error('Debugger is not attached to the tab with id: 42.'); };
  const errors = [];
  await createRecorder(chrome, () => {}, {logger: {error: (...args) => errors.push(args)}}).cleanup();
  assert.equal(session.capture, undefined);
  assert.equal(errors.length, 1);
});

test('start failure remains original even when debugger detach fails', async () => {
  const {chrome, session} = mockChrome();
  const original = new Error('capture failed');
  chrome.debugger.sendCommand = async () => { throw original; };
  chrome.debugger.detach = async () => { throw new Error('detach failed'); };
  const errors = [];
  const recorder = createRecorder(chrome, () => {}, {logger: {error: (...args) => errors.push(args)}});
  await assert.rejects(recorder.dispatch(start), error => error === original);
  assert.deepEqual(session.capture, [{tabId: 1, generation: 'g', paused: []}]);
  assert.equal(errors.length, 3);
});

test('parallel targets route frames and acknowledgments and keep per-tab indicators', async () => {
  const {chrome, session} = mockChrome();
  chrome.tabs.query = async () => [{id: 1}, {id: 2}];
  const badges = [], commands = [], messages = [];
  chrome.action.setBadgeText = async v => badges.push(v);
  chrome.debugger.sendCommand = async (target, method, params) => commands.push({target, method, params});
  const recorder = createRecorder(chrome, v => messages.push(v));
  await recorder.dispatch({...start, tab: '1'});
  await recorder.dispatch({...start, tab: '2', generation: 'h'});
  await assert.rejects(recorder.dispatch({...start, tab: '1', generation: 'i'}), /already recording/);
  assert.equal(session.capture.length, 2);
  for (const tabId of [2, 1]) recorder.onFrame({tabId}, 'Page.screencastFrame', {data: String(tabId), sessionId: tabId});
  assert.deepEqual(messages.map(v => [v.tabId, v.generation, v.data]), [[2, 'h', '2'], [1, 'g', '1']]);
  await recorder.acknowledge({generation: 'h', ack: 2});
  assert.deepEqual(commands.at(-1).target, {tabId: 2});
  await recorder.dispatch({type: 'stop', generation: 'g'});
  assert.deepEqual(session.capture, [{tabId: 2, generation: 'h', paused: []}]);
  assert.deepEqual(badges, [{tabId: 1, text: 'REC'}, {tabId: 2, text: 'REC'}, {tabId: 1, text: ''}]);
  await recorder.acknowledge({generation: 'g', ack: 1});
  await recorder.detached({tabId: 2});
  assert.equal(messages.at(-1).generation, 'h');
});

test('shared extension pause is restored only after last owner and restart cleans all targets', async () => {
  const {chrome, local, session, calls} = mockChrome();
  chrome.tabs.query = async () => [{id: 1}, {id: 2}];
  chrome.tabs.onUpdated = {addListener: fn => { chrome.tabs.listener = fn; }, removeListener: () => {}};
  chrome.tabs.reload = async id => chrome.tabs.listener(id, {status: 'complete'});
  const recorder = createRecorder(chrome, () => {});
  await recorder.dispatch({...start, tab: '1', pauseExtensions: ['a']});
  await recorder.dispatch({...start, tab: '2', generation: 'h', pauseExtensions: ['a']});
  assert.deepEqual(session.capture, [
    {tabId: 1, generation: 'g', paused: ['a']},
    {tabId: 2, generation: 'h', paused: ['a']},
  ]);
  assert.equal(calls.filter(c => c[0] === 'enabled' && c[2] === false).length, 1);
  await recorder.dispatch({type: 'stop', generation: 'g'});
  assert.deepEqual(local.paused, ['a']);
  assert.equal(calls.filter(c => c[0] === 'enabled' && c[2] === true).length, 0);
  await recorder.dispatch({type: 'stop', generation: 'h'});
  assert.deepEqual(local.paused, []);
  assert.equal(calls.filter(c => c[0] === 'enabled' && c[2] === true).length, 1);
  session.capture = [{tabId: 10, generation: 'old1'}, {tabId: 20, generation: 'old2'}];
  local.paused = ['a'];
  await createRecorder(chrome, () => {}).cleanup();
  assert.equal(session.capture, undefined);
  assert.ok([10, 20].every(id => calls.some(c => c[0] === 'detach' && c[1].tabId === id)));
  assert.deepEqual(local.paused, []);
});

test('queued detach from an old generation cannot clear a replacement capture', async () => {
  const {chrome, session} = mockChrome();
  const recorder = createRecorder(chrome, () => {});
  await recorder.dispatch(start);
  const old = recorder.generationFor(1);
  await recorder.dispatch({type: 'stop', generation: old});
  await recorder.dispatch({...start, generation: 'replacement'});
  await recorder.detached({tabId: 1, generation: old});
  assert.deepEqual(session.capture, [{tabId: 1, generation: 'replacement', paused: []}]);
  await recorder.cleanup();
});

for (const legacy of [false, true]) {
  test(`restart retains extension ownership after partial cleanup (legacy=${legacy})`, async () => {
    const {chrome, session, local, calls} = mockChrome();
    chrome.tabs.query = async () => [{id: 3}];
    session.capture = [1, 2].map(tabId => ({tabId, generation: `old${tabId}`,
      ...(legacy ? {} : {paused: ['a']})}));
    local.paused = ['a'];
    chrome.debugger.detach = async ({tabId}) => {
      if (tabId === 2) throw new Error('temporary detach failure');
    };
    const recorder = createRecorder(chrome, () => {}, {logger: {error() {}}});
    await assert.rejects(recorder.cleanup(), /temporary detach failure/);
    assert.deepEqual(session.capture, [{tabId: 2, generation: 'old2', paused: ['a']}]);
    await recorder.dispatch({...start, tab: '3', generation: 'new'});
    await recorder.dispatch({type: 'stop', generation: 'new'});
    await assert.rejects(recorder.cleanup(), /temporary detach failure/);
    assert.deepEqual(local.paused, ['a']);
    assert.equal(calls.filter(c => c[0] === 'enabled' && c[2] === true).length, 0);
    chrome.debugger.detach = async () => {};
    await recorder.cleanup();
    assert.deepEqual(local.paused, []);
    assert.equal(calls.filter(c => c[0] === 'enabled' && c[2] === true).length, 1);
  });
}

test('closed-tab badge and title failures do not fail stop', async () => {
  const {chrome, session} = mockChrome();
  const errors = [];
  const recorder = createRecorder(chrome, () => {}, {logger: {error: (...args) => errors.push(args)}});
  await recorder.dispatch(start);
  chrome.action.setBadgeText = async () => { throw new Error('No tab'); };
  chrome.action.setTitle = async () => { throw new Error('No tab'); };
  assert.deepEqual(await recorder.dispatch({type: 'stop', generation: 'g'}), {});
  assert.equal(session.capture, undefined);
  assert.equal(errors.length, 2);
});

test('detach notification bypasses queued reload and cleanup retains shared pause ownership', async () => {
  const {chrome, local} = mockChrome();
  chrome.tabs.query = async () => [{id: 1}, {id: 2}];
  const messages = [];
  const recorder = createRecorder(chrome, v => messages.push(v));
  await recorder.dispatch({...start, tab: '1', pauseExtensions: ['a']});
  let reloading;
  const reloadStarted = new Promise(resolve => { reloading = resolve; });
  chrome.tabs.reload = async () => reloading();
  const pendingStart = recorder.dispatch({...start, tab: '2', generation: 'h', pauseExtensions: ['a']});
  await reloadStarted;
  let cleanup;
  recorder.detached({tabId: 1}, 123, task => { cleanup = task; });
  assert.deepEqual(messages, [{type: 'detached', generation: 'g', tabId: 1, stoppedAt: 123}]);
  assert.deepEqual(local.paused, ['a']);
  chrome.tabs.onUpdated.listener(2, {status: 'complete'});
  await pendingStart;
  await cleanup();
  assert.deepEqual(local.paused, ['a']);
  await recorder.dispatch({type: 'stop', generation: 'h'});
  assert.deepEqual(local.paused, []);
});

test('stop-triggered detach does not release shared extension ownership twice', async () => {
  const {chrome, local} = mockChrome();
  chrome.tabs.query = async () => [{id: 1}, {id: 2}];
  const messages = [];
  const recorder = createRecorder(chrome, v => messages.push(v));
  chrome.debugger.detach = async source => recorder.detached(source);
  await recorder.dispatch({...start, tab: '1', pauseExtensions: ['a']});
  await recorder.dispatch({...start, tab: '2', generation: 'h', pauseExtensions: ['a']});
  await recorder.dispatch({type: 'stop', generation: 'g'});
  assert.deepEqual(local.paused, ['a']);
  assert.deepEqual(messages, []);
  await recorder.dispatch({type: 'stop', generation: 'h'});
  assert.deepEqual(local.paused, []);
});

for (const immediate of [false, true]) {
  test(`detach during failed start releases ownership once (immediate=${immediate})`, async () => {
    const {chrome, local} = mockChrome();
    chrome.tabs.query = async () => [{id: 1}, {id: 2}];
    const recorder = createRecorder(chrome, () => {}, {logger: {error() {}}});
    await recorder.dispatch({...start, tab: '1', pauseExtensions: ['a']});
    let cleanup;
    chrome.action.setBadgeText = async ({tabId, text}) => {
      if (tabId !== 2 || text !== 'REC') return;
      const pending = recorder.detached({tabId}, 123, task => {
        if (immediate) return task();
        cleanup = task;
      });
      await pending;
      throw new Error('tab detached during start');
    };
    await assert.rejects(recorder.dispatch({...start, tab: '2', generation: 'h', pauseExtensions: ['a']}), /tab detached/);
    await cleanup?.();
    assert.deepEqual(local.paused, ['a']);
    await recorder.dispatch({type: 'stop', generation: 'g'});
    assert.deepEqual(local.paused, []);
  });
}

test('pending restoration requested by a new capture stays disabled until that capture stops', async () => {
  const {chrome, local, session} = mockChrome();
  chrome.tabs.query = async () => [{id: 1}, {id: 2}];
  local.paused = ['a'];
  let enabled = false;
  let failRestore = true;
  chrome.management.getAll = async () => [{id: 'a', enabled}];
  chrome.management.setEnabled = async (_id, value) => {
    if (value && failRestore) throw new Error('temporary restore failure');
    enabled = value;
  };
  const recorder = createRecorder(chrome, () => {}, {logger: {error() {}}});
  await recorder.dispatch({...start, tab: '1', pauseExtensions: ['a']});
  failRestore = false;
  await recorder.dispatch({...start, tab: '2', generation: 'h'});
  await recorder.dispatch({type: 'stop', generation: 'h'});
  assert.equal(enabled, false);
  assert.deepEqual(session.capture, [{tabId: 1, generation: 'g', paused: ['a']}]);
  await recorder.dispatch({type: 'stop', generation: 'g'});
  assert.equal(enabled, true);
  assert.deepEqual(local.paused, []);
});
