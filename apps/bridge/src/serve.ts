import { createBridge, RedisRelayStore } from './index';
const redisUrl = process.env.MARIFOLD_BRIDGE_REDIS_URL;
const token = process.env.MARIFOLD_BRIDGE_REGISTRATION_TOKEN;
if (!redisUrl || !token) throw new Error('Set MARIFOLD_BRIDGE_REDIS_URL and MARIFOLD_BRIDGE_REGISTRATION_TOKEN.');
const port = Number(process.env.PORT ?? 32143);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
const server = createBridge(new RedisRelayStore(redisUrl), token);
server.listen(port, process.env.HOST ?? '127.0.0.1', () =>
  process.stdout.write(`Marifold bridge listening on port ${port}.\n`),
);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
