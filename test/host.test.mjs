import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHost} from '../lib/host.mjs';

async function fixture(t, {startError, writeError, ffmpegFailures = 0} = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'tabrec-par-host-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const sent = [];
  const outputs = [];
  let host;
  const injectedFs = {...fs, writeFile: async (path, ...args) => {
    if (writeError && path.endsWith('.jpg')) throw new Error('disk full');
    return fs.writeFile(path, ...args);
  }};
  const spawn = (_executable, args) => {
    outputs.push(args.at(-1));
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit('close', ffmpegFailures-- > 0 ? 1 : 0));
    return child;
  };
  host = createHost({fs: injectedFs, spawn, config: async () => ({pauseExtensions: []}),
    now: () => 10, log: () => {}, send: value => {
      sent.push(value);
      if (value.id) queueMicrotask(() => host.receive({type: 'result', id: value.id,
        ok: !(value.type === 'start' && startError), error: 'start failed', data: value.type === 'tabs' ? Array.from({length: 5}, (_, i) => ({id: i + 1, active: i === 0})) : {tabId: Number(value.tab)}}));
    }});
  t.after(() => host.close());
  const start = (extra = {}) => host.command({command: 'start', options: {tab: 'active', out: join(root, 'recording'), ...extra}});
  const command = (command, options = {}) => host.command({command, options});
  const frame = async generation => {
    host.receive({type: 'frame', generation, data: 'aGVsbG8=', ack: 1, ts: 1});
    await host.drain();
  };
  return {host, root, start, command, frame, sent, outputs};
}

test('failed start removes only the new session directory', async t => {
  const f = await fixture(t, {startError: true});
  await assert.rejects(f.start(), /start failed/);
  assert.equal((await f.command('status'))[0], undefined);
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
  assert.equal((await f.command('status'))[0], undefined);
  assert.equal(f.sent.filter(value => value.type === 'ack').length, 0);
  assert.ok(await fs.stat(started.directory));
});

test('zero-frame stop releases session', async t => {
  const f = await fixture(t);
  await f.start();
  await assert.rejects(f.command('stop'), /No frames received.*frames retained/);
  assert.equal((await f.command('status'))[0], undefined);
});

test('ffmpeg failure retains session for retry at another output', async t => {
  const f = await fixture(t, {ffmpegFailures: 1});
  const started = await f.start();
  await f.frame(started.session);
  await assert.rejects(f.command('stop', {output: join(f.root, 'first.mp4')}), /ffmpeg failed/);
  assert.equal((await f.command('status'))[0].id, started.session);
  const result = await f.command('stop', {output: join(f.root, 'second.mp4')});
  assert.equal(result.path, join(f.root, 'second.mp4'));
  assert.equal(f.outputs.length, 2);
  assert.equal(f.sent.filter(value => value.type === 'stop').length, 1);
  assert.equal((await f.command('status'))[0], undefined);
});

test('generation mismatch is discarded and ack follows metadata write', async t => {
  const f = await fixture(t);
  const started = await f.start();
  await f.frame('old');
  assert.equal((await f.command('status'))[0].frames, 0);
  await f.frame(started.session);
  assert.equal((await f.command('status'))[0].frames, 1);
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
  await waitUntil(async () => (await f.command('status'))[0]);
  const s = (await f.command('status'))[0];
  await f.frame(s.id);
  socket.destroy();
  await waitUntil(async () => !(await f.command('status'))[0]);
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
  await waitUntil(async () => (await f.command('status'))[0]);
  const s = (await f.command('status'))[0];
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
  assert.deepEqual((await f.command('status')).map(s => [s.tabId, s.frames]), [[1, 1], [2, 1]]);
  for (const command of ['stop', 'discard']) {
    await assert.rejects(f.command(command), error => error.message.includes('--session') && error.message.includes(a.session) && error.message.includes(b.session));
  }
  await assert.rejects(f.start({out: join(f.root, 'duplicate')}), /already recording/);
  await f.command('stop', {session: a.session});
  assert.equal((await f.command('status'))[0].id, b.session);
  assert.equal(f.sent.filter(s => s.type === 'stop')[0].generation, a.session);
  await f.command('stop');
  assert.deepEqual(await f.command('status'), []);
});

test('four session limit rejects fifth and resumes after discard', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 4; i++) await f.start({tab: String(i), out: join(f.root, String(i))});
  await assert.rejects(f.start({tab: '5', out: join(f.root, 'five')}), /Maximum 4/);
  const [first] = await f.command('status');
  await f.command('discard', {session: first.id});
  await f.start({tab: '5', out: join(f.root, 'five')});
  for (const s of await f.command('status')) await f.command('discard', {session: s.id});
});

test('record disconnect stops only its own session', async t => {
  const f = await fixture(t);
  const socket = await beginRecord(f);
  const other = await f.start({tab: '2', out: join(f.root, 'other')});
  await f.frame(other.session);
  socket.destroy();
  await waitUntil(() => f.outputs.length === 1);
  await waitUntil(async () => (await f.command('status')).length === 1);
  assert.equal((await f.command('status'))[0].id, other.session);
  await f.command('stop');
});

test('max-duration stops only its own session', async t => {
  const f = await fixture(t);
  const timed = await f.start({maxDuration: 0.04});
  const other = await f.start({tab: '2', out: join(f.root, 'other')});
  await f.frame(timed.session);
  await f.frame(other.session);
  await waitUntil(async () => (await f.command('status')).length === 1);
  assert.equal((await f.command('status'))[0].id, other.session);
  await f.command('discard');
});
