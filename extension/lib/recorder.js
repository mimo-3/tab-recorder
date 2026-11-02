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

export async function restoreExtensions(chrome) {
  const {paused = []} = await chrome.storage.local.get('paused');
  const installed = new Set((await chrome.management.getAll()).map(extension => extension.id));
  const remaining = [];
  for (const id of paused) {
    if (!installed.has(id)) continue;
    try {
      await chrome.management.setEnabled(id, true);
    } catch {
      remaining.push(id);
    }
  }
  await chrome.storage.local.set({paused: remaining});
  if (remaining.length) {
    throw new Error(`Could not restore extensions: ${remaining.join(', ')}`);
  }
}

export async function pauseExtensions(chrome, ids = []) {
  if (ids.includes(chrome.runtime.id)) throw new Error('Cannot pause Tab Recorder');
  const installed = new Map((await chrome.management.getAll()).map(extension => [extension.id, extension]));
  const paused = [];
  for (const id of new Set(ids)) {
    const extension = installed.get(id);
    if (!extension?.enabled || extension.mayDisable === false) continue;
    paused.push(id);
    // Persist intent before disabling so a worker restart can restore it.
    await chrome.storage.local.set({paused: [...paused]});
    await chrome.management.setEnabled(id, false);
  }
  return paused;
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
  let target;
  let generation;

  async function clearIndicator() {
    await chrome.action.setBadgeText({text: ''});
    await chrome.action.setTitle({title: DEFAULT_TITLE});
  }

  async function cleanup() {
    const saved = (await chrome.storage.session.get(CAPTURE_KEY))[CAPTURE_KEY];
    const current = target || (saved && {tabId: saved.tabId});
    let detachError;
    if (current) {
      try {
        await chrome.debugger.sendCommand(current, 'Page.stopScreencast');
      } catch (error) {
        logger.error('Could not stop screencast during cleanup', error);
      }
      try {
        await chrome.debugger.detach(current);
      } catch (error) {
        logger.error('Could not detach debugger during cleanup', error);
        // Chrome reports these when the tab closed or the debugger already detached.
        const alreadyDetached = /Debugger is not attached to the tab with id:|No tab with (?:given )?id:?/i.test(error.message);
        if (!alreadyDetached) detachError = error;
      }
    }
    try {
      if (!detachError) {
        target = undefined;
        generation = undefined;
        await chrome.storage.session.remove(CAPTURE_KEY);
      }
    } finally {
      try {
        await restoreExtensions(chrome);
      } finally {
        // Keep REC and the persisted capture as recovery evidence if detach failed.
        if (!detachError) await clearIndicator();
      }
    }
    if (detachError) throw detachError;
  }

  async function startCapture(command) {
    if (target) throw new Error('Already recording');
    await restoreExtensions(chrome);
    const tab = await selectTab(chrome, command.tab);
    try {
      const paused = await pauseExtensions(chrome, command.pauseExtensions);
      if (paused.length) await reload(chrome, tab.id);
      const next = {tabId: tab.id};
      await chrome.debugger.attach(next, '1.3');
      target = next;
      generation = command.generation;
      await chrome.storage.session.set({capture: {tabId: tab.id, generation}});
      await chrome.action.setBadgeBackgroundColor({color: '#d93025'});
      await chrome.action.setBadgeText({text: 'REC'});
      await chrome.action.setTitle({title: `Recording: ${tab.title || tab.id}\nPaused extensions: ${paused.join(', ') || 'none'}`});
      await chrome.debugger.sendCommand(next, 'Page.startScreencast', {
        format: 'jpeg',
        quality: command.quality,
        maxWidth: Math.min(command.maxWidth, MAX_CAPTURE_WIDTH),
        everyNthFrame: 1,
      });
      return {tabId: tab.id};
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        logger.error('Capture cleanup failed', cleanupError);
      }
      throw toCaptureError(error);
    }
  }

  async function dispatch(command) {
    if (command.type === 'tabs') {
      return (await chrome.tabs.query({})).map(({id, active, title, url}) => ({id, active, title, url}));
    }
    if (command.type === 'stop') {
      await cleanup();
      return {};
    }
    if (command.type === 'start') return startCapture(command);
    throw new Error('Unknown extension command');
  }

  function onFrame(source, method, params) {
    if (method !== 'Page.screencastFrame' || source.tabId !== target?.tabId) return;
    send({
      type: 'frame', generation, tabId: source.tabId, ack: params.sessionId,
      ts: params.metadata?.timestamp ?? now(), data: params.data,
    });
  }

  async function acknowledge(command) {
    if (command.generation !== generation || !target) return;
    await chrome.debugger.sendCommand(target, 'Page.screencastFrameAck', {sessionId: command.ack}).catch(() => {});
  }

  async function detached(source, stoppedAt = now()) {
    if (source.tabId !== target?.tabId) return;
    target = undefined;
    generation = undefined;
    send({type: 'detached', stoppedAt});
    await chrome.storage.session.remove(CAPTURE_KEY);
    try {
      await restoreExtensions(chrome);
    } finally {
      await clearIndicator();
    }
  }

  return {dispatch, cleanup, onFrame, acknowledge, detached};
}
