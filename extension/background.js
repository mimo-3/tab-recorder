import {createRecorder} from './lib/recorder.js';

// Keep in sync with HOST_NAME in lib/core.mjs.
const HOST_NAME = 'com.mimo3.tab_recorder';
const INITIAL_RECONNECT_MS = 3_000;
const MAX_RECONNECT_MS = 60_000;
let port;
let reconnectTimer;
let reconnectDelay = INITIAL_RECONNECT_MS;
let queue = Promise.resolve();

function send(value) {
  try {
    port?.postMessage(value);
  } catch (error) {
    console.warn('Native host postMessage failed', error);
  }
}

const recorder = createRecorder(chrome, send);
chrome.debugger.onEvent.addListener(recorder.onFrame);
chrome.debugger.onDetach.addListener(source => {
  const stoppedAt = Date.now() / 1000;
  const generation = recorder.generationFor(source.tabId);
  if (generation === undefined) return;
  recorder.detached({...source, generation}, stoppedAt, task => {
    queue = queue.then(task).catch(console.error);
    return queue;
  });
});

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
}

function connect() {
  if (port) return;
  try {
    const connected = chrome.runtime.connectNative(HOST_NAME);
    port = connected;
    connected.onMessage.addListener(command => {
      reconnectDelay = INITIAL_RECONNECT_MS;
      if (command.type === 'ack') {
        void recorder.acknowledge(command);
        return;
      }
      queue = queue.then(async () => {
        try {
          const data = await recorder.dispatch(command);
          send({type: 'result', id: command.id, ok: true, data});
        } catch (error) {
          send({type: 'result', id: command.id, ok: false, error: error.message});
        }
      });
    });
    connected.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = undefined;
      queue = queue.then(recorder.cleanup).catch(console.error);
      scheduleReconnect();
    });
  } catch (error) {
    console.warn('Native host connection failed', error);
    scheduleReconnect();
  }
}

function initialize() {
  queue = queue.then(recorder.cleanup).catch(console.error);
  void queue.then(connect);
}

initialize();
chrome.runtime.onStartup.addListener(initialize);
chrome.runtime.onInstalled.addListener(initialize);
