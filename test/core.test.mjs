import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packet, decoder, concatList, parseArgs, loadConfig, authorizePause, validateRequest } from '../lib/core.mjs';

test('native framing accepts split headers, Unicode and coalesced messages', () => {
  const got = [], decode = decoder(value => got.push(value));
  const input = Buffer.concat([packet({ text: '録画' }), packet({ id: 2 })]);
  for (const byte of input) decode(Buffer.from([byte]));
  assert.deepEqual(got, [{ text: '録画' }, { id: 2 }]);
});

test('native decoder boundary discards oversize frames and resumes without losing ack', () => {
  const frames = [], dropped = [];
  const frame = { type: 'frame', generation: 'g', ack: 42, data: 'x'.repeat(100) };
  const bodyLength = packet(frame).length - 4;
  decoder(value => frames.push(value), bodyLength)(packet(frame));
  assert.equal(frames.length, 1);
  const decode = decoder(value => frames.push(value), bodyLength - 1, value => dropped.push(value));
  const bytes = Buffer.concat([packet(frame), packet({ id: 2 })]);
  for (const byte of bytes) decode(Buffer.from([byte]));
  assert.deepEqual(dropped, [{ type: 'frame', generation: 'g', ack: 42 }]);
  assert.deepEqual(frames.at(-1), { id: 2 });
  assert.throws(() => decoder(() => {})(Buffer.alloc(4)));
  assert.throws(() => decoder(() => {})(Buffer.from([1, 0, 0, 0, 123])));
});

test('concat full text sorts, deduplicates, quotes paths and retains final duration', () => {
  assert.equal(concatList([
    { file: 'frames/2.jpg', ts: 2 }, { file: 'frames/1.jpg', ts: 1 }, { file: 'frames/3.jpg', ts: 2 },
  ], "/tmp/tabrec3-'dir", 4),
  "ffconcat version 1.0\nfile '/tmp/tabrec3-'\\''dir/frames/1.jpg'\noption framerate 1000\nduration 1\nfile '/tmp/tabrec3-'\\''dir/frames/2.jpg'\noption framerate 1000\nduration 2\nfile '/tmp/tabrec3-'\\''dir/frames/2.jpg'\noption framerate 1000\n");
  assert.throws(() => concatList([], '/tmp'));
  assert.throws(() => concatList([{ file: '../x', ts: 1 }], '/tmp'));
  assert.throws(() => concatList([{ file: 'frames/1.jpg', ts: 1 }], '/tmp/a\nb'));
});

test('CLI resolves paths and parses ffmpeg and numeric bounds', () => {
  const parsed = parseArgs(['record', '--tab', 'active', '--duration', '0.5', '--quality', '0', '--out', 'frames', '-o', 'out.mp4', '--ffmpeg', './ffmpeg']);
  assert.equal(parsed.options.duration, 0.5);
  assert.equal(parsed.options.quality, 0);
  assert.equal(parsed.options.out, resolve('frames'));
  assert.equal(parsed.options.output, resolve('out.mp4'));
  assert.equal(parsed.options.ffmpeg, resolve('./ffmpeg'));
  assert.equal(parseArgs(['encode', 'frames']).options.directory, resolve('frames'));
  assert.equal(parseArgs(['start', '--tab', 'active', '--max-width', '3840']).options.maxWidth, 3840);
  for (const args of [['start'], ['record', '--tab', 'active'], ['start', '--tab', '1', '--max-width', '3841'], ['install', '--browser', 'safari']]) assert.throws(() => parseArgs(args));
  for (const flag of ['--out', '-o', '--ffmpeg', '--quality', '--duration', '--max-duration', '--pause-extension']) assert.throws(() => parseArgs(['tabs', flag]));
});

test('host validator rejects invalid wire values and control paths', () => {
  for (const options of [{ out: 'relative' }, { out: '/tmp/a\nb' }, { quality: '80' }, { pauseExtensions: 'x' }, { generation: 'injected' }, { tab: 2 }]) {
    assert.throws(() => validateRequest({ command: 'tabs', options }));
  }
});

test('config is an allowlist and defaults to all configured IDs', () => {
  const id = 'a'.repeat(32), other = 'b'.repeat(32);
  assert.throws(() => authorizePause({ pauseExtensions: [other] }, { pauseExtensions: [id] }), /pauseExtensions/);
  assert.deepEqual(authorizePause({ pauseExtensions: [] }, { pauseExtensions: [id] }).pauseExtensions, [id]);
});

test('configuration handles missing, valid, malformed and invalid schema', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabrec3-config-'));
  const path = join(dir, 'config.json');
  try {
    assert.deepEqual(await loadConfig(path), { pauseExtensions: [] });
    await writeFile(path, JSON.stringify({ pauseExtensions: ['a'.repeat(32)] }));
    assert.equal((await loadConfig(path)).pauseExtensions.length, 1);
    for (const text of ['{', 'null', '{"pauseExtensions":"x"}', '{"pauseExtensions":["invalid"]}']) {
      await writeFile(path, text);
      await assert.rejects(loadConfig(path));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('oversized frame envelope is recovered when ack follows a large data field', () => {
  const dropped = [], received = [];
  const frame = { type: 'frame', data: 'x'.repeat(200000), generation: 'current', ack: 9 };
  const decode = decoder(value => received.push(value), 1000, value => dropped.push(value));
  const bytes = Buffer.concat([packet(frame), packet({ ok: true })]);
  for (let offset = 0; offset < bytes.length; offset += 4096) decode(bytes.subarray(offset, offset + 4096));
  assert.deepEqual(dropped, [{ type: 'frame', generation: 'current', ack: 9 }]);
  assert.deepEqual(received, [{ ok: true }]);
});
