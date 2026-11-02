#!/usr/bin/env node
import net from 'node:net';
import { mkdir, writeFile, unlink, access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, loadConfig, authorizePause, appDir, socketPath, hostName, quote } from '../lib/core.mjs';
import { extensionId } from '../lib/extension-id.mjs';
import { encodeRecording } from '../lib/encode.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browsers = { aside: 'Aside', chrome: 'Google/Chrome' };
const REQUEST_TIMEOUT_MS = 120000;
const RESPONSE_LIMIT = 1024 * 1024;

export async function findFfmpeg(explicit, searchPath = process.env.PATH ?? '') {
  const candidates = explicit ? [resolve(explicit)] : searchPath.split(':').filter(isAbsolute).map(dir => join(dir, 'ffmpeg'));
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate);
      await access(path, constants.X_OK);
      if (!(await stat(path)).isFile()) throw new Error(`Not a file: ${path}`);
      return path;
    } catch (error) {
      if (explicit) throw error;
    }
  }
  throw new Error('ffmpeg not found in absolute PATH entries. Install it or pass --ffmpeg <path>.');
}

async function install(command, options) {
  const launcher = join(appDir, 'native-host.sh');
  const selected = options.browser && options.browser !== 'all' ? [options.browser] : Object.keys(browsers);
  let ffmpeg;
  if (command === 'install') {
    ffmpeg = await findFfmpeg(options.ffmpeg);
    await mkdir(appDir, { recursive: true, mode: 0o700 });
    // Pin executable paths because browsers supply a minimal PATH.
    await writeFile(launcher, `#!/bin/sh\nTAB_RECORDER_FFMPEG=${quote(ffmpeg)} exec ${quote(process.execPath)} ${quote(join(root, 'lib/host-main.mjs'))}\n`, { mode: 0o700 });
  }
  for (const browser of selected) {
    const dir = join(homedir(), 'Library/Application Support', browsers[browser], 'NativeMessagingHosts');
    const path = join(dir, hostName + '.json');
    if (command === 'install') {
      await mkdir(dir, { recursive: true });
      const manifest = {
        name: hostName,
        description: 'Tab Recorder native host',
        path: launcher,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${extensionId}/`],
      };
      await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    } else await unlink(path).catch(ignoreMissing);
  }
  if (command === 'uninstall') await unlink(launcher).catch(ignoreMissing);
  return { command, browsers: selected, extensionId, ...(ffmpeg ? { ffmpeg } : {}) };
}

function ignoreMissing(error) {
  if (error.code !== 'ENOENT') throw error;
}

export function request(command, options, path = socketPath, connect = net.createConnection) {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.setEncoding('utf8');
    let buffer = '', done = false;
    const fail = error => {
      if (done) return;
      done = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(['stop', 'record'].includes(command) ? 0 : REQUEST_TIMEOUT_MS, () => fail(new Error('Native host timed out')));
    socket.on('connect', () => socket.write(JSON.stringify({ command, options }) + '\n'));
    socket.on('error', error => fail(new Error(`Native host unavailable: ${error.message}. Load the extension and run tab-recorder install.`)));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > RESPONSE_LIMIT) return fail(new Error('Response too large'));
      if (!buffer.includes('\n')) return;
      try {
        const value = JSON.parse(buffer.split('\n')[0]);
        done = true;
        socket.end();
        if (value.ok) resolve(value.data);
        else reject(new Error(value.error));
      } catch (error) { fail(error); }
    });
    socket.on('end', () => { if (!done) fail(new Error('Native host disconnected')); });
  });
}

export async function main(argv) {
  const { command, options: parsed } = parseArgs(argv);
  let options = parsed;
  if (['install', 'uninstall'].includes(command)) return install(command, options);
  if (command === 'encode') {
    const path = await encodeRecording(options.directory, { output: options.output, ffmpeg: options.ffmpeg });
    return { path };
  }
  if (['start', 'record'].includes(command)) options = authorizePause(options, await loadConfig());
  return request(command, options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
