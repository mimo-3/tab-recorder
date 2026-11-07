import {createRecorder} from './lib/recorder.js';
import {createConnection, ensureReconnectAlarm, RECONNECT_ALARM} from './lib/connection.js';

// Keep in sync with HOST_NAME in lib/core.mjs.
const HOST_NAME = 'com.mimo3.tab_recorder';
let queue = Promise.resolve();

const connection = createConnection(chrome, {
  hostName: HOST_NAME,
  onMessage: command => {
    if (command.type === 'ack') {
      void recorder.acknowledge(command);
      return;
    }
    queue = queue.then(async () => {
      try {
        const data = await recorder.dispatch(command);
        connection.send({type: 'result', id: command.id, ok: true, data});
      } catch (error) {
        connection.send({type: 'result', id: command.id, ok: false, error: error.message});
      }
    });
  },
  onDisconnect: () => {
    queue = queue.then(recorder.cleanup).catch(console.error);
  },
});

const recorder = createRecorder(chrome, connection.send);
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

function initialize() {
  queue = queue.then(recorder.cleanup).catch(console.error);
  void queue.then(connection.connect);
}

// Listeners must be registered synchronously so alarm wake-ups reach this worker.
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RECONNECT_ALARM) void queue.then(connection.connect);
});
chrome.runtime.onStartup.addListener(initialize);
chrome.runtime.onInstalled.addListener(initialize);
void ensureReconnectAlarm(chrome).catch(console.error);
initialize();
