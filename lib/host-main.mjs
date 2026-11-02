import {createHost} from './host.mjs';
import {packet, decoder} from './core.mjs';

process.umask(0o077);
const host = createHost({send: value => process.stdout.write(packet(value))});
const decode = decoder(host.receive, undefined, host.receiveOversize);
process.stdin.on('data', chunk => {
  try {
    decode(chunk);
  } catch (error) {
    console.error(error.message);
    void host.close().finally(() => process.exit(1));
  }
});
process.stdin.on('end', () => {
  void host.close().finally(() => process.exit(0));
});
await host.listen();
