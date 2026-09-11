# Bridge hosting guide

Updated September 11, 2026. These are manual deployment recipes for the existing
bridge. The standalone package has passed local smoke tests; Vercel, Cloudflare,
AWS, and Aliyun live deployments remain unverified. Review current provider plans,
limits, regions, and costs before creating resources.

Only deploy the bridge package. Never upload the parent `.marifold` directory,
profiles, model credentials, or the local Marifold application service. The bridge
is an authenticated encrypted relay; the personal application service remains on
the owner's device.

## Choose a deployment

For a Linux VM, start with the [guided installer](#guided-linux-installer).
The manual systemd recipe below remains available for installations without Docker.

| Provider | Recipe for the current code | Additional infrastructure |
| --- | --- | --- |
| Vercel | Prepared Node function project | TLS TCP Redis |
| Cloudflare | Named Tunnel to a persistent Node service | Always-on Linux server, domain, TCP Redis |
| AWS | EC2 Linux instance with systemd and Caddy HTTPS | Domain, persistent TCP Redis |
| Aliyun / Alibaba Cloud | ECS Linux instance with systemd and Caddy HTTPS | Domain, persistent TCP Redis |

Cloudflare Tunnel provides the public HTTPS endpoint; it does not host the Node
process. The current package contains no Workers or Containers deployment adapter.
Those products would need separate integration and validation. Similarly, these
AWS and Aliyun recipes use virtual machines, not Lambda or Function Compute.

Choose a region and hostname reachable from the owner's actual devices. A provider
name does not guarantee reachability from mainland China. Test both HTTPS and
paired WebSocket traffic from home and office before relying on a deployment.

## Guided Linux installer

On Aliyun ECS, AWS EC2, or another Linux server with systemd, install Docker Engine
and its Compose plugin using the [official distribution instructions](https://docs.docker.com/engine/install/).
Python 3 is also required. The installer checks these prerequisites; it does not
replace existing Docker packages, change cloud security groups, or configure DNS.
The server needs access to container/package registries for the first build.

If you pulled the Marifold repository onto the server:

```sh
pnpm install --frozen-lockfile
pnpm -r build
node packages/cli/dist/index.js workspace bridge install
```

If the `marifold` command already points to that build, the final command is simply:

```sh
marifold workspace bridge install
```

The CLI requests sudo when necessary and runs the installer on **this server**.
You do not need to start the personal Marifold application service on the ECS.
Alternatively, upload just a prepared bridge package (excluding `.env`, `.vercel`
and `node_modules`), enter that directory on the server, and run:

```sh
sudo bash setup.sh
```

The standalone route does not require Node or pnpm on the VM: the bridge runtime
and dependency installation run inside the Node container. Its image build uses
npm independently of your development package-manager choice.

The wizard asks for:

1. **Redis:** create a dedicated persistent Redis on loopback port 32144 (default),
   or enter an existing Redis URL through a hidden prompt. Existing Redis remains
   unchanged; its credentials and permissions must already be configured. Startup
   checks connectivity, not the full persistence/ACL policy. If using the server's
   existing Redis, `127.0.0.1:6379` works because these Linux containers use host
   networking.
2. **HTTPS:** create Caddy configuration for a domain you control, or keep an
   existing HTTPS proxy/Cloudflare Tunnel. For Caddy, point DNS at this server and
   allow TCP 80/443 in the cloud security group. Existing ingress should forward
   to `http://127.0.0.1:32143` on the same server.
3. **Review and start:** confirm the destination and selected services. The wizard
   generates secrets, builds/starts containers, waits for bridge HTTP and Redis
   connectivity checks, and prints the next steps. It does not print secrets.

The installation lives at `/opt/marifold-bridge` with owner-only access:

| File/resource | Purpose |
| --- | --- |
| `compose.json` | Named project and restart policies |
| `bridge.env` | Protected bridge connection URL and generated registration token |
| `registration-token` | Protected copy of the token for the host creation prompt |
| `package/` | Compiled bridge inputs and container build files; no personal state |
| `redis.conf` | Dedicated Redis settings, only when selected |
| Named Redis volume | Persistent AOF/snapshot data; never automatically deleted |
| Named Caddy volumes | Certificate/configuration state, only when selected |

Read the generated registration token **locally**, then enter it on your host Mac:

```sh
sudo cat /opt/marifold-bridge/registration-token
```

Docker is enabled at boot and containers use `restart: unless-stopped`. They return
after reboot unless deliberately stopped. Dedicated Redis uses AOF with every-second
fsync and a no-eviction policy with a 128 MiB data limit; provision monitoring and
backups before relying on it. Persistence is not a backup. Other projects' Redis
processes and configuration are left alone.

Management commands:

```sh
sudo docker compose -f /opt/marifold-bridge/compose.json ps
sudo docker compose -f /opt/marifold-bridge/compose.json logs --tail 50 bridge
sudo docker compose -f /opt/marifold-bridge/compose.json restart bridge
```

After editing `bridge.env`, use `up -d` to recreate containers with changed values;
`restart` alone does not reload container environment configuration. Review logs
locally before sharing them; never print `docker compose config` without `--quiet`
because expanded configuration may contain secrets.

If startup fails, the installer exits with failure and keeps generated files and
data. Fix the connection, registry access, or port problem and retry:

```sh
marifold workspace bridge install --start
# Or, from the prepared package:
sudo bash setup.sh --start
```

This reuses the original configuration/token. A normal install refuses an existing
directory, containers, or volumes instead of overwriting them. It does not migrate
an existing manual systemd deployment or upgrade an older installed package.
Never use `docker compose down -v` unless you intend to destroy Redis and certificate
volumes. Public HTTPS and real pairing remain separate acceptance checks after
local health succeeds.

Installer validation covers generated configuration, permissions, input rejection,
secret exclusion, collision protection and startup command sequencing in disposable
fixtures. Docker execution, reboot recovery and live certificates still require
the first Linux server trial; they have not been verified on this development Mac.
Developers can run the installer fixtures with
`python3 -B -m unittest discover -s apps/bridge/setup -p 'test_*.py'` from the repository.

## Common package and Redis prerequisites

Prepare once on the development Mac, or use your existing prepared directory:

```sh
marifold workspace bridge prepare ~/.marifold/bridge
cd ~/.marifold/bridge
npm install --ignore-scripts
```

Preparation refuses an existing destination; do not rerun it over a prepared
package. It includes compiled `dist/`, `vendor/`, a manifest, and Vercel files.
Linux deployments use `node dist/serve.js` and ignore `vercel.json` and the
Vercel-specific API entry point. Install dependencies on the destination OS;
do not transfer your Mac's `node_modules`.

Use a Redis service that supports the current `ioredis` client's TCP commands,
Lua scripts, and pub/sub. A REST-only endpoint or an unvalidated cluster endpoint
is insufficient. Start with a dedicated single-primary Redis-compatible endpoint;
the bridge does not configure Redis Cluster discovery. Enable persistence,
non-evicting storage, and backups: host identities and revocations must survive
restarts. Use TLS (`rediss://`) for remote Redis and allow access only from the
bridge's network where possible. Never expose an unauthenticated Redis port.

All deployments require:

```dotenv
MARIFOLD_BRIDGE_REDIS_URL=rediss://default:REPLACE_ME@redis.example.com:6379
MARIFOLD_BRIDGE_REGISTRATION_TOKEN=REPLACE_WITH_A_RANDOM_SECRET
```

Generate a separate registration secret using `openssl rand -hex 32`. Store it
securely; it registers hosts and is not the guest invitation. Percent-encode
reserved characters in Redis URL credentials. Do not commit real environment
files or copy secrets into support messages.

## Vercel

### Using pnpm instead of npm

The prepared package can use pnpm. Choose one package manager for this deployment
directory. If switching from npm, move its `package-lock.json` and `node_modules`
aside before reinstalling; do not deploy two competing lockfiles.

```sh
cd ~/.marifold/bridge
pnpm install --ignore-scripts
pnpm --version
```

Keep the resulting `pnpm-lock.yaml` and use the same exact pnpm version in
deployment. For example, with pnpm **11.17.0**, replace only `installCommand` in
the prepared `vercel.json` with:

```json
"installCommand": "npx --yes pnpm@11.17.0 install --frozen-lockfile --ignore-scripts"
```

This is a property to edit in the existing JSON object, not a replacement for the
whole configuration. Match the version to the one used to create your lockfile.
The explicit version avoids relying on Vercel's preinstalled pnpm default; the
build needs registry access to fetch that version. Preserve all routing/function
settings. On a Linux VM with that pnpm version installed, replace `npm ci` with
`pnpm install --frozen-lockfile --ignore-scripts` and transfer `pnpm-lock.yaml`
instead of `package-lock.json`. The runtime command remains `node dist/serve.js`.

See [pnpm install](https://pnpm.io/cli/install) and
[Vercel package-manager selection](https://vercel.com/docs/package-managers).

### Deploy the project

Use the [complete project configuration in README](README.md#standalone-project-configuration).
The short sequence, after preparing the package, is:

1. Run `npx vercel link` inside the prepared directory. Select the account and
   create/select the bridge project; no Git repository is required.
2. Provision TLS TCP Redis and add the two variables above to the project's
   Production environment settings.
3. Select Other as the framework, Node 24.x, and enable Fluid compute. Keep the
   generated empty build command, install command, function duration, and rewrites.
4. Ensure Deployment Protection permits machine access to `/health`, `/v1/hosts`,
   and `/v1/connect` without an interactive login.
5. Run `npx vercel --prod`, then use the stable production project URL for pairing.
   Redeploy after changing deployment environment variables.

WebSocket connections can end at function duration limits and reconnect to another
instance, so external Redis coordination is required. See
[Vercel WebSockets](https://vercel.com/docs/functions/websockets).

## Shared Linux service for AWS, Aliyun, and Cloudflare origins

Use a dedicated Ubuntu/Debian-style Linux VM with systemd. Install Node.js **24.x**
and npm using a supported [Node installation method](https://nodejs.org/en/download).
Use a system-wide executable, not an interactive user's shell-only version-manager
setup. Check `node --version` and `command -v node`.

Transfer only the prepared package to a new deployment directory, such as
`/opt/marifold-bridge`. Exclude `.env`, `.env.*`, `.vercel`, and `node_modules`;
keep `.env.example` as a template if wanted. Retain `package-lock.json`, then run
`npm ci --ignore-scripts` on the VM as the deployment user. The deployment user
owns installation; the runtime account only needs read access to the package.

On a fresh VM, create a dedicated runtime account and environment file:

```sh
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin marifold-bridge
sudo install -m 600 /dev/null /etc/marifold-bridge.env
sudoedit /etc/marifold-bridge.env
```

These creation commands are for a fresh installation; preserve existing accounts
and environment files during updates. Fill the file using your actual values:

```dotenv
MARIFOLD_BRIDGE_REDIS_URL=rediss://default:REPLACE_ME@redis.example.com:6379
MARIFOLD_BRIDGE_REGISTRATION_TOKEN=REPLACE_WITH_YOUR_GENERATED_SECRET
HOST=127.0.0.1
PORT=32143
```

The Node entry point does not automatically read `.env`. This service unit loads
the protected environment file. Create
`/etc/systemd/system/marifold-bridge.service`:

```ini
[Unit]
Description=Marifold personal workspace bridge
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=marifold-bridge
Group=marifold-bridge
WorkingDirectory=/opt/marifold-bridge
EnvironmentFile=/etc/marifold-bridge.env
ExecStart=/usr/bin/node /opt/marifold-bridge/dist/serve.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict

[Install]
WantedBy=multi-user.target
```

Replace `/usr/bin/node` with the system-wide path verified above if different.
Ensure the runtime user can traverse/read the deployment directory. Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now marifold-bridge
sudo systemctl status marifold-bridge
curl --fail http://127.0.0.1:32143/health
```

Health identifies the process; pairing is still needed to verify Redis delivery.
Check service logs locally when diagnosing errors and redact credentials before
sharing them. Keep port 32143 private. Choose **one** ingress method below:
Caddy for direct HTTPS, or Cloudflare Tunnel on the same VM.

### Direct HTTPS with Caddy

Point a domain such as `bridge.example.com` at the VM's stable public IP. Install
Caddy with its official system service. Configure `/etc/caddy/Caddyfile`:

```caddyfile
bridge.example.com {
    reverse_proxy 127.0.0.1:32143
}
```

Replace the example hostname. Allow inbound TCP 80 and 443 for this recipe, and
ensure DNS resolves correctly for certificate issuance. Leave 32143 and Redis
closed to public inbound traffic. Caddy handles HTTPS and reverse proxying; see
the [reverse proxy guide](https://caddyserver.com/docs/quick-starts/reverse-proxy)
and [service setup](https://caddyserver.com/docs/running#using-the-service).

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --fail https://bridge.example.com/health
```

Use the whole hostname for this relay, without stripping `/v1/connect` or adding
a path prefix. Avoid browser login gates, interactive bot challenges, and caching
on bridge endpoints. Exercise WebSocket pairing after configuring the proxy.

## AWS EC2

1. Create a Linux EC2 instance in the chosen region, with persistent disk and a
   stable public address for direct HTTPS. Use a dedicated SSH key or your existing
   approved administrative access. Review instance, disk, IP, and transfer charges.
2. Configure its security group: admin access only from your management network;
   TCP 80/443 for Caddy ingress; no public 32143 or Redis port. Keep outbound access
   needed for DNS, package installation, certificates, and the Redis endpoint.
   [EC2 security groups](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-security-groups.html)
3. Provision a dedicated compatible Redis endpoint in the same region, preferably
   on a private network reachable from the instance. Enable TLS/authentication,
   persistence and backups; verify service command/endpoint compatibility before
   selecting a managed Redis offering. Do not assume all serverless cache products
   are interchangeable with this client's single-primary connection.
4. Install the shared Linux service, point your DNS hostname at the stable address,
   and configure Caddy as above. Keep the environment file outside the package.
5. Perform the acceptance checklist below, including an instance/service restart.

An AWS load balancer is optional and not required for this one-owner initial
recipe. Adding one requires separate TLS, WebSocket timeout, and cost review.

## Aliyun / Alibaba Cloud ECS

1. Select a Linux ECS instance, persistent disk, region, public bandwidth, and
   stable public IP/EIP appropriate to your devices. Review the region's domain
   and hosting prerequisites before purchase. For mainland hosting, consult
   [Alibaba Cloud's ICP filing guidance](https://www.alibabacloud.com/help/en/icp-filing/basic-icp-service/product-overview/what-is-an-icp-filing)
   and confirm the requirements for your intended endpoint with the provider.
2. Configure the ECS security group for restricted administrative access and
   Caddy TCP 80/443. Keep the Node port and Redis private. See
   [ECS security group rules](https://www.alibabacloud.com/help/en/ecs/user-guide/security-group-rules).
3. Provision persistent compatible TCP Redis in the same region/VPC. Check TLS,
   authentication, non-eviction, backups, Lua/pub/sub support, and endpoint mode.
   A managed Redis-compatible product still needs this compatibility check.
4. Install the shared Linux service and Caddy. Configure DNS for the endpoint and
   complete applicable provider domain setup before certificate issuance/testing.
5. Test from the actual mainland networks and devices, then complete acceptance.
   Direct is the intended connection mode when this endpoint is reachable.

This recipe does not use Aliyun Function Compute or require Cloudflare in front
of Aliyun. The same Node service layout can be adapted to another Linux VM
provider, with that provider's firewall, DNS, and storage setup.

## Cloudflare Tunnel

This recipe needs an always-on server running the shared Linux service. It can
be an AWS/Aliyun VM or another server. Cloudflare supplies the public endpoint and
outbound tunnel, while that server supplies compute and reaches Redis.

1. Add/control the intended domain in Cloudflare and install the bridge service
   on the origin VM. Confirm local health on `127.0.0.1:32143`.
2. Create a named Cloudflare Tunnel in the dashboard. Install `cloudflared` on the
   **same VM** using the dashboard's OS-specific connector instructions; run it
   as a persistent service. Treat its connector token as a secret.
3. Add a published application route for `bridge.example.com`, service type HTTP,
   service URL `localhost:32143`, with no path restriction. Cloudflare terminates
   public TLS; the origin HTTP hop is local to the VM. Do not use the private
   Marifold application service as the tunnel origin.
4. Keep inbound Node/Redis ports closed. Allow the connector's documented outbound
   traffic. An origin using only Tunnel does not need public inbound 80/443 or a
   Caddy installation. Retain your separate administrative access.
5. Ensure the bridge hostname allows noninteractive HTTP/WebSocket clients. The
   current client does not supply Cloudflare Access service-token headers and
   cannot complete browser challenges. Scope any exception to this relay hostname;
   do not remove protections from unrelated applications.
6. Verify public health, pair two devices, and restart the connector to exercise
   reconnect. Use the stable hostname rather than a temporary Quick Tunnel URL.

Follow the [official named-tunnel setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/).
Cloudflare proxies WebSockets but connections can close during network updates;
see [WebSocket behavior](https://developers.cloudflare.com/network/websockets/).
This route does not guarantee reachability from every mainland network.

## Local device proxies

Bridge proxy support is **planned, not implemented**. The intended setting is
local to each device's workspace connection: Direct by default, with an optional
explicit proxy applied consistently to registration, pairing and WebSocket
reconnects. Home and office may use different values for the same endpoint.

This is independent of hosting provider and model-provider proxies. Never put a
Mac's proxy address in the server environment file: `127.0.0.1` there means the
server. Do not synchronize local proxy credentials. CLI/Web create/join and later
connection editing should expose the setting when implemented. For now a VPN/TUN
that routes the service process may supply connectivity; provider proxy settings
do not configure workspace bridge traffic.

## Acceptance, updates, and recovery

There is currently no `marifold workspace bridge update` command. The installer
option `workspace bridge install --start` starts the installed package; it does
not copy newer bridge code from a freshly pulled repository. Device-only fixes
(including v0.70.1–v0.70.2 avatar and transfer changes) need updated Mac services,
not a bridge redeployment.

For every provider, verify before relying on the bridge:

- HTTPS health responds without a login/challenge; then authenticated registration
  and pairing succeed. Health alone is not a Redis or end-to-end execution test.
- The guest reads shared host data and receives a host-authenticated model answer.
- An approved file write reaches the selected device; its artifact downloads.
- Separate sessions run concurrently; the same session rejects competing runs.
- Connection/service/ingress restart recovers without duplicate side effects.
- Host offline behavior, guest executor opt-out, and device revocation work.
- Redis metadata survives a planned restart and has a recovery procedure. Test
  backup/restore on disposable data before applying it to a real workspace.

Retain the prior package for rollback. For a Linux update, stage dependencies in
a separate release directory, stop/switch/restart the service during a planned
interruption, and preserve the environment file and Redis data. For Vercel, retain
the prior deployment and environment configuration. Recheck pairing and reconnect
after a change. Do not flush Redis as a troubleshooting shortcut: losing host and
revocation metadata can break existing workspaces.

The remaining live acceptance work is shared with the repository's
`docs/workspaces.md`. No provider resources are created by preparing this package
or by saving this guide.
