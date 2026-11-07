import {createHost, HELLO_TIMEOUT_MS} from './host.mjs';
import {packet, decoder} from './core.mjs';

process.umask(0o077);

// Exit instead of retrying: the extension reconnects on its own schedule.
function fail(message) {
  console.error(message);
  void host.close().finally(() => process.exit(1));
}

const helloTimer = setTimeout(() => fail('Extension did not send hello'), HELLO_TIMEOUT_MS);
const host = createHost({
  send: value => process.stdout.write(packet(value)),
  onListening: () => clearTimeout(helloTimer),
  onFatal: error => fail(error.message),
});
const decode = decoder(host.receive, undefined, host.receiveOversize);
process.stdin.on('data', chunk => {
  try {
    decode(chunk);
  } catch (error) {
    fail(error.message);
  }
});
process.stdin.on('end', () => {
  void host.close().finally(() => process.exit(0));
});
