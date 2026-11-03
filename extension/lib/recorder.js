export const MAX_CAPTURE_WIDTH = 3840;
const RELOAD_TIMEOUT_MS = 10_000;
const CAPTURE_KEY = 'capture';
const DEFAULT_TITLE = 'Tab Recorder';

export function toCaptureError(error) {
  if (error.message?.includes('chrome-extension://')) {
    return new Error('Another extension embeds a chrome-extension:// iframe in this tab, which blocks capture. Add its ID to config pauseExtensions to allow pausing it.');
  }
  return error;
}

export async function selectTab(chrome, selector) {
  const tabs = selector === 'active'
    ? await chrome.tabs.query({active: true, lastFocusedWindow: true})
    : (await chrome.tabs.query({})).filter(tab => /^\d+$/.test(selector)
      ? tab.id === Number(selector)
      : tab.url?.includes(selector));
  if (tabs.length !== 1) {
    throw new Error(`Tab selector matched ${tabs.length} tabs; use an exact tab ID`);
  }
  return tabs[0];
}

function reload(chrome, tabId) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve();
    };
    const listener = (id, change) => {
      if (id === tabId && change.status === 'complete') finish();
    };
    // Background pages can fail to report complete; reload already removed old iframes.
    const timer = setTimeout(() => finish(), RELOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId).catch(finish);
  });
}

export function createRecorder(chrome, send, {now = () => Date.now() / 1000, logger = console} = {}) {
  const targets = new Map();
  const refs = new Map();
  const warn = (...args) => (logger.warn ?? logger.error).call(logger, ...args);

  async function persist() {
    if (targets.size) await chrome.storage.session.set({capture: [...targets.values()].map(({tabId, generation, paused}) => ({tabId, generation, paused: [...paused]}))});
    else await chrome.storage.session.remove(CAPTURE_KEY);
  }

  async function release(ids = []) {
    for (const id of ids) {
      const count = refs.get(id);
      if (count > 1) refs.set(id, count - 1);
      else refs.delete(id);
    }
    const {paused = []} = await chrome.storage.local.get('paused');
    const remaining = [];
    const installed = new Set((await chrome.management.getAll()).map(e => e.id));
    for (const id of paused) {
      if (refs.has(id)) { remaining.push(id); continue; }
      if (!installed.has(id)) continue;
      try { await chrome.management.setEnabled(id, true); }
      catch { remaining.push(id); }
    }
    await chrome.storage.local.set({paused: remaining});
    if (remaining.some(id => !refs.has(id))) throw new Error('Could not restore extensions');
  }

  async function clearIndicator(tabId) {
    for (const clear of [
      () => chrome.action.setBadgeText({tabId, text: ''}),
      () => chrome.action.setTitle({tabId, title: DEFAULT_TITLE}),
    ]) {
      try { await clear(); }
      catch (error) { warn('Could not clear recording indicator', error); }
    }
  }

  async function cleanupTarget(current) {
    const target = {tabId: current.tabId};
    current.cleaning = true;
    try { await chrome.debugger.sendCommand(target, 'Page.stopScreencast'); }
    catch (error) { logger.error('Could not stop screencast during cleanup', error); }
    try { await chrome.debugger.detach(target); }
    catch (error) {
      logger.error('Could not detach debugger during cleanup', error);
      if (!/Debugger is not attached to the tab with id:|No tab with (?:given )?id:?/i.test(error.message)) {
        current.cleaning = false;
        throw error;
      }
    }
    targets.delete(current.tabId);
    await persist();
    let restoreFailed;
    try { await release(current.paused); }
    catch (error) { restoreFailed = error.message; warn('Extension restore failed', error); }
    await clearIndicator(current.tabId);
    return restoreFailed ? {restoreFailed} : {};
  }

  async function cleanup() {
    const saved = (await chrome.storage.session.get(CAPTURE_KEY))[CAPTURE_KEY];
    const {paused = []} = await chrome.storage.local.get('paused');
    for (const entry of (Array.isArray(saved) ? saved : saved ? [saved] : [])) {
      if (targets.has(entry.tabId)) continue;
      // Older records have no ownership information; retain all paused IDs
      // until every potentially dependent target has been detached.
      const current = {...entry, paused: [...new Set(entry.paused ?? paused)]};
      targets.set(entry.tabId, current);
      for (const id of current.paused) refs.set(id, (refs.get(id) ?? 0) + 1);
    }
    const errors = [];
    for (const current of [...targets.values()]) {
      try { await cleanupTarget(current); } catch (error) { errors.push(error); }
    }
    if (!targets.size) await release();
    if (errors.length) throw errors[0];
  }

  async function acquire(ids = [], current) {
    if (ids.includes(chrome.runtime.id)) throw new Error('Cannot pause Tab Recorder');
    const installed = new Map((await chrome.management.getAll()).map(e => [e.id, e]));
    for (const id of new Set(ids)) {
      if (refs.has(id)) {
        refs.set(id, refs.get(id) + 1);
        current.paused.push(id);
        continue;
      }
      const extension = installed.get(id);
      if (!extension?.enabled || extension.mayDisable === false) continue;
      const {paused = []} = await chrome.storage.local.get('paused');
      await chrome.storage.local.set({paused: [...new Set([...paused, id])]});
      refs.set(id, 1);
      current.paused.push(id);
      await chrome.management.setEnabled(id, false);
    }
  }

  async function startCapture(command) {
    const tab = await selectTab(chrome, command.tab);
    if (targets.has(tab.id)) throw new Error('Tab is already recording');
    if (targets.size >= 4) throw new Error('Maximum 4 sessions reached');
    if ([...targets.values()].some(t => t.generation === command.generation)) throw new Error('Duplicate generation');
    const current = {tabId: tab.id, generation: command.generation, paused: []};
    let attached = false;
    try {
      await release().catch(error => warn('Extension restore failed', error));
      await acquire(command.pauseExtensions, current);
      if (current.paused.length) await reload(chrome, tab.id);
      const target = {tabId: tab.id};
      await chrome.debugger.attach(target, '1.3');
      attached = true;
      targets.set(tab.id, current);
      await persist();
      await chrome.action.setBadgeBackgroundColor({tabId: tab.id, color: '#d93025'});
      await chrome.action.setBadgeText({tabId: tab.id, text: 'REC'});
      await chrome.action.setTitle({tabId: tab.id, title: `Recording: ${tab.title || tab.id}\nPaused extensions: ${current.paused.join(', ') || 'none'}`});
      await chrome.debugger.sendCommand(target, 'Page.startScreencast', {
        format: 'jpeg', quality: command.quality,
        maxWidth: Math.min(command.maxWidth, MAX_CAPTURE_WIDTH), everyNthFrame: 1,
      });
      return {tabId: tab.id};
    } catch (error) {
      try {
        if (attached) await cleanupTarget(current);
        else await release(current.paused);
      } catch (cleanupError) { logger.error('Capture cleanup failed', cleanupError); }
      throw toCaptureError(error);
    }
  }

  async function dispatch(command) {
    if (command.type === 'tabs') return (await chrome.tabs.query({})).map(({id, active, title, url}) => ({id, active, title, url}));
    if (command.type === 'start') return startCapture(command);
    if (command.type === 'stop') {
      const current = [...targets.values()].find(t => t.generation === command.generation);
      return current ? cleanupTarget(current) : {};
    }
    throw new Error('Unknown extension command');
  }

  function onFrame(source, method, params) {
    const current = targets.get(source.tabId);
    if (method !== 'Page.screencastFrame' || !current) return;
    send({type: 'frame', generation: current.generation, tabId: source.tabId, ack: params.sessionId,
      ts: params.metadata?.timestamp ?? now(), data: params.data});
  }

  async function acknowledge(command) {
    const current = [...targets.values()].find(t => t.generation === command.generation);
    if (current) await chrome.debugger.sendCommand({tabId: current.tabId}, 'Page.screencastFrameAck', {sessionId: command.ack}).catch(() => {});
  }

  function detached(source, stoppedAt = now(), enqueueCleanup = task => task()) {
    const current = targets.get(source.tabId);
    if (!current || current.cleaning || (source.generation !== undefined && source.generation !== current.generation)) return;
    targets.delete(source.tabId);
    send({type: 'detached', generation: current.generation, tabId: source.tabId, stoppedAt});
    return enqueueCleanup(async () => {
      await persist();
      try { await release(current.paused); }
      catch (error) { warn('Extension restore failed', error); }
      await clearIndicator(source.tabId);
    });
  }

  return {dispatch, cleanup, onFrame, acknowledge, detached, generationFor: tabId => targets.get(tabId)?.generation};
}
