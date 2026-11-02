import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecorder, pauseExtensions, restoreExtensions} from '../extension/lib/recorder.js';

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
    tabs: {query: async () => [{id: 1, title: 'Example'}]},
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

test('pause persists each ID before disabling and ignores missing and protected extensions', async () => {
  const {chrome, calls} = mockChrome();
  assert.deepEqual(await pauseExtensions(chrome, ['a', 'gone', 'fixed']), ['a']);
  assert.deepEqual(calls, [['storage', {paused: ['a']}], ['enabled', 'a', false]]);
});

test('pause refuses itself before any mutation', async () => {
  const {chrome, calls} = mockChrome();
  await assert.rejects(pauseExtensions(chrome, ['a', 'self']), /Cannot pause/);
  assert.deepEqual(calls, []);
});

test('restore keeps only installed IDs whose restore failed', async () => {
  const {chrome, local, calls} = mockChrome();
  local.paused = ['a', 'fixed', 'gone'];
  chrome.management.setEnabled = async id => {
    calls.push(['restore', id]);
    if (id === 'a') throw new Error('denied');
  };
  await assert.rejects(restoreExtensions(chrome), /a/);
  assert.deepEqual(local.paused, ['a']);
  assert.deepEqual(calls.filter(call => call[0] === 'restore'), [['restore', 'a'], ['restore', 'fixed']]);
});

test('capture persists target and generation, clamps width and shows REC', async () => {
  const {chrome, calls, session} = mockChrome();
  const recorder = createRecorder(chrome, () => {});
  await recorder.dispatch(start);
  assert.deepEqual(session.capture, [{tabId: 1, generation: 'g'}]);
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
  assert.deepEqual(session.capture, [{tabId: 1, generation: 'g'}]);
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
  assert.deepEqual(session.capture, [{tabId: 1, generation: 'g'}]);
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
  assert.deepEqual(session.capture, [{tabId: 2, generation: 'h'}]);
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
  assert.deepEqual(session.capture, [{tabId: 1, generation: 'replacement'}]);
  await recorder.cleanup();
});
