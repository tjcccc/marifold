import { createBridge, RedisRelayStore } from '../dist/index.js';
export default createBridge(
  new RedisRelayStore(process.env.MARIFOLD_BRIDGE_REDIS_URL!),
  process.env.MARIFOLD_BRIDGE_REGISTRATION_TOKEN!,
);
