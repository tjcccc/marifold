# Personal workspace bridge

This package relays end-to-end encrypted messages between one owner's marifold devices. It holds no provider credentials, profile data, model endpoint or agent tools, and it never sees decrypted content. The host device's service must stay online; the bridge only connects devices.

The bridge keeps its state in SQLite: host public identities, revocations, and encrypted frames waiting for a recipient that is offline or has not acknowledged them yet. One relay instance serves a deployment.

## Deploy

| Target | Command | Notes |
| --- | --- | --- |
| Cloudflare Workers (recommended) | `marifold workspace bridge deploy cloudflare` | Free plan is enough for personal use; HTTPS included; no server |
| Linux server (Aliyun ECS, AWS EC2, any VM) | `marifold workspace bridge install` on the server | Docker Compose, SQLite on a named volume, optional Caddy HTTPS |
| Any Node 24 host | `node dist/serve.js` from a prepared package | Needs a persistent disk and HTTPS in front |

See [HOSTING.md](HOSTING.md) for each target, updates, and the acceptance checklist.

### Cloudflare in one command

```sh
marifold workspace bridge deploy cloudflare
marifold workspace create Home
```

The first command signs in to Cloudflare in the browser (first use only), uploads the prebuilt Worker with a newly generated registration token, and prints the bridge URL. The token stays in `~/.marifold/bridge/cloudflare/registration-token`; `workspace create` and the Web UI on the same device use the deployed URL and token automatically. Run the deploy command again after upgrading marifold; paired devices and the bridge protocol stay compatible across updates.

`*.workers.dev` is often unreachable from mainland China. Use a proxy on each device (below) or add a custom domain to the Worker in the Cloudflare dashboard.

## Device proxies

Each device chooses **Direct** (the default) or an HTTP(S) proxy for each workspace connection. The proxy covers registration, pairing, the WebSocket and every reconnect, and is stored only on that device:

```sh
marifold workspace create Home --bridge https://… --proxy http://127.0.0.1:7890
marifold workspace add https://… --proxy http://127.0.0.1:7890
marifold workspace proxy Home http://127.0.0.1:7890   # or: direct
```

The Web UI has the same field when hosting or joining and in each workspace's settings. Model-provider proxies are separate, and `HTTPS_PROXY` is not used for bridge connections. The proxy sees only the bridge hostname: TLS to the bridge runs inside its CONNECT tunnel.

## Local development

`pnpm build` compiles the Node server (`dist/`) and bundles the Worker (`dist/cloudflare/worker.js`). Run either locally:

```sh
MARIFOLD_BRIDGE_REGISTRATION_TOKEN=$(openssl rand -hex 32) MARIFOLD_BRIDGE_DATABASE=:memory: node dist/serve.js
npx wrangler@4.151.3 dev --var MARIFOLD_BRIDGE_REGISTRATION_TOKEN:<token>
```

marifold accepts `http://` only on loopback; every other bridge URL must use HTTPS. `tests/LiveBridge.test.ts` runs real paired devices against a running bridge when `MARIFOLD_TEST_BRIDGE_URL` and `MARIFOLD_TEST_BRIDGE_TOKEN` are set, for example against `wrangler dev`.

## Retention and recovery

A frame delivered to an online device waits in memory for its acknowledgment for up to five seconds and is stored only if the ack is late or the device disconnects; frames for an offline device are stored at once. Stored frames are kept for five minutes, at most 128 per recipient, and replayed on reconnect until acknowledged. A full inbox closes the sender's connection with code 1013 (try again later). Endpoint messages expire after one minute; a reconnect resends the same operation ID, and the endpoint journal prevents repeated effects.

Losing the bridge database makes existing workspaces unreachable until the host creates the workspace on a bridge again and the guests re-pair. Rotating the registration token affects future host registrations only.

TLS protects each connection; HPKE and endpoint signatures protect message contents from the bridge. The bridge can observe device and workspace IDs, routing, packet sizes, timing and public keys. It logs no request bodies, authorization headers, invitations or application data.
