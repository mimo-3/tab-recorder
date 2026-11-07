export const RECONNECT_ALARM = 'reconnect-native-host';
// Chrome clamps alarm periods to at least 30 seconds.
export const RECONNECT_PERIOD_MINUTES = 0.5;
export const INSTANCE_KEY = 'instanceId';
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export async function instanceId(chrome) {
  const saved = (await chrome.storage.local.get(INSTANCE_KEY))[INSTANCE_KEY];
  if (typeof saved === 'string' && saved) return saved;
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

  async function open() {
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
