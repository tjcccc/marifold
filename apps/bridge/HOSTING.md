# Bridge hosting guide

Updated October 24, 2026. Deploy only the bridge. Never upload `~/.marifold`, profiles, model credentials or the local marifold service: the bridge is an authenticated encrypted relay, and the personal application service stays on the owner's devices.

The bridge stores host registrations, revocations and pending encrypted frames in SQLite, so one relay instance serves a deployment. Choose a target reachable from your devices' actual networks, and test pairing from home and office before relying on it.

| Target | Recipe | Infrastructure you provide |
| --- | --- | --- |
| Cloudflare Workers | [One command](#cloudflare-workers) | A Cloudflare account (free plan); optionally a domain |
| Linux VM (Aliyun ECS, AWS EC2, …) | [Guided installer](#linux-server-guided-installer) | A server with Docker; a domain or existing HTTPS ingress |
| Other Node 24 hosts | [Manual Node service](#manual-node-service) | A persistent disk and HTTPS in front |

Vercel and other serverless hosts without persistent WebSockets are not supported in this version.

## Cloudflare Workers

```sh
marifold workspace bridge deploy cloudflare [--name marifold-bridge]
```

This runs a pinned `wrangler` through `npx` (Node.js with npm is required). On first use it opens the browser to sign in to Cloudflare and, for a new account, asks for a `workers.dev` subdomain. It uploads the prebuilt Worker from the installed marifold, creates its Durable Object, sets a newly generated registration token as a Worker secret in the same upload, and prints the URL. Nothing else on the account changes.

Files on this device, in `~/.marifold/bridge/cloudflare/` (folder mode 0700): `registration-token` (0600, reused by later deploys), `deployment.json` (the URL), and the generated `worker.js` and `wrangler.json`. Hosting the workspace on this device needs no token: `marifold workspace create <name>` uses the deployed URL and saved token, and the Web UI's **Host this device** form fills in the URL and leaves the token empty. Only another device asks for it (`cat ~/.marifold/bridge/cloudflare/registration-token`).

Run the same command again after upgrading marifold to update the Worker. Updating keeps the Durable Object's data and the token. If wrangler needs a proxy to reach Cloudflare's API, set `HTTPS_PROXY` in that shell; it honors it.

How it runs: one Durable Object named `relay` holds every connection (WebSocket Hibernation API) and its own SQLite storage, so the relay behaves like a single Node process. Health checks are answered by the Worker without waking the Durable Object. Hibernation keeps idle connections free of duration charges.

Free-plan budget, measured on the local Workers runtime: a full pairing, a 1 MB transfer, a reconnect, a revocation and a re-pair wrote 9 SQLite rows in total. Frames that are acknowledged within five seconds are never stored, so routine traffic and status heartbeats write nothing. Each WebSocket connection is a request, and incoming messages are billed at 20:1. Check Cloudflare's current [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/pricing/) before relying on the free plan.

Reachability: `*.workers.dev` is often blocked or unstable from mainland China. Either give each device a [proxy](#device-proxies) or add a custom domain under the Worker's **Settings → Domains & Routes** in the Cloudflare dashboard, then use that origin as the bridge URL. A new bridge URL means creating the workspace again (see [Moving to another bridge](#moving-to-another-bridge)).

Remove the deployment with `npx wrangler@4.151.3 delete --name marifold-bridge`, then delete `~/.marifold/bridge/cloudflare/`.

## Linux server: guided installer

On a Linux server with systemd, install Docker Engine and its Compose plugin using the [official instructions](https://docs.docker.com/engine/install/), plus Python 3. The installer checks these; it never replaces Docker packages, changes cloud security groups, or configures DNS. The first build needs access to the Node container image registry.

With marifold built from the repository on the server:

```sh
pnpm install --frozen-lockfile
pnpm -r build
node packages/cli/dist/index.js workspace bridge install
```

If `marifold` already points to that build, run `marifold workspace bridge install`. It asks for sudo and runs on **this server**; the personal marifold service does not need to run there. Alternatively, on your Mac run `marifold workspace bridge prepare ./marifold-bridge`, copy that folder to the server (without `node_modules` or any `.env`), and run `sudo bash setup.sh` inside it. Node and pnpm are not needed on the server for this route: the bridge runs and installs its dependencies inside the Node container.

The wizard asks one question: create **Caddy** HTTPS for a domain you control (point its DNS at the server and allow TCP 80/443), or keep an **existing** HTTPS proxy or Cloudflare Tunnel that forwards to `http://127.0.0.1:32143`. After you confirm, it generates the registration token, builds and starts the containers, waits for the bridge's health check, and prints the next steps. It never prints secrets.

The installation lives at `/opt/marifold-bridge` (mode 0700):

| File/resource | Purpose |
| --- | --- |
| `compose.json` | Named project and restart policies |
| `bridge.env` | Registration token and database path |
| `registration-token` | Copy of the token for the host's create prompt |
| `package/` | Compiled bridge and container build files; no personal state |
| Volume `bridge-data` | SQLite database (`/app/data/bridge.sqlite`); never deleted automatically |
| Volumes `caddy-data`, `caddy-config` | Certificates, only with Caddy |

Read the token on the server with `sudo cat /opt/marifold-bridge/registration-token` and enter it when creating the workspace on your host. Docker starts at boot and containers use `restart: unless-stopped`.

```sh
sudo docker compose -f /opt/marifold-bridge/compose.json ps
sudo docker compose -f /opt/marifold-bridge/compose.json logs --tail 50 bridge
sudo docker compose -f /opt/marifold-bridge/compose.json restart bridge
```

After editing `bridge.env`, use `up -d` (not `restart`) to apply it. Never print `docker compose config` without `--quiet`, and never run `docker compose down -v` unless you mean to delete the bridge database and certificates.

If startup fails, files and data are kept. Fix the cause and retry with `marifold workspace bridge install --start` (or `sudo bash setup.sh --start`). A normal install refuses an existing directory, containers or volumes instead of overwriting them.

### Updates

Pull and rebuild marifold on the server, then run `marifold workspace bridge update` (or `sudo bash setup.sh --update` from a freshly prepared package). The updater builds the new release while the current container runs, preserves the installed Dockerfile (including a registry mirror), the token, the data volume and Caddy, and replaces only the bridge container. Devices reconnect briefly. A failed deployment or health check rolls back to the retained previous image.

Installations made by marifold 0.95 and earlier used Redis (installation schema 1). They are not upgraded in place: the updater refuses them. Remove such an installation (below) and install again, then create the workspace on the new bridge.

### Removing an installation

```sh
sudo docker compose -f /opt/marifold-bridge/compose.json down -v
sudo rm -rf /opt/marifold-bridge
```

`down -v` deletes the bridge data and any Redis or Caddy volumes of that project. Close any firewall ports and DNS records you opened for it.

## Manual Node service

For a host that runs Node 24 directly, prepare the package (`marifold workspace bridge prepare ./marifold-bridge`), copy it to the host, then run `npm install --omit=dev --ignore-scripts` there; do not copy your Mac's `node_modules`. Configure:

```dotenv
MARIFOLD_BRIDGE_REGISTRATION_TOKEN=REPLACE_WITH_openssl_rand_-hex_32
MARIFOLD_BRIDGE_DATABASE=/var/lib/marifold-bridge/bridge.sqlite
HOST=127.0.0.1
PORT=32143
```

The entry point is `node dist/serve.js`; it does not read `.env` itself, so load the variables through your service manager. Keep the database on persistent storage writable only by the service account, put HTTPS in front (Caddy, nginx, or a Cloudflare Tunnel to `localhost:32143`), and keep port 32143 private. Forward the whole hostname without a path prefix, and allow noninteractive WebSocket clients: no login gates, bot challenges or caching on the bridge hostname.

A minimal systemd unit:

```ini
[Unit]
Description=marifold personal workspace bridge
Wants=network-online.target
After=network-online.target

[Service]
User=marifold-bridge
Group=marifold-bridge
WorkingDirectory=/opt/marifold-bridge
EnvironmentFile=/etc/marifold-bridge.env
ExecStart=/usr/bin/node /opt/marifold-bridge/dist/serve.js
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/marifold-bridge

[Install]
WantedBy=multi-user.target
```

## Device proxies

Each device chooses Direct (the default) or an HTTP(S) proxy for each workspace connection: `--proxy <url>` on `marifold workspace create` and `add`, `marifold workspace proxy <workspace> <url|direct>` later, and the same field in the Web UI. It applies to registration, pairing, the WebSocket and every reconnect. It is stored only on that device, never sent to the host or bridge, and status output omits its credentials. `HTTPS_PROXY` and model-provider proxies do not apply to bridge connections.

Never put a device's proxy in the server's environment: `127.0.0.1` there means the server.

## Moving to another bridge

A workspace is registered on one bridge URL. To move it (for example from a Linux server to Cloudflare):

1. Deploy the new bridge.
2. On the host: `marifold workspace remove <workspace>`, then `marifold workspace create <name> --bridge <new URL>`. Profiles, sessions and other data stay on the host; only the connection is replaced. It prints a new invitation.
3. On each guest: `marifold workspace remove <workspace>`, then `marifold workspace add <new URL>` with a fresh invitation (`marifold workspace invite <workspace>` on the host for each further device).
4. Remove the old bridge.

## Acceptance checklist

Before relying on a bridge, verify from your real devices and networks:

- `/health` answers without a login or challenge; registration and pairing succeed.
- A guest reads shared host data and gets a model answer from the host.
- An approved file write reaches the selected device, and its artifact downloads.
- Separate sessions run concurrently; the same session refuses a competing run.
- A bridge or network interruption recovers without repeating side effects.
- Host offline behavior, executor opt-out and device revocation work.
- For a server: the database survives a container rebuild and a reboot.
