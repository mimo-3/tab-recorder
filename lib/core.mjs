import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

export const appDir = join(homedir(), 'Library/Application Support/tab-recorder');
export const hostsDir = join(appDir, 'hosts');
// Instance IDs become socket file names, so accept only lowercase RFC 4122 UUIDs.
export const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SOCKET_NAME_PATTERN = /^([0-9a-f-]{36})\.sock$/;
export function hostSocketPath(instanceId, dir = hostsDir) {
  if (typeof instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(instanceId)) throw new Error('Invalid instance ID');
  return join(dir, `${instanceId}.sock`);
}
// Keep in sync with extension/background.js (Chrome cannot import outside extension/).
export const hostName = 'com.mimo3.tab_recorder';
export const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
export const CONTROL_CHARACTERS = /[\0-\x1f]/;
export const NATIVE_LIMIT = 16 * 1024 * 1024;
const ENVELOPE_WINDOW_BYTES = 64 * 1024;
export const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function assertPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || CONTROL_CHARACTERS.test(path)) {
    throw new Error('Path must be absolute and contain no control characters');
  }
  return path;
}

export function packet(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > 1024 * 1024) throw new Error('Native output exceeds 1 MiB');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

// Consume each byte once. Only assemble a body after all its chunks have arrived.
export function decoder(receive, limit = NATIVE_LIMIT, onOversize = () => {}) {
  let header = Buffer.alloc(4), headerBytes = 0, remaining = 0;
  let chunks = [], oversized = false, oversizedPrefix = '', oversizedSuffix = '';
  return chunk => {
    let offset = 0;
    while (offset < chunk.length) {
      if (!remaining) {
        const length = Math.min(4 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + length);
        headerBytes += length;
        offset += length;
        if (headerBytes < 4) continue;
        remaining = header.readUInt32LE();
        headerBytes = 0;
        if (!remaining) throw new Error('Invalid native message length');
        oversized = remaining > limit;
        oversizedPrefix = '';
        oversizedSuffix = '';
      }
      const length = Math.min(remaining, chunk.length - offset);
      if (!oversized && length) chunks.push(chunk.subarray(offset, offset + length));
      if (oversized && length) {
        const part = chunk.subarray(offset, offset + length);
        if (oversizedPrefix.length < ENVELOPE_WINDOW_BYTES) oversizedPrefix += part.subarray(0, ENVELOPE_WINDOW_BYTES - oversizedPrefix.length).toString();
        oversizedSuffix = (oversizedSuffix + part.subarray(Math.max(0, part.length - ENVELOPE_WINDOW_BYTES)).toString()).slice(-ENVELOPE_WINDOW_BYTES);
      }
      remaining -= length;
      offset += length;
      if (!remaining) {
        if (oversized) {
          // Frame data is discarded; recover only the small envelope for flow-control ack.
          const envelope = oversizedPrefix + oversizedSuffix;
          const value = {};
          for (const key of ['type', 'generation', 'ack']) {
            const match = envelope.match(new RegExp('"' + key + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|[0-9]+)'));
            if (match) { try { value[key] = JSON.parse(match[1]); } catch {} }
          }
          onOversize(value);
        }
        else receive(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        chunks = [];
      }
    }
  };
}

const flags = {
  '--tab': 'tab', '--max-width': 'maxWidth', '--quality': 'quality',
  '--out': 'out', '--session': 'session', '--duration': 'duration', '-o': 'output',
  '--browser': 'browser', '--pause-extension': 'pauseExtensions', '--ffmpeg': 'ffmpeg',
  '--max-duration': 'maxDuration', '--profile': 'profile',
};
const commands = ['install', 'uninstall', 'tabs', 'start', 'stop', 'record', 'status', 'discard', 'encode'];
const optionNames = new Set([...Object.values(flags), 'directory']);

export function validateRequest(request) {
  if (!request || !commands.includes(request.command) || !request.options ||
      typeof request.options !== 'object' || Array.isArray(request.options)) throw new Error('Invalid request');
  const { command, options } = request;
  for (const key of Object.keys(options)) {
    if (!optionNames.has(key)) throw new Error(`Invalid option: ${key}`);
  }
  for (const [key, low, high] of [['maxWidth', 2, 3840], ['quality', 0, 100], ['duration', 0.001, 86400], ['maxDuration', 0.001, 86400]]) {
    const value = options[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high ||
        (['maxWidth', 'quality'].includes(key) && !Number.isInteger(value)))) throw new Error(`Invalid ${key}`);
  }
  for (const key of ['tab', 'session', 'browser', 'profile']) {
    if (options[key] !== undefined && (typeof options[key] !== 'string' || !options[key] || CONTROL_CHARACTERS.test(options[key]))) throw new Error(`Invalid ${key}`);
  }
  for (const key of ['out', 'output', 'ffmpeg', 'directory']) {
    if (options[key] !== undefined) assertPath(options[key]);
  }
  if (['start', 'record'].includes(command) && !options.tab) throw new Error('--tab is required');
  if (command === 'record' && !options.duration) throw new Error('--duration is required');
  if (command === 'encode' && !options.directory) throw new Error('encode requires a directory');
  if (options.browser && !['aside', 'chrome', 'all'].includes(options.browser)) throw new Error('Invalid browser');
  if (options.pauseExtensions !== undefined && (
    !Array.isArray(options.pauseExtensions) ||
    options.pauseExtensions.some(id => typeof id !== 'string' || !EXTENSION_ID_PATTERN.test(id))
  )) {
    throw new Error('Invalid extension ID');
  }
  return request;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { pauseExtensions: [] };
  if (command === 'encode' && rest[0] && !rest[0].startsWith('-')) options.directory = resolve(rest.shift());
  for (let i = 0; i < rest.length; i++) {
    const key = flags[rest[i]];
    if (!key || !rest[i + 1] || rest[i + 1].startsWith('-')) throw new Error(`Invalid option: ${rest[i]}`);
    let value = rest[++i];
    if (['maxWidth', 'quality', 'duration', 'maxDuration'].includes(key)) value = Number(value);
    if (['out', 'output', 'ffmpeg'].includes(key)) value = resolve(value);
    if (key === 'pauseExtensions') options[key].push(value);
    else options[key] = value;
  }
  return validateRequest({ command, options });
}

export async function loadConfig(path = join(homedir(), '.config/tab-recorder/config.json')) {
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { pauseExtensions: [] }; throw error; }
  if (!config || typeof config !== 'object' || Array.isArray(config) || !Array.isArray(config.pauseExtensions ?? []) ||
      (config.pauseExtensions ?? []).some(id => typeof id !== 'string' || !EXTENSION_ID_PATTERN.test(id))) throw new Error('Invalid pauseExtensions configuration');
  return { pauseExtensions: config.pauseExtensions ?? [] };
}

export function authorizePause(options, config) {
  const allowed = config.pauseExtensions ?? [];
  for (const id of options.pauseExtensions ?? []) {
    if (!allowed.includes(id)) throw new Error(`Extension ${id} is not allowed to be paused. Add it to pauseExtensions in ~/.config/tab-recorder/config.json.`);
  }
  return { ...options, pauseExtensions: [...new Set(allowed)] };
}

export function concatList(frames, dir, endTimestamp) {
  assertPath(dir);
  if (endTimestamp !== undefined && !Number.isFinite(endTimestamp)) throw new Error('Invalid end timestamp');
  if (frames.some(frame => !Number.isFinite(frame.ts) || !/^frames\/\d+\.jpg$/.test(frame.file))) throw new Error('Invalid frame metadata');
  const sorted = [...frames].sort((a, b) => a.ts - b.ts).filter((frame, index, all) => !index || frame.ts !== all[index - 1].ts);
  if (!sorted.length) throw new Error('No frames received; frames retained');
  const lines = ['ffconcat version 1.0'];
  sorted.forEach((frame, index) => {
    lines.push(`file ${quote(resolve(dir, frame.file))}`, 'option framerate 1000');
    const duration = index + 1 < sorted.length ? sorted[index + 1].ts - frame.ts : Math.max(0.001, (endTimestamp ?? frame.ts + 0.04) - frame.ts);
    lines.push(`duration ${duration}`);
  });
  lines.push(`file ${quote(resolve(dir, sorted.at(-1).file))}`, 'option framerate 1000');
  return lines.join('\n') + '\n';
}
