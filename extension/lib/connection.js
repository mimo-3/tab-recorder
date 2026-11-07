export const RECONNECT_ALARM = 'reconnect-native-host';
// Chrome clamps alarm periods to at least 30 seconds.
export const RECONNECT_PERIOD_MINUTES = 0.5;
export const INSTANCE_KEY = 'instanceId';
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
// Reconnect even if cleanup never settles, e.g. behind a hung dispatch.
export const READY_TIMEOUT_MS = 5_000;
// Keep in sync with INSTANCE_ID_PATTERN in lib/core.mjs.
const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function instanceId(chrome) {
  const saved = (await chrome.storage.local.get(INSTANCE_KEY))[INSTANCE_KEY];
  if (typeof saved === 'string' && INSTANCE_ID_PATTERN.test(saved)) return saved;
  const created = crypto.randomUUID();
  await chrome.storage.local.set({[INSTANCE_KEY]: created});
  return created;
}

// The alarm survives service worker shutdown, unlike setTimeout.
export async function ensureReconnectAlarm(chrome) {
  if (await chrome.alarms.get(RECONNECT_ALARM)) return;
  await chrome.alarms.create(RECONNECT_ALARM, {periodInMinutes: RECONNECT_PERIOD_MINUTES});
}

export function createConnection(chrome, {
  hostName,
  onMessage,
  onDisconnect = () => {},
  ready = () => {},
  readyTimeoutMs = READY_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
}) {
  let port;
  let connecting;
  let retryTimer;
  let retryDelay = INITIAL_RETRY_MS;

  function scheduleRetry() {
    clearTimer(retryTimer);
    retryTimer = setTimer(() => { void connect(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  }

  async function waitReady() {
    let timer;
    const timeout = new Promise(resolve => { timer = setTimer(resolve, readyTimeoutMs); });
    try {
      await Promise.race([Promise.resolve(ready()).catch(error => logger.warn('Cleanup before connect failed', error)), timeout]);
    } finally {
      clearTimer(timer);
    }
  }

  async function open() {
    await waitReady();
    const id = await instanceId(chrome);
    if (port) return;
    try {
      const connected = chrome.runtime.connectNative(hostName);
      port = connected;
      connected.onMessage.addListener(message => {
        retryDelay = INITIAL_RETRY_MS;
        onMessage(message);
      });
      connected.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (port === connected) port = undefined;
        onDisconnect();
        scheduleRetry();
      });
      connected.postMessage({type: 'hello', instanceId: id});
    } catch (error) {
      logger.warn('Native host connection failed', error);
      port = undefined;
      scheduleRetry();
    }
  }

  function connect() {
    if (port) return Promise.resolve();
    connecting ??= open().catch(error => {
      logger.warn('Native host connection failed', error);
      scheduleRetry();
    }).finally(() => { connecting = undefined; });
    return connecting;
  }

  function send(value) {
    try {
      port?.postMessage(value);
    } catch (error) {
      logger.warn('Native host postMessage failed', error);
    }
  }

  return {connect, send, connected: () => !!port};
}
