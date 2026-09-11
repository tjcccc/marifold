# Device-hosted workspaces

**Status: in testing (v0.70.0).** Local automated checks have passed; live cloud,
Linux Docker/reboot, public HTTPS, and host–guest acceptance remain pending.

A workspace belongs to one person. Hosting shares this device's existing local
`.marifold` configuration, profiles, sessions, Skills, Apps and schedules. The host
retains the model credentials and authoritative data. A guest joins a live view;
it does not copy the host's database or become another host when disconnected.

Each Mac runs `marifold service`. CLI, TUI and the service-hosted Web UI use that
local service's outbound bridge connection, so neither Mac needs an inbound port
or Tailscale. Browser-only pairing and native iOS clients are future work.

## Setup

Prepare a standalone Vercel deployment package:

```sh
marifold workspace bridge prepare ./marifold-bridge
```

Missing parent directories are created automatically; the destination directory
must not already exist. Use `~/.marifold/bridge` for a directory under your home,
or a relative path for a directory under your current working directory.
It contains compiled bridge/protocol code,
a dependency manifest, environment template and Vercel configuration. No personal
data or secrets are copied. Follow its README to provision TCP Redis, review the
provider plans, configure the environment and deploy. See the complete
[bridge deployment guide](../apps/bridge/README.md). Cloud resource creation is
manual in this version; both workspace creation screens accept a running bridge.

For the prepared package at `~/.marifold/bridge`, follow the
[Vercel project configuration](../apps/bridge/README.md#standalone-project-configuration)
for project linking, Redis, environment variables and production deployment.
For other providers, see the [hosting guide](../apps/bridge/HOSTING.md), including
Cloudflare Tunnel, AWS EC2, and Aliyun ECS.

On a Linux bridge server with Docker Engine/Compose and Python 3, run
`marifold workspace bridge install` for guided Redis/HTTPS configuration and
persistent service startup. Or transfer the prepared package and run
`sudo bash setup.sh` there. See the
[Linux installer](../apps/bridge/HOSTING.md#guided-linux-installer).

On the host:

```sh
marifold service start --daemon
marifold workspace create Home --bridge https://your-bridge.vercel.app
# Enter the bridge registration token. Marifold prints a single-use invitation.
```

On the other Mac:

```sh
marifold service start --daemon
marifold workspace add https://your-bridge.vercel.app --executor
# Enter the invitation. Omit --executor for a viewing/requesting device.
marifold workspace default Home
```

The Web UI's **Workspace** control offers Host this device, Join workspace,
rename, invitations, device revocation, executor opt-in and a startup default.
**Direct servers** preserves existing private-network connections and tokens.
Web workspace pairing uses the service that hosts the page; open each Mac's own
Web UI to pair that Mac. A remote browser is not itself an execution device.

CLI management:

```sh
marifold workspace list
marifold workspace rename --id <workspace_id> "Home studio"
marifold workspace invite <name_or_id>
marifold workspace devices <name_or_id>
marifold workspace executor <name_or_id> on
marifold workspace executor <name_or_id> off
marifold workspace revoke <name_or_id> <device_id>
marifold workspace default local
marifold workspace remove <name_or_id>
```

`remove` stops sharing a hosted workspace or disconnects this guest, while
preserving local profiles and sessions. An offline guest can disconnect locally;
the host may still list its old identity until it is revoked there. Stopping an
offline host removes its local keys but cannot update an unreachable relay until
a separate administrative cleanup. Never reuse those removed keys.

The TUI switches among already-paired workspaces:

```text
/workspace list
/workspace join Home
/workspace leave
/device list
/device use host
/device use <device_id>
/device use auto
```

Agent/ask commands and schedule management accept workspace selection:

```sh
marifold agent --workspace Home "Summarize a document on this device."
marifold agent --workspace Home --device host "Create a report on the host."
marifold agent --workspace Home --device <device_id> --cwd /path/on/that/device "Review this project."
marifold ask --workspace Home "Hello"
marifold schedule --workspace Home list
```

Without `--workspace`, these use the configured startup default. Other standalone
CLI configuration/profile commands retain their local behavior; shared profile,
Skill and configuration management is available in the paired Web UI and TUI.
A new guest needs no local provider authentication to use a configured host model.
Local remains the fallback when the default workspace is unavailable at startup.
Clients briefly allow connections to initialize first. An explicitly selected
offline workspace reports an error. A disconnected active conversation stays in
its workspace, including its draft, and never silently submits work to Local.

## Bridge proxy settings (planned)

Each device should choose **Direct** (the default) or an explicit proxy for each
local workspace connection. A bridge reachable directly, including one hosted on
Aliyun or another provider, needs no proxy. Another connection may need one; home
and office can use different settings for the same bridge.

This setting is device-local, never synchronized from the host, and separate from
model-provider proxies. It belongs in local connection settings, not the deployed
bridge's `.env`. It must cover registration, pairing, WebSocket connections and
reconnects, and be available in CLI/Web UI before create/join.

This is a design requirement, **not an available option yet**. Current workspace
connections do not use provider proxy settings. See the
[connectivity notes](../apps/bridge/README.md#device-connectivity-and-proxies)
for current limitations and hosting-provider distinctions.

## Execution and paths

The host owns each model call and conversation. Every ordinary agent run records
three independent identities:

```json
{
  "workspaceId": "home",
  "originDeviceId": "office",
  "executionDeviceId": "macbook"
}
```

Origin comes from authenticated membership, not client-supplied device metadata.
For ordinary guest requests, Automatic uses the guest if its executor is enabled;
otherwise it uses the host. A selected unavailable/disabled device fails explicitly.
One execution device is fixed for the entire run. Its OS, architecture, home,
working directory and capability set govern its tools. Provider authentication
stays on the host; guest shell environments never inherit host secrets.

For natural-language requests such as “ask my home Mac to create a report”, the
model can call `delegate_device` with an online device name or ID. This requires
approval and starts one child in the same workspace, using the same profile/model.
The child cannot delegate again. Child approvals, clarifications, results and
artifacts appear in the parent conversation. Cancelling the parent cancels its
children. Revoking a device cancels active workspace runs involving that identity.

Guest execution is an explicit, locally revocable opt-in. It supports bounded file
reading/writing, attachment inspection and the existing macOS shell sandbox.
Each guest tool call requires a nonpersistent approval; host profile permissions
cannot widen the guest's local policy. “Always” and “Trust” are rejected for these
calls. Disabling this device's executor cancels its active executions. Pairing alone
does not enable shell or filesystem execution.

Skills, SkillApps and schedules run on the host in this version. Their paths retain
host meaning. An image Skill configured to output under the host's home directory
writes there, without replacing usernames or translating absolute paths. For an
ordinary guest execution, paths instead belong to that selected guest. The service
never interprets a requesting device's path as an upload; attachments carry bytes.

Regular files in a run's output directory become authenticated downloadable
artifacts. Files deliberately written elsewhere stay on that execution device and
are not automatically copied. Completed guest artifacts remain readable after its
service restarts, while execution capabilities and grants are never reconstructed.
Downloads still require the relevant host and output device to be reachable.

The remote executor cannot read another workspace's control state, credentials or
local Marifold data. Shell processes have no general network access, desktop
control or service-management privileges. Installing Python packages remotely and
privileged helpers such as restarting a Tailscale daemon are outside this initial
executor scope. Existing host Skill/package-install capabilities are unchanged.

## Data, pairing and isolation

A configuration can host its existing local workspace once and join multiple
other workspaces, including ones on different bridges. Each connection has distinct
keys and a distinct workspace ID. The host's API exposes only its own application
resources; nested workspace APIs and device-local settings are rejected. UI drafts,
routes and cached views are scoped by connection. Appearance stays a local UI
preference. Provider key values never appear in the shared configuration response.

State lives below `<config directory>/workspaces/<config filename hash>/`:

- `control.db`: connection metadata, invitation verifiers, host-signed memberships,
  operation journals and recent run events. Files are owner-only; the enclosing
  workspace directory is mode 0700.
- `<workspace id>.credentials.json`: independent signing/encryption private keys,
  atomically replaced in a mode 0600 regular file. Symlinked or group/world-readable
  credential files are rejected. Keychain support is deferred.
- `runs/`: isolated guest execution directories and output files.
- `service.lock`: prevents two live services from coordinating the same config.
  A dead process's lock is recovered; a live process's lock is not replaced.

An invitation embeds the bridge URL and pinned host public identity plus a random
32-byte secret. Only its verifier is stored by the host. It expires in 15 minutes
and is consumed by successful pairing. Creating another invitation invalidates
unused prior invitations, without changing already-paired device keys. Each paired
device receives its own host-signed membership. Use `revoke` to invalidate that
device separately. Recover lost device keys by revoking and re-pairing; there is
no shared permanent guest token. All paired devices belong to the same owner and
can manage the shared workspace. Permission roles are deferred.

Do not copy live workspace state between Macs: it would duplicate device identity
and undermine delivery coordination. Back up the host's data and credential files
securely for disaster recovery; pair additional devices instead of cloning them.

## Transport and interruptions

The bridge is a relay, with no model runtime or application API. Both endpoints
connect outbound over WSS. HPKE (P-256, HKDF-SHA256, AES-256-GCM) protects content;
Ed25519 endpoint signatures and authenticated headers bind workspace, sender,
recipient, message ID and expiry. Membership verification pins the host identity.
The relay sees public identities, routing, timing and packet sizes. It does not
receive decrypted conversations or provider keys.

Vercel WebSocket functions require Redis coordination because function instances
and connections can rotate. Durable Redis inboxes contain at most 128 encrypted
frames per recipient for five minutes. Messages expire after one minute. Large
application payloads use authenticated chunks with acknowledgment, transfer-size
limits and assembly expiry. Artifact downloads use 32 KiB chunks independently of
the application-message cap. Redis must preserve host and revocation metadata.

An operation has a stable request ID and input hash. The receiving endpoint journals
mutations before execution. Reconnection resends the same operation ID; completed
results replay without repeating the effect. Reusing an ID with changed input is
rejected. A process restart marks unfinished requests as interrupted/unknown; it
never starts their model/tool loops again. Uncertain remote tool outcomes stop the
run rather than invite the model to repeat an effect automatically.

Result payloads and recent run recovery have a 24-hour retention window (with
bounded event buffers). Old request tombstones remain so expired IDs cannot execute
again. Each service control journal caps accepted mutation IDs at 100,000 and fails
closed at capacity; creating/re-pairing a new workspace preserves the host's normal
profiles and sessions. Oversized completed results may expire immediately from the
replay journal. Durable session history is independent of these recovery buffers.

One active request owns a conversation session. Another submission to that same
session receives `SESSION_BUSY` (HTTP 409), with its active run ID when available.
Separate sessions can run concurrently, up to the existing active-run limit.
Clients resume SSE by event sequence without resubmitting a run. Guest execution
leases expire after 45 seconds without host renewal; active commands are aborted.
Known-offline workspaces reject new user commands; requests already in flight
can reconnect under their original IDs. Accepted work can finish on an
online host while the viewing client disconnects, then be viewed on reconnect.

## Verification and first deployment

Automated coverage exercises encrypted pairing, tampering/wrong-scope rejection,
single-use invitations, secret exclusion, live shared data, same-session conflicts,
remote approvals, child delegation/artifacts, large transfers, reconnect deduplication,
revocation, executor opt-out, process restart and real macOS sandbox isolation.
Chromium covers workspace switching, defaults, separate drafts and direct connections.
A disposable real Redis test covers independent relay instances and retained delivery.

The remaining live acceptance step is a reviewed Vercel/TCP-Redis deployment with
your actual host and MacBook. Verify a model response, a simple approved file write
on each target, artifact download, concurrent separate sessions, bridge reconnect,
host-offline behavior and device revocation before depending on it. These checks
need your cloud account and second device; local tests do not claim to replace them.

Cloud-owned workspaces, offline editing, automatic conflict merging, browser-only
pairing, iOS, Keychain, role tiers, other deployment providers and privileged OS
maintenance helpers are deferred. The local HTTP service remains private-network-only.
