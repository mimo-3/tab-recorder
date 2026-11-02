import net from 'node:net';
import * as defaultFs from 'node:fs/promises';
import {spawn as defaultSpawn} from 'node:child_process';
import {dirname, join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {socketPath as defaultSocketPath, validateRequest, loadConfig, authorizePause} from './core.mjs';
import {encodeRecording} from './encode.mjs';

const RPC_TIMEOUT_MS = 30_000;
const CLIENT_IDLE_MS = 120_000;
const REQUEST_LIMIT = 65_536;

export function createHost({
  send,
  spawn = defaultSpawn,
  fs = defaultFs,
  socketPath = defaultSocketPath,
  now = () => Date.now() / 1000,
  config = loadConfig,
  log = console.error,
} = {}) {
  const sessions = new Map();
  let serial = Promise.resolve();
  let server;
  const pending = new Map();

  function rpc(type, args = {}) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Extension command timed out'));
      }, RPC_TIMEOUT_MS);
      pending.set(id, {resolve, reject, timer});
      try {
        send({...args, type, id});
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function ack(value) {
    send({type: 'ack', generation: value.generation, ack: value.ack});
  }

  function receiveOversize(value) {
    if (value?.type === 'frame') ack(value);
  }

  async function stopCapture(s) {
    clearTimeout(s.timer);
    if (s.captureStop) return s.captureStop;
    s.stoppedAt ??= now();
    s.captureStop = rpc('stop', {generation: s.id}).catch(error => {
      log(error.message);
      // Keep the original frame failure when cleanup also fails.
      if (!s.fatal) throw error;
    });
    return s.captureStop;
  }

  async function writeFrame(s, value) {
    if (s.fatal) return;
    const file = `frames/${s.count + 1}.jpg`;
    const ts = Number.isFinite(value.ts) ? value.ts : now();
    await fs.writeFile(join(s.dir, file), Buffer.from(value.data, 'base64'), {flag: 'wx'});
    await fs.appendFile(join(s.dir, 'frames.jsonl'), JSON.stringify({file, ts}) + '\n');
    s.count++;
    ack(value);
  }

  function receive(value) {
    if (value.type === 'result') {
      const request = pending.get(value.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(value.id);
      if (value.ok) request.resolve(value.data);
      else request.reject(new Error(value.error));
    } else {
      const current = sessions.get(value.generation);
      if (!current) return;
      if (value.type === 'detached') {
        current.detached = true;
        current.stoppedAt ??= now();
      } else if (value.type === 'frame') {
        const frame = {...value, ts: Number.isFinite(value.ts) ? value.ts : now()};
        current.writes = current.writes.then(() => writeFrame(current, frame)).catch(error => {
          current.fatal ??= error;
          log(error.message);
          void stopCapture(current).catch(error => log(error.message));
        });
      }
    }
  }

  function discardState(s) {
    clearTimeout(s.timer);
    sessions.delete(s.id);
  }

  async function start(options) {
    if (sessions.size >= 4) throw new Error('Maximum 4 sessions reached');
    const authorized = authorizePause(options, await config());
    const tabs = await rpc('tabs');
    const matches = tabs.filter(tab => authorized.tab === 'active' ? tab.active :
      /^\d+$/.test(authorized.tab) ? tab.id === Number(authorized.tab) : tab.url?.includes(authorized.tab));
    if (matches.length !== 1) throw new Error(`Tab selector matched ${matches.length} tabs; use an exact tab ID`);
    const tabId = matches[0].id;
    if ([...sessions.values()].some(s => s.tabId === tabId)) throw new Error('Tab is already recording');
    const id = randomUUID();
    const dir = authorized.out ?? join(homedir(), 'Movies/tab-recorder', id);
    await fs.mkdir(dirname(dir), {recursive: true, mode: 0o700});
    // Never accept an existing recording directory, including an empty one.
    await fs.mkdir(dir, {mode: 0o700});
    const s = {id, dir, count: 0, tabId, writes: Promise.resolve()};
    s.finished = new Promise(resolve => { s.finish = resolve; });
    sessions.set(id, s);
    try {
      await fs.mkdir(join(dir, 'frames'), {mode: 0o700});
      await fs.writeFile(join(dir, 'frames.jsonl'), '', {flag: 'wx'});
      const result = await rpc('start', {
        tab: String(tabId),
        quality: authorized.quality ?? 80,
        maxWidth: authorized.maxWidth ?? 1280,
        pauseExtensions: authorized.pauseExtensions,
        generation: id,
      });
      s.tabId = result.tabId;
      if (authorized.maxDuration) {
        s.timer = setTimeout(() => {
          void enqueue(() => stop({session: id, output: authorized.output})).catch(error => log(error.message));
        }, authorized.maxDuration * 1000);
      }
      return {session: id, directory: dir, ...result};
    } catch (error) {
      await rpc('stop', {generation: s.id}).catch(cleanupError => log(cleanupError.message));
      await s.writes;
      discardState(s);
      await fs.rm(dir, {recursive: true, force: true}).catch(cleanupError => log(cleanupError.message));
      throw error;
    }
  }

  function complete(s, outcome) {
    if (!s.outcome) {
      s.outcome = outcome;
      s.finish();
    }
  }

  function completedResult(s) {
    if (s.outcome.error) throw s.outcome.error;
    return s.outcome.data;
  }

  async function finishStop(s, options) {
    let cleanupError;
    try {
      await stopCapture(s);
    } catch (error) {
      cleanupError = error;
    }
    await s.writes;
    if (s.fatal || s.count === 0 || cleanupError) {
      discardState(s);
      const reason = s.fatal ? `Frame write failed: ${s.fatal.message}` :
        cleanupError ? cleanupError.message : 'No frames received';
      throw new Error(`${reason}; frames retained at ${s.dir}`);
    }
    let path;
    try {
      path = await encodeRecording(s.dir, {
        output: options.output,
        stoppedAt: s.stoppedAt,
        spawn,
        fs,
      });
    } catch (error) {
      if (!error.ffmpegFailure) discardState(s);
      throw new Error(`${error.message}; frames retained at ${s.dir}` +
        (error.ffmpegFailure ? '; retry stop with a different -o or discard' : ''));
    }
    discardState(s);
    return {path, directory: s.dir};
  }

  async function stop(options = {}) {
    const s = selectSession(options);
    try {
      const data = await finishStop(s, options);
      complete(s, {data});
      return data;
    } catch (error) {
      complete(s, {error});
      throw error;
    }
  }

  async function discard(options) {
    const s = selectSession(options);
    try {
      await stopCapture(s);
      await s.writes;
      const data = {directory: s.dir, discarded: true, message: 'Frames retained'};
      complete(s, {data});
      return data;
    } catch (error) {
      complete(s, {error});
      throw error;
    } finally {
      discardState(s);
    }
  }

  function enqueue(task) {
    const result = serial.then(task);
    serial = result.catch(() => {});
    return result;
  }

  function selectSession(options = {}) {
    if (options.session) {
      const s = sessions.get(options.session);
      if (!s) throw new Error('Session ID does not match');
      return s;
    }
    if (!sessions.size) throw new Error('No active session');
    if (sessions.size > 1) throw new Error(`--session is required: ${JSON.stringify(status())}`);
    return sessions.values().next().value;
  }

  function status() {
    return [...sessions.values()].map(s => ({
      id: s.id, tabId: s.tabId, directory: s.dir, frames: s.count,
      stopped: s.stoppedAt !== undefined, detached: !!s.detached, error: s.fatal?.message,
    }));
  }

  function command(request) {
    const {command: name, options} = validateRequest(request);
    if (name === 'status') return Promise.resolve(status());
    if (name === 'tabs') return enqueue(() => rpc('tabs'));
    if (name === 'start') return enqueue(() => start(options));
    if (name === 'stop') return enqueue(() => stop(options));
    if (name === 'discard') return enqueue(() => discard(options));
    throw new Error('Unsupported host command');
  }

  async function record(options, socket) {
    let disconnected = !!socket?.destroyed;
    let finish;
    const ended = new Promise(resolve => { finish = resolve; });
    const disconnectedListener = () => { disconnected = true; finish(); };
    socket?.once('close', disconnectedListener);
    let timer;
    try {
      const s = await enqueue(async () => {
        const result = await start(options);
        return sessions.get(result.session);
      });
      if (!disconnected) timer = setTimeout(finish, options.duration * 1000);
      else finish();
      await Promise.race([ended, s.finished]);
      return await enqueue(() => {
        // A manual stop/discard may be ahead of this task in the command queue.
        if (s.outcome) return completedResult(s);
        return stop({session: s.id, output: options.output});
      });
    } finally {
      clearTimeout(timer);
      socket?.removeListener('close', disconnectedListener);
    }
  }

  function handleClient(socket) {
    let buffer = '';
    let received = false;
    socket.setEncoding('utf8');
    socket.setTimeout(CLIENT_IDLE_MS, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (received) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > REQUEST_LIMIT) return socket.destroy();
      if (!buffer.includes('\n')) return;
      received = true;
      socket.setTimeout(0);
      const respond = value => {
        if (!socket.destroyed) socket.end(JSON.stringify(value) + '\n');
      };
      let request;
      try {
        request = validateRequest(JSON.parse(buffer.split('\n')[0]));
      } catch (error) {
        respond({ok: false, error: error.message});
        return;
      }
      const result = Promise.resolve().then(() => request.command === 'record' ?
        record(request.options, socket) : command(request));
      Promise.resolve(result).then(
        data => respond({ok: true, data}),
        error => respond({ok: false, error: error.message}),
      );
    });
  }

  async function listen() {
    const directory = dirname(socketPath);
    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    await fs.chmod(directory, 0o700);
    try {
      const stat = await fs.lstat(socketPath);
      if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error('Unsafe existing socket');
      const live = await new Promise(resolve => {
        const probe = net.createConnection(socketPath);
        probe.once('connect', () => { probe.destroy(); resolve(true); });
        probe.once('error', error => resolve(!['ECONNREFUSED', 'ENOENT'].includes(error.code)));
      });
      if (live) throw new Error('Another browser/native host owns the socket');
      await fs.unlink(socketPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    server = net.createServer(handleClient);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await fs.chmod(socketPath, 0o600);
    return server;
  }

  async function close() {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Native host disconnected'));
    }
    pending.clear();
    for (const s of sessions.values()) clearTimeout(s.timer);
    if (server) {
      server.close();
      await fs.unlink(socketPath).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  return {command, receive, receiveOversize, handleClient, listen, close, drain: () => Promise.all([...sessions.values()].map(s => s.writes))};
}
