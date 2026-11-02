import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { findFfmpeg, request, main } from '../bin/tab-recorder.mjs';

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tabrec3-cli-'));
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
