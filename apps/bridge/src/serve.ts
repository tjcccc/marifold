import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createBridge } from './index';

const token = process.env.MARIFOLD_BRIDGE_REGISTRATION_TOKEN;
if (!token) { throw new Error('Set MARIFOLD_BRIDGE_REGISTRATION_TOKEN.'); }
const database = process.env.MARIFOLD_BRIDGE_DATABASE || 'data/bridge.sqlite';
const port = Number(process.env.PORT ?? 32143);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) { throw new Error('Invalid PORT.'); }
if (database !== ':memory:') { mkdirSync(dirname(database), { recursive: true, mode: 0o700 }); }
const server = createBridge({ registrationToken: token, database });
server.listen(port, process.env.HOST ?? '127.0.0.1', () =>
  process.stdout.write(`Marifold bridge listening on port ${port}.\n`),
);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
}
