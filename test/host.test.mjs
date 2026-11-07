import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHost, PROFILE_RETRY_S} from '../lib/host.mjs';

async function fixture(t, {startError, writeError, ffmpegFailures = 0, holdEncode, stopResult} = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'tabrec-fix3-host-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const sent = [];
  const outputs = [];
  let host;
  const logs = [];
  const injectedFs = {...fs, writeFile: async (path, ...args) => {
    if (writeError && path.endsWith('.jpg')) throw new Error('disk full');
    return fs.writeFile(path, ...args);
  }};
  const spawn = (_executable, args) => {
    outputs.push(args.at(-1));
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    if (holdEncode && outputs.length === 1) holdEncode((code = 0) => child.emit('close', code));
    else queueMicrotask(() => child.emit('close', ffmpegFailures-- > 0 ? 1 : 0));
    return child;
  };
  host = createHost({fs: injectedFs, spawn, hostsDir: join(root, 'hosts'), resolveProfile: async () => null, config: async () => ({pauseExtensions: []}),
    now: () => 10, log: value => logs.push(value), send: value => {
      sent.push(value);
      if (value.id) queueMicrotask(() => host.receive({type: 'result', id: value.id,
        ok: !(value.type === 'start' && startError), error: 'start failed', data: value.type === 'tabs' ? Array.from({length: 5}, (_, i) => ({id: i + 1, active: i === 0})) : value.type === 'stop' ? stopResult : {tabId: Number(value.tab)}}));
    }});
  t.after(() => host.close());
  const start = (extra = {}) => host.command({command: 'start', options: {tab: 'active', out: join(root, 'recording'), ...extra}});
  const command = (command, options = {}) => host.command({command, options});
  const frame = async generation => {
    host.receive({type: 'frame', generation, data: 'aGVsbG8=', ack: 1, ts: 1});
    await host.drain();
  };
  const sessions = async () => (await command('status')).sessions;
  return {host, root, start, command, sessions, frame, sent, outputs, logs};
}

test('failed start removes only the new session directory', async t => {
  const f = await fixture(t, {startError: true});
  await assert.rejects(f.start(), /start failed/);
  assert.equal((await f.sessions())[0], undefined);
  await assert.rejects(fs.stat(join(f.root, 'recording')), {code: 'ENOENT'});
  const existing = join(f.root, 'existing');
  await fs.mkdir(existing);
  await fs.writeFile(join(existing, 'keep'), 'keep');
  await assert.rejects(f.start({out: existing}), {code: 'EEXIST'});
  assert.equal(await fs.readFile(join(existing, 'keep'), 'utf8'), 'keep');
});

test('fatal write stop discards session and preserves frames directory', async t => {
  const f = await fixture(t, {writeError: true});
  const started = await f.start();
  await f.frame(started.session);
  await assert.rejects(f.command('stop'), /Frame write failed.*frames retained/);
  assert.equal((await f.sessions())[0], undefined);
  assert.equal(f.sent.filter(value => value.type === 'ack').length, 0);
  assert.ok(await fs.stat(started.directory));
});

test('zero-frame stop releases session', async t => {
  const f = await fixture(t);
  await f.start();
  await assert.rejects(f.command('stop'), /No frames received.*frames retained/);
  assert.equal((await f.sessions())[0], undefined);
});

test('ffmpeg failure retains session for retry at another output', async t => {
  const f = await fixture(t, {ffmpegFailures: 1});
  const started = await f.start();
  await f.frame(started.session);
  await assert.rejects(f.command('stop', {output: join(f.root, 'first.mp4')}), /ffmpeg failed/);
  assert.equal((await f.sessions())[0].id, started.session);
  const result = await f.command('stop', {output: join(f.root, 'second.mp4')});
  assert.equal(result.path, join(f.root, 'second.mp4'));
  assert.equal(f.outputs.length, 2);
  assert.equal(f.sent.filter(value => value.type === 'stop').length, 1);
  assert.equal((await f.sessions())[0], undefined);
});

test('generation mismatch is discarded and ack follows metadata write', async t => {
  const f = await fixture(t);
  const started = await f.start();
  await f.frame('old');
  assert.equal((await f.sessions())[0].frames, 0);
  await f.frame(started.session);
  assert.equal((await f.sessions())[0].frames, 1);
  assert.equal(f.sent.filter(value => value.type === 'ack').length, 1);
  const rows = await fs.readFile(join(started.directory, 'frames.jsonl'), 'utf8');
  assert.deepEqual(JSON.parse(rows), {file: 'frames/1.jpg', ts: 1});
  await f.command('discard');
});

class Client extends EventEmitter {
  setEncoding(value) { this.encoding = value; }
  setTimeout(value) { this.timeout = value; }
  end(value) { this.response = JSON.parse(value); this.emit('response'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}

async function waitUntil(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('condition timed out');
}

test('record client disconnection automatically stops and encodes', async t => {
  const f = await fixture(t);
  const socket = new Client();
  f.host.handleClient(socket);
  socket.emit('data', JSON.stringify({command: 'record', options: {
    tab: 'active', out: join(f.root, 'recording'), duration: 60,
  }}) + '\n');
  await waitUntil(async () => (await f.sessions())[0]);
  const s = (await f.sessions())[0];
  await f.frame(s.id);
  socket.destroy();
  await waitUntil(async () => !(await f.sessions())[0]);
  assert.equal(f.outputs.length, 1);
  assert.equal(socket.encoding, 'utf8');
  assert.equal(socket.timeout, 0);
});

test('host rejects non-allowlisted extensions before creating directory', async t => {
  const f = await fixture(t);
  await assert.rejects(f.start({pauseExtensions: ['a'.repeat(32)]}), /pauseExtensions/);
  await assert.rejects(fs.stat(join(f.root, 'recording')), {code: 'ENOENT'});
});

test('stop timestamp precedes stop rpc and missing frame timestamp falls back to receive time', async t => {
  const f = await fixture(t);
  const started = await f.start();
  f.host.receive({type: 'frame', generation: started.session, data: 'eA==', ack: 1});
  await f.host.drain();
  await f.command('stop');
  const rows = await fs.readFile(join(started.directory, 'frames.jsonl'), 'utf8');
  assert.equal(JSON.parse(rows).ts, 10);
  assert.match(await fs.readFile(join(started.directory, 'frames.concat'), 'utf8'), /duration 0.001/);
});

async function beginRecord(f, extra = {}) {
  const socket = new Client();
  f.host.handleClient(socket);
  socket.emit('data', JSON.stringify({command: 'record', options: {
    tab: 'active', out: join(f.root, 'recording'), duration: 60, ...extra,
  }}) + '\n');
  await waitUntil(async () => (await f.sessions())[0]);
  const s = (await f.sessions())[0];
  await f.frame(s.id);
  return socket;
}

test('manual stop promptly delivers the same encoded result to waiting record', async t => {
  const f = await fixture(t);
  const socket = await beginRecord(f);
  const stopped = await f.command('stop', {output: join(f.root, 'manual.mp4')});
  await waitUntil(() => socket.response);
  assert.deepEqual(socket.response, {ok: true, data: stopped});
  assert.equal(f.outputs.length, 1);
});

test('manual discard promptly completes waiting record without encoding', async t => {
  const f = await fixture(t);
  const socket = await beginRecord(f);
  const discarded = await f.command('discard');
  await waitUntil(() => socket.response);
  assert.deepEqual(socket.response, {ok: true, data: discarded});
  assert.equal(f.outputs.length, 0);
});

test('record deadline queued behind manual stop returns its result without a second stop', async t => {
  const f = await fixture(t);
  const socket = await beginRecord(f);
  const stop = f.command('stop', {output: join(f.root, 'race.mp4')});
  // Simulates the close/deadline trigger while the manual stop owns the queue.
  socket.emit('close');
  const result = await stop;
  await waitUntil(() => socket.response);
  assert.deepEqual(socket.response, {ok: true, data: result});
  assert.equal(f.outputs.length, 1);
  assert.equal(f.sent.filter(value => value.type === 'stop').length, 1);
});

test('max duration completes waiting record before record duration', async t => {
  const f = await fixture(t);
  const socket = await beginRecord(f, {maxDuration: 0.02});
  await waitUntil(() => socket.response);
  assert.equal(socket.response.ok, true);
  assert.equal(f.outputs.length, 1);
});

test('parallel sessions route frames, require selection and stop independently', async t => {
  const f = await fixture(t);
  const a = await f.start();
  const b = await f.start({tab: '2', out: join(f.root, 'second')});
  await f.frame(a.session);
  await f.frame(b.session);
  assert.deepEqual((await f.sessions()).map(s => [s.tabId, s.frames]), [[1, 1], [2, 1]]);
  for (const command of ['stop', 'discard']) {
    await assert.rejects(f.command(command), error => error.message.includes('--session') && error.message.includes(a.session) && error.message.includes(b.session));
  }
  await assert.rejects(f.start({out: join(f.root, 'duplicate')}), /already recording/);
  await f.command('stop', {session: a.session});
  assert.equal((await f.sessions())[0].id, b.session);
  assert.equal(f.sent.filter(s => s.type === 'stop')[0].generation, a.session);
  await f.command('stop');
  assert.deepEqual(await f.sessions(), []);
});

test('four session limit rejects fifth and resumes after discard', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 4; i++) await f.start({tab: String(i), out: join(f.root, String(i))});
  await assert.rejects(f.start({tab: '5', out: join(f.root, 'five')}), /Maximum 4/);
  const [first] = await f.sessions();
  await f.command('discard', {session: first.id});
  await f.start({tab: '5', out: join(f.root, 'five')});
  for (const s of await f.sessions()) await f.command('discard', {session: s.id});
});

test('record disconnect stops only its own session', async t => {
  const f = await fixture(t);
  const socket = await beginRecord(f);
  const other = await f.start({tab: '2', out: join(f.root, 'other')});
  await f.frame(other.session);
  socket.destroy();
  await waitUntil(() => f.outputs.length === 1);
  await waitUntil(async () => (await f.sessions()).length === 1);
  assert.equal((await f.sessions())[0].id, other.session);
  await f.command('stop');
});

test('max-duration stops only its own session', async t => {
  const f = await fixture(t);
  const timed = await f.start({maxDuration: 0.04});
  const other = await f.start({tab: '2', out: join(f.root, 'other')});
  await f.frame(timed.session);
  await f.frame(other.session);
  await waitUntil(async () => (await f.sessions()).length === 1);
  assert.equal((await f.sessions())[0].id, other.session);
  await f.command('discard');
});

for (const action of ['stop', 'discard', 'record-disconnect', 'max-duration']) {
  test(`slow encoding does not block another session's ${action}, tabs or start`, async t => {
    let finishEncode;
    const f = await fixture(t, {holdEncode: done => { finishEncode = done; }});
    t.after(() => finishEncode?.());
    let socket;
    if (action === 'record-disconnect') socket = await beginRecord(f);
    const a = await f.start({tab: '2', out: join(f.root, 'a')});
    await f.frame(a.session);
    const encoding = f.command('stop', {session: a.session});
    await waitUntil(() => finishEncode);
    assert.equal((await f.command('tabs')).tabs.length, 5);
    if (socket) {
      socket.destroy();
      await waitUntil(async () => (await f.sessions()).every(s => s.id === a.session));
    } else {
      const b = await f.start({tab: '3', out: join(f.root, 'b'), ...(action === 'max-duration' ? {maxDuration: 0.03} : {})});
      await f.frame(b.session);
      if (action === 'max-duration') await waitUntil(async () => !(await f.sessions()).some(s => s.id === b.session));
      else await f.command(action, {session: b.session});
    }
    assert.ok((await f.sessions()).some(s => s.id === a.session));
    finishEncode();
    await encoding;
  });
}

test('same-session simultaneous stops and discard wait for one encoding', async t => {
  let finishEncode;
  const f = await fixture(t, {holdEncode: done => { finishEncode = done; }});
  t.after(() => finishEncode?.());
  const a = await f.start();
  await f.frame(a.session);
  const first = f.command('stop');
  await waitUntil(() => finishEncode);
  const second = f.command('stop');
  const discarded = f.command('discard');
  await f.command('tabs');
  finishEncode();
  const results = await Promise.all([first, second, discarded]);
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  assert.equal(f.outputs.length, 1);
});

test('detach event timestamp determines final frame duration with finite fallback', async t => {
  for (const [stoppedAt, duration] of [[4, '3'], [Infinity, '9']]) {
    const f = await fixture(t);
    const a = await f.start();
    await f.frame(a.session);
    f.host.receive({type: 'detached', generation: a.session, stoppedAt});
    await f.command('stop');
    assert.match(await fs.readFile(join(a.directory, 'frames.concat'), 'utf8'), new RegExp(`duration ${duration}\\b`));
  }
});

test('restore failure warns and continues encoding', async t => {
  const f = await fixture(t, {stopResult: {restoreFailed: 'Could not restore extensions'}});
  const a = await f.start();
  await f.frame(a.session);
  await f.command('stop');
  assert.equal(f.outputs.length, 1);
  assert.match(f.logs.join(' '), /Extension restore failed/);
});

test('record ffmpeg failure provides exact session retry command', async t => {
  const f = await fixture(t, {ffmpegFailures: 1});
  const socket = await beginRecord(f);
  const [s] = await f.sessions();
  socket.emit('close');
  await waitUntil(() => socket.response);
  assert.equal(socket.response.ok, false);
  assert.ok(socket.response.error.includes(`stop --session ${s.id} -o`));
  await f.command('discard', {session: s.id});
});

for (const trigger of ['disconnect', 'deadline']) {
  test(`failed manual encoding shares its failure with overlapping ${trigger} and stop`, async t => {
    let finishEncode;
    const f = await fixture(t, {holdEncode: done => { finishEncode = done; }});
    t.after(() => finishEncode?.());
    const socket = await beginRecord(f, trigger === 'deadline' ? {duration: 0.1} : {});
    const [s] = await f.sessions();
    const first = f.command('stop', {output: join(f.root, 'manual.mp4')});
    const failed = assert.rejects(first, /ffmpeg failed/);
    await waitUntil(() => finishEncode);
    const overlapping = f.command('stop', {session: s.id});
    const sharedFailure = assert.rejects(overlapping, /ffmpeg failed/);
    if (trigger === 'disconnect') socket.emit('close');
    else await new Promise(resolve => setTimeout(resolve, 150));
    await f.command('tabs');
    finishEncode(1);
    await Promise.all([failed, sharedFailure]);
    await waitUntil(() => socket.response);
    assert.equal(socket.response.ok, false);
    assert.match(socket.response.error, /ffmpeg failed/);
    assert.equal(f.outputs.length, 1);
    assert.equal((await f.sessions())[0].id, s.id);
    await f.command('stop', {session: s.id, output: join(f.root, 'retry.mp4')});
    assert.equal(f.outputs.length, 2);
    assert.deepEqual(await f.sessions(), []);
  });
}

const INSTANCE = 'abcdef01-2345-4678-9abc-def012345678';

async function helloHost(t, overrides = {}) {
  const root = await fs.mkdtemp('/tmp/tabrec-prof-');
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const events = [];
  const logs = [];
  const clock = {now: 100};
  const lookups = {count: 0};
  const host = createHost({
    hostsDir: join(root, 'hosts'), log: value => logs.push(value), send: () => {}, now: () => clock.now,
    resolveProfile: async id => (++lookups.count > 1 ? {browser: 'aside', profileDir: 'Profile 2', profileName: `Work ${id.slice(0, 4)}`} : null),
    onListening: path => events.push(['listening', path]),
    onFatal: error => events.push(['fatal', error.message]),
    ...overrides,
  });
  t.after(() => host.close());
  const settled = () => new Promise(resolve => {
    const check = () => events.length ? resolve(events) : setTimeout(check, 5);
    check();
  });
  return {host, root, events, logs, clock, lookups, settled};
}

test('hello opens a private per-instance socket and profile lookups are throttled then cached', async t => {
  const f = await helloHost(t);
  assert.equal((await f.host.command({command: 'status', options: {}})).host.instanceId, undefined);
  f.host.receive({type: 'hello', instanceId: INSTANCE});
  const path = join(f.root, 'hosts', `${INSTANCE}.sock`);
  assert.deepEqual(await f.settled(), [['listening', path]]);
  assert.equal((await fs.lstat(path)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(join(f.root, 'hosts'))).mode & 0o777, 0o700);
  const first = await f.host.command({command: 'status', options: {}});
  assert.deepEqual(first, {host: {instanceId: INSTANCE, browser: null, profileDir: null, profileName: null}, sessions: []});
  f.clock.now += PROFILE_RETRY_S - 1;
  assert.equal((await f.host.command({command: 'status', options: {}})).host.profileName, null);
  assert.equal(f.lookups.count, 1);
  f.clock.now += 1;
  const second = await f.host.command({command: 'status', options: {}});
  assert.deepEqual(second.host, {instanceId: INSTANCE, browser: 'aside', profileDir: 'Profile 2', profileName: 'Work abcd'});
  f.clock.now += 1000;
  await f.host.command({command: 'status', options: {}});
  assert.equal(f.lookups.count, 2);
  f.host.receive({type: 'hello', instanceId: '00000000-0000-4000-8000-000000000000'});
  assert.equal(f.host.socketPath(), path);
  await f.host.close();
  await assert.rejects(fs.lstat(path), {code: 'ENOENT'});
});

test('hello rejects instance IDs that are not UUIDs', async t => {
  for (const instanceId of ['../escape', 'ABCDEF01-2345-4678-9ABC-DEF012345678', `${INSTANCE}/x`, 42, undefined]) {
    const f = await helloHost(t);
    f.host.receive({type: 'hello', instanceId});
    assert.deepEqual(await f.settled(), [['fatal', 'Invalid instance ID']]);
    await assert.rejects(fs.stat(join(f.root, 'hosts')), {code: 'ENOENT'});
  }
});

test('a live host for the same profile is kept and the newcomer fails without touching it', async t => {
  const first = await helloHost(t);
  first.host.receive({type: 'hello', instanceId: INSTANCE});
  await first.settled();
  const second = await helloHost(t, {hostsDir: join(first.root, 'hosts')});
  second.host.receive({type: 'hello', instanceId: INSTANCE});
  assert.deepEqual(await second.settled(), [['fatal', 'Another native host already serves this browser profile']]);
  await second.host.close();
  assert.ok((await fs.lstat(join(first.root, 'hosts', `${INSTANCE}.sock`))).isSocket());
});

test('close reports sessions that were still running', async t => {
  const f = await fixture(t);
  const started = await f.start();
  await f.host.close();
  assert.ok(f.logs.some(line => line.includes(`active session ${started.session}`) && line.includes(started.directory)));
});
