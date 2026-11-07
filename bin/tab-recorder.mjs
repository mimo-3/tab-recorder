#!/usr/bin/env node
import net from 'node:net';
import { mkdir, writeFile, unlink, access, realpath, stat, readdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, loadConfig, authorizePause, appDir, hostsDir, hostName, quote, INSTANCE_ID_PATTERN, SOCKET_NAME_PATTERN } from '../lib/core.mjs';
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

export function request(command, options, path, connect = net.createConnection) {
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
    socket.on('error', error => fail(Object.assign(new Error(`Native host unavailable: ${error.message}. Load the extension and run tab-recorder install.`), { code: error.code })));
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

const UNAVAILABLE = 'Native host unavailable: no browser profile is connected. Open Aside or Chrome with the extension loaded and run tab-recorder install.';

// Ask every per-profile socket for its status. Dead sockets are skipped.
export async function discoverHosts({ dir = hostsDir, connect } = {}) {
  let names;
  try { names = await readdir(dir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const sockets = names.map(name => SOCKET_NAME_PATTERN.exec(name)?.[1])
    .filter(id => id && INSTANCE_ID_PATTERN.test(id)).sort();
  const found = await Promise.all(sockets.map(async id => {
    const path = join(dir, `${id}.sock`);
    try {
      const { host, sessions } = await request('status', {}, path, connect);
      return { path, host: { ...host, instanceId: id }, sessions };
    } catch (error) {
      if (error.code === 'ECONNREFUSED') await removeStaleSocket(path);
      if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) return undefined;
      throw error;
    }
  }));
  return found.filter(Boolean);
}

async function removeStaleSocket(path) {
  try {
    const info = await lstat(path);
    if (info.isSocket() && info.uid === process.getuid()) await unlink(path);
  } catch (error) { ignoreMissing(error); }
}

export function matchesProfile(host, value) {
  return host.profileName === value || host.profileDir === value || host.instanceId.startsWith(value.toLowerCase());
}

function describe(hosts) {
  return hosts.map(({ host }) => `${host.browser ?? 'unknown'}/${host.profileDir ?? '?'} "${host.profileName ?? '?'}" ${host.instanceId}`).join(', ');
}

function filterHosts(hosts, profile) {
  if (!hosts.length) throw new Error(UNAVAILABLE);
  if (!profile) return hosts;
  const matched = hosts.filter(entry => matchesProfile(entry.host, profile));
  if (!matched.length) throw new Error(`No connected profile matches --profile ${profile}. Connected: ${describe(hosts)}`);
  return matched;
}

function single(hosts, reason) {
  if (hosts.length === 1) return hosts[0];
  throw new Error(`${reason} matches ${hosts.length} browser profiles; pass --profile <name|dir|instanceId>. Connected: ${describe(hosts)}`);
}

async function selectStartHost(hosts, options, connect) {
  if (hosts.length === 1 || options.profile) return single(hosts, `--profile ${options.profile}`);
  if (!/^\d+$/.test(options.tab)) return single(hosts, `--tab ${options.tab}`);
  const owners = [];
  for (const entry of hosts) {
    const { tabs } = await request('tabs', {}, entry.path, connect);
    if (tabs.some(tab => tab.id === Number(options.tab))) owners.push(entry);
  }
  if (!owners.length) throw new Error(`Tab ${options.tab} was not found in any connected profile`);
  return single(owners, `--tab ${options.tab}`);
}

function selectSessionHost(hosts, options) {
  if (options.session) {
    const owner = hosts.find(entry => entry.sessions.some(s => s.id === options.session));
    if (!owner) throw new Error('Session ID does not match');
    return owner;
  }
  if (hosts.length === 1) return hosts[0];
  const all = hosts.flatMap(entry => entry.sessions.map(s => ({ ...s, profile: entry.host })));
  if (!all.length) throw new Error('No active session');
  if (all.length > 1) throw new Error(`--session is required: ${JSON.stringify(all)}`);
  return hosts.find(entry => entry.sessions.length);
}

export async function main(argv, { dir = hostsDir, connect, config = loadConfig } = {}) {
  const { command, options: parsed } = parseArgs(argv);
  if (['install', 'uninstall'].includes(command)) return install(command, parsed);
  if (command === 'encode') {
    const path = await encodeRecording(parsed.directory, { output: parsed.output, ffmpeg: parsed.ffmpeg });
    return { path };
  }
  const { profile, ...options } = parsed;
  const hosts = filterHosts(await discoverHosts({ dir, connect }), profile);
  if (command === 'status') return hosts.flatMap(entry => entry.sessions.map(s => ({ ...s, profile: entry.host })));
  if (command === 'tabs') {
    const lists = await Promise.all(hosts.map(entry => request('tabs', options, entry.path, connect)));
    return lists.flatMap(({ host, tabs }, index) => tabs.map(tab => ({ ...tab, profile: { ...host, instanceId: hosts[index].host.instanceId } })));
  }
  if (['start', 'record'].includes(command)) {
    const target = await selectStartHost(hosts, { ...options, profile }, connect);
    return request(command, authorizePause(options, await config()), target.path, connect);
  }
  return request(command, options, selectSessionHost(hosts, options).path, connect);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
