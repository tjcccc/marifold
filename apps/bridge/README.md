# Personal workspace bridge

This package routes encrypted messages between one owner's Marifold devices. It
contains no provider credentials, profile database, model endpoint, or agent tools.
The host service must stay online. Redis stores host public identities, revocations,
connection generations and encrypted delivery queues; it is required for production.

See [Hosting options and setup](HOSTING.md) for Vercel, Cloudflare Tunnel, AWS EC2,
and Aliyun ECS recipes, local device proxy design, and deployment acceptance.

For a guided Linux server install, run `marifold workspace bridge install`, or
`sudo bash setup.sh` inside a prepared package on that server. The
[installer guide](HOSTING.md#guided-linux-installer) covers Docker prerequisites,
Redis/HTTPS choices, automatic startup, and token retrieval.

## Vercel test deployment

1. Use `marifold workspace bridge prepare ./marifold-bridge` to create a standalone
   deployment directory. Review its README, environment template and `vercel.json`.
   It contains compiled bridge/protocol code and pinned direct dependencies, with
no personal Marifold data. Run `npm install --ignore-scripts` inside it to create
   the dependency lockfile before deploying.
2. Provision a **TCP Redis** service with TLS, persistent storage, and enough
   connections for the relay. A REST-only Redis endpoint is insufficient. Keep the
   Redis service and Vercel region close together. Retain host/revocation metadata
   across restarts; use a non-evicting database and provider backups.
3. In Vercel, select Node.js 24 and enable **Fluid compute**. Add the two variables
   from `.env.example` as encrypted project environment variables. Use a random
   registration token (for example `openssl rand -hex 32`), and copy it securely
   to the host's workspace creation prompt. It is not a guest invitation.
4. From the prepared directory, use the Vercel dashboard or `vercel` CLI to review
   the account, project, region and deployment. Review Vercel and Redis plan limits
   and spending controls before confirming creation. This package does not create
   paid resources automatically. Deployment Protection must permit `/health`,
   `/v1/hosts` and `/v1/connect`; Marifold authenticates these endpoints itself.
5. Check `https://<deployment>/health` returns `marifold-bridge`. On the host, run
   `marifold workspace create Home --bridge https://<deployment>` and enter the
   registration token. On the other Mac, run `marifold workspace add <url>` and
   enter the single-use invitation. Add `--executor` to enable remote tools.

The source checkout can also be deployed with `apps/bridge` as the project root;
include files outside that root for the workspace protocol dependency and use the
checked-in build command. The prepared standalone directory needs no monorepo.

Vercel WebSockets are currently beta. Its Node function exports an `http.Server`;
connections reconnect before/after function rotation and may reach another
instance. Redis, not process memory, coordinates delivery. Test rotation and a
host–MacBook round trip before relying on the deployment.

Official references: [Vercel WebSockets](https://vercel.com/docs/functions/websockets),
[Vercel function limits](https://vercel.com/docs/functions/limitations).

### Standalone project configuration

For a package already prepared at `~/.marifold/bridge`, start with:

```sh
cd ~/.marifold/bridge
npm install --ignore-scripts
npx vercel link
```

Sign in if prompted, select your account/team, and create or select a project such
as `marifold-bridge`. Link this prepared directory, not the whole `.marifold`
directory. A Git repository is not required for CLI deployment. Review the chosen
account and plan before creating resources.

Use these settings for the **standalone prepared package**:

| Setting | Value |
| --- | --- |
| Framework preset | Other (`framework: null` in the generated configuration) |
| Project root | The prepared bridge directory |
| Node.js | 24.x |
| Fluid compute | Enabled |
| Install command | `npm install --ignore-scripts` |
| Build command | Empty; the prepared runtime is already compiled |
| Function | `api/bridge.ts`, with `maxDuration: 300` |
| Routing | Keep the generated rewrite from `/(.*)` to `/api/bridge` |
| Function region | Choose near your TCP Redis service |
| Deployment Protection | The bridge URL must accept service requests without an interactive Vercel login |

Keep the generated `vercel.json`; do not replace it with settings for a static
website. Source-checkout builds use the different build command described above.

Provision TLS TCP Redis with persistent, non-evicting metadata storage and backups.
In the Vercel project's environment settings, add both variables for **Production**:

| Variable | Value |
| --- | --- |
| `MARIFOLD_BRIDGE_REDIS_URL` | Your provider's full `rediss://…` TCP connection URL, including credentials |
| `MARIFOLD_BRIDGE_REGISTRATION_TOKEN` | A separate random secret used to register hosts |

Generate the registration token locally with `openssl rand -hex 32`. Store it
securely for the host's workspace creation prompt; do not paste it into shared
documentation. The `.env.example` file is a template, and a local `.env` does not
replace Vercel project environment configuration. Add Preview variables separately
only if you intend to test preview deployments.

After reviewing configuration and costs, deploy from the prepared directory:

```sh
npx vercel --prod
curl --fail 'https://<your-project>.vercel.app/health'
```

The health response should identify `marifold-bridge`. Use the stable project
production URL for workspace creation and joining. Health alone does not validate
pairing or WebSocket reconnects; finish the two-device acceptance test above.
Redeploy after changing production environment variables for them to take effect.

CLI references: [link a project](https://vercel.com/docs/cli/link),
[deploy](https://vercel.com/docs/cli/deploy), and
[environment variables](https://vercel.com/docs/environment-variables).

Prefer pnpm? Follow [Using pnpm instead of npm](HOSTING.md#using-pnpm-instead-of-npm)
to create its lockfile and replace the generated npm install command with a
version-pinned pnpm command.

## Device connectivity and proxies

Proxy support for workspace bridge connections is **planned, not implemented**.
The current bridge client does not use Marifold's model-provider proxy settings.
Do not add a bridge proxy key to `.env` or use a `--proxy` workspace option yet.

The planned setting belongs to each device's local workspace connection. Default
to **Direct**; allow an explicit proxy for a connection that needs one. Apply the
same choice to host registration, pairing, WebSocket traffic and reconnects. Make
it available in CLI and Web UI before the first create/join connection, with later
editing supported. Keep proxy addresses and any credentials local and protected;
never synchronize them through the host or expose credentials in status output.

Choose based on reachability from that device, not the hosting provider's name:

| Deployment and device situation | Connection choice |
| --- | --- |
| A Vercel bridge is unreachable directly from this Mac | Configure a local proxy once support exists |
| An Aliyun or another bridge is reachable directly | Direct |
| Home and office have different network requirements | Configure each device independently |

An Aliyun deployment still needs a compatible HTTPS/WebSocket relay and persistent
Redis; the [Aliyun ECS recipe](HOSTING.md#aliyun--alibaba-cloud-ecs) has not been
live-tested. The prepared Vercel configuration is not a generic deployment
configuration for every provider.

The server's `.env` configures the bridge runtime, including Redis and host
registration. It does not configure the Macs connecting to it. A proxy address
such as `127.0.0.1:7890` on Vercel refers to the Vercel runtime, not your Mac.
Provider proxies remain independent from bridge proxies. A VPN/TUN that routes
the Marifold service's traffic may already provide connectivity; a successful
browser page load alone does not prove that background WebSocket traffic works.

## Local smoke test

After building, set the two environment variables and run `node dist/serve.js`.
It binds loopback port 32143 by default; `PORT` and `HOST` override that for a
reviewed standalone deployment. Local `http://127.0.0.1:32143` is accepted by
Marifold. Every non-loopback bridge URL must use HTTPS.

`MARIFOLD_TEST_REDIS_BIN=/path/to/redis-server pnpm --filter @marifold/bridge test`
starts a disposable loopback Redis with persistence disabled for the integration
test. It never connects to a configured production Redis database.

## Retention and recovery

Delivery queues retain up to 128 frames per recipient for five minutes. Endpoint
messages expire after one minute; a reconnect retransmits the same operation ID
in a fresh encrypted frame. The authoritative endpoint journal prevents repeated
effects. Redis loss can make existing workspaces unreachable; restore its metadata
from backup or create and pair a new workspace explicitly. Rotating the registration
token affects future host registrations; existing membership is revoked by the host.

TLS protects each connection. HPKE and endpoint signatures additionally protect
message contents from the bridge. The bridge can observe device/workspace IDs,
routing, packet sizes, timing and public keys. Logs must never include request
bodies, authorization headers, invitation tokens or decrypted application data.
