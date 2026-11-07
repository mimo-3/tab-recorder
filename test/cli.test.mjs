import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, lstat, readFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { findFfmpeg, request, main, discoverHosts } from '../bin/tab-recorder.mjs';

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tabrec-prof-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('ffmpeg discovery skips relative PATH entries and resolves symlinks', async t => {
  const dir = await temporary(t);
  const executable = join(dir, 'actual');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await symlink(executable, join(dir, 'ffmpeg'));
  assert.equal(await findFfmpeg(undefined, `.:relative:${dir}`), await realpath(executable));
  assert.equal(await findFfmpeg(join(dir, 'ffmpeg')), await realpath(executable));
  await assert.rejects(findFfmpeg(undefined, '.:relative'));
});

test('CLI request preserves split UTF-8 responses', async t => {
  const dir = await temporary(t);
  const connect = () => {
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        const response = Buffer.from(JSON.stringify({ ok: true, data: { title: '録画' } }) + '\n');
        let offset = 0;
        function next() {
          if (offset === response.length) return socket.push(null);
          socket.push(response.subarray(offset, ++offset));
          setImmediate(next);
        }
        next();
        callback();
      },
    });
    socket.setTimeout = () => {};
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  };
  assert.deepEqual(await request('tabs', {}, join(dir, 'socket'), connect), { title: '録画' });
});

test('offline encode runs without native host and preserves existing concat safety', async t => {
  const dir = await temporary(t);
  await mkdir(join(dir, 'frames'));
  await writeFile(join(dir, 'frames/1.jpg'), 'fixture');
  await writeFile(join(dir, 'frames.jsonl'), JSON.stringify({ file: 'frames/1.jpg', ts: 1 }) + '\n');
  await writeFile(join(dir, 'frames.concat'), 'old concat');
  const ffmpeg = join(dir, 'ffmpeg');
  await writeFile(ffmpeg, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const output = join(dir, 'out.mp4');
  assert.deepEqual(await main(['encode', dir, '--ffmpeg', ffmpeg, '-o', output]), { path: output });
});

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_DEAD = '33333333-3333-4333-8333-333333333333';
const ID_GONE = '44444444-4444-4444-8444-444444444444';

// Fake per-profile hosts keyed by socket path; records each request it serves.
function fakeHosts(dir, hosts) {
  const calls = [];
  const connect = path => {
    const id = path.slice(dir.length + 1, -'.sock'.length);
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        const req = JSON.parse(chunk.toString());
        calls.push([id, req.command, req.options]);
        const data = hosts[id].handle(req);
        socket.push(JSON.stringify({ ok: true, data }) + '\n');
        socket.push(null);
        callback();
      },
    });
    socket.setTimeout = () => {};
    queueMicrotask(() => {
      const error = hosts[id]?.error;
      if (error) socket.emit('error', Object.assign(new Error(error), { code: error }));
      else socket.emit('connect');
    });
    return socket;
  };
  return { connect, calls };
}

function profileHost(id, { name, dir, tabs = [], sessions = [] }) {
  const host = { instanceId: id, browser: 'aside', profileDir: dir, profileName: name };
  return {
    handle(req) {
      if (req.command === 'status') return { host, sessions };
      if (req.command === 'tabs') return { host, tabs };
      return { routed: id, command: req.command, options: req.options };
    },
  };
}

async function hostsFixture(t) {
  const dir = await temporary(t);
  const hosts = {
    [ID_A]: profileHost(ID_A, { name: 'Work', dir: 'Default', tabs: [{ id: 1 }, { id: 2 }], sessions: [{ id: 'sa', tabId: 1 }] }),
    [ID_B]: profileHost(ID_B, { name: 'Personal', dir: 'Profile 1', tabs: [{ id: 7 }], sessions: [{ id: 'sb', tabId: 7 }] }),
    [ID_GONE]: { error: 'ENOENT' },
  };
  for (const id of [ID_A, ID_B, ID_GONE]) await writeFile(join(dir, `${id}.sock`), '');
  await writeFile(join(dir, 'not-a-host.sock'), '');
  const fake = fakeHosts(dir, hosts);
  return { dir, hosts, ...fake, run: argv => main(argv, { dir, connect: fake.connect, config: async () => ({ pauseExtensions: [] }) }) };
}

test('status and tabs aggregate every live profile and tag each row', async t => {
  const f = await hostsFixture(t);
  const status = await f.run(['status']);
  assert.deepEqual(status.map(s => [s.id, s.profile.profileName, s.profile.instanceId]), [['sa', 'Work', ID_A], ['sb', 'Personal', ID_B]]);
  const tabs = await f.run(['tabs']);
  assert.deepEqual(tabs.map(tab => [tab.id, tab.profile.profileDir]), [[1, 'Default'], [2, 'Default'], [7, 'Profile 1']]);
  assert.deepEqual((await f.run(['tabs', '--profile', 'Personal'])).map(tab => tab.id), [7]);
  assert.ok(!f.calls.some(([id]) => id === 'not-a-host'));
});

test('--profile matches name, directory or instance ID prefix', async t => {
  const f = await hostsFixture(t);
  assert.equal((await f.run(['start', '--tab', 'active', '--profile', 'Work'])).routed, ID_A);
  assert.equal((await f.run(['start', '--tab', 'active', '--profile', 'Profile 1'])).routed, ID_B);
  assert.equal((await f.run(['start', '--tab', 'active', '--profile', '2222'])).routed, ID_B);
  await assert.rejects(f.run(['start', '--tab', 'active', '--profile', 'Nope']), /No connected profile matches --profile Nope/);
  const sent = f.calls.find(([, command]) => command === 'start')[2];
  assert.equal(sent.profile, undefined);
});

test('start picks the profile that owns a numeric tab and rejects ambiguity', async t => {
  const f = await hostsFixture(t);
  assert.equal((await f.run(['start', '--tab', '7'])).routed, ID_B);
  assert.equal((await f.run(['record', '--tab', '2', '--duration', '1'])).routed, ID_A);
  await assert.rejects(f.run(['start', '--tab', 'active']), /matches 2 browser profiles; pass --profile/);
  await assert.rejects(f.run(['start', '--tab', '99']), /not found in any connected profile/);
  f.hosts[ID_B] = profileHost(ID_B, { name: 'Personal', dir: 'Profile 1', tabs: [{ id: 1 }] });
  await assert.rejects(f.run(['start', '--tab', '1']), /--tab 1 matches 2 browser profiles/);
});

test('stop and discard route by session ID across profiles', async t => {
  const f = await hostsFixture(t);
  assert.equal((await f.run(['stop', '--session', 'sb'])).routed, ID_B);
  assert.equal((await f.run(['discard', '--session', 'sa'])).routed, ID_A);
  await assert.rejects(f.run(['stop', '--session', 'missing']), /Session ID does not match/);
  await assert.rejects(f.run(['stop']), /--session is required/);
  assert.equal((await f.run(['stop', '--profile', 'Work'])).routed, ID_A);
});

test('single profile keeps the old behavior and zero profiles explain the fix', async t => {
  const f = await hostsFixture(t);
  f.hosts[ID_B] = { error: 'ENOENT' };
  assert.equal((await f.run(['start', '--tab', 'active'])).routed, ID_A);
  assert.equal((await f.run(['stop'])).routed, ID_A);
  f.hosts[ID_A] = { error: 'ENOENT' };
  await assert.rejects(f.run(['status']), /Native host unavailable: no browser profile is connected/);
  const empty = await temporary(t);
  await assert.rejects(main(['status'], { dir: join(empty, 'missing') }), /Native host unavailable/);
});

test('refused sockets are removed only when they are real sockets', async t => {
  const dir = await mkdtemp('/tmp/tabrec-prof-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const live = net.createServer();
  const socketFile = join(dir, `${ID_DEAD}.sock`);
  await new Promise(resolve => live.listen(socketFile, resolve));
  t.after(() => live.close());
  await writeFile(join(dir, `${ID_GONE}.sock`), 'regular file');
  const { connect } = fakeHosts(dir, { [ID_DEAD]: { error: 'ECONNREFUSED' }, [ID_GONE]: { error: 'ECONNREFUSED' } });
  assert.deepEqual(await discoverHosts({ dir, connect }), []);
  await assert.rejects(lstat(socketFile), { code: 'ENOENT' });
  assert.equal(await readFile(join(dir, `${ID_GONE}.sock`), 'utf8'), 'regular file');
});
