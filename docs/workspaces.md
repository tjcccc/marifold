# Device-hosted workspaces

**Status: in testing (v0.76.0).** Local automated checks and paired Mac profile/avatar/session reads through an Aliyun ECS bridge over public HTTPS have passed, including Web UI refresh. The ECS update and seven concurrent original avatar downloads passed with matching file hashes and a responsive session list. Bulk speed is still connection-dependent: the live 3 MB burst took 54 seconds. Reboot recovery, live rollback and broader host–guest acceptance remain pending.

A disposable OrbStack Linux guest with a local HTTPS bridge and a private test tailnet passed file delegation in both directions, bridge execution while Tailscale was stopped or failed to start, tunnel recovery, and guest-service reconnection. The model was mocked; bridge transport, filesystem operations and Tailscale were real. A subsequent full-access test performed daemon restart, reported an injected startup failure, and recovered the daemon through approved Marifold shell jobs. Scoped Linux shell execution remains refused because its sandbox adapter is not implemented. This does not validate restarting Tailscale on a remote Mac or prove that a particular device's bridge route is independent of its VPN/proxy settings.

A workspace belongs to one person. Hosting shares this device's existing local `.marifold` configuration, profiles, sessions, Skills, Apps and schedules. The host retains the model credentials and authoritative data. A guest joins a live view; it does not copy the host's database or become another host when disconnected.

The host and every guest must run the exact same Marifold release. An invitation from a different release is rejected before pairing. Existing pairings remain unavailable after one device updates until the other device updates too; the Web workspace control shows a version mismatch warning. Update all devices together.

Each Mac runs `marifold service`. CLI, TUI and the service-hosted Web UI use that local service's outbound bridge connection, so neither Mac needs an inbound port or Tailscale. Browser-only pairing and native iOS clients are future work.

## Setup

Deploy a bridge once. On Cloudflare (free plan, no server):

```sh
marifold workspace bridge deploy cloudflare
```

It signs in to Cloudflare in the browser on first use, deploys the Worker with a generated registration token, and prints the bridge URL; `workspace create` and the Web UI on the same device then use the deployed URL and saved token automatically. On a Linux server with Docker, run `marifold workspace bridge install` there instead. See the [bridge README](../apps/bridge/README.md) and the [hosting guide](../apps/bridge/HOSTING.md) for both, updates, and moving a workspace to another bridge.

On the host:

```sh
marifold service start --daemon
marifold workspace create Home --bridge https://marifold-bridge.you.workers.dev
# Enter the bridge registration token unless this device deployed the bridge. marifold prints a single-use invitation.
```

On the other Mac:

```sh
marifold service start --daemon
marifold workspace add https://marifold-bridge.you.workers.dev --executor
# Enter the invitation. Omit --executor for a viewing/requesting device.
marifold workspace default Home
```

The Web UI's **Workspace** control offers Host this device, Join workspace, rename, invitations, device revocation, executor opt-in and a startup default. **Direct servers** preserves existing private-network connections and tokens. Web workspace pairing uses the service that hosts the page; open each Mac's own Web UI to pair that Mac. A remote browser is not itself an execution device.

CLI management:

```sh
marifold workspace list
marifold workspace rename --id <workspace_id> "Home studio"
marifold workspace invite <name_or_id>
marifold workspace invite <name_or_id> --executor-only
marifold workspace devices <name_or_id>
marifold workspace executor <name_or_id> on
marifold workspace executor <name_or_id> off
marifold workspace revoke <name_or_id> <device_id>
marifold workspace default local
marifold workspace remove <name_or_id>
```

`remove` stops sharing a hosted workspace or disconnects this guest, while preserving local profiles and sessions. An offline guest can disconnect locally; the host may still list its old identity until it is revoked there. Stopping an offline host removes its local keys but cannot update an unreachable relay until a separate administrative cleanup. Never reuse those removed keys.

The TUI switches among already-paired workspaces:

```text
/workspace list
/workspace join Home
/workspace leave
/device list
/device use host
/device use <device name or id>
/device use auto
```

In a joined workspace, typing `@` in the TUI offers the workspace's online executors, as the Web composer does, and an `@device` mention in a message runs it on that device. In Local the TUI runs on this device only, so a message naming a workspace device is refused with the `/workspace join` command to use.

Agent/ask commands and schedule management accept workspace selection:

```sh
marifold agent --workspace Home "Summarize a document on this device."
marifold agent --workspace Home --device host "Create a report on the host."
marifold agent --workspace Home --device <device_id> --cwd /path/on/that/device "Review this project."
marifold ask --workspace Home "Hello"
marifold schedule --workspace Home list
```

Without `--workspace`, these use the configured startup default. Other standalone CLI configuration/profile commands retain their local behavior; shared profile, Skill and configuration management is available in the paired Web UI and TUI. A new guest needs no local provider authentication to use a configured host model. Local remains the fallback when the default workspace is unavailable at startup, except that `marifold --resume` and `marifold --sessions` stop with an error instead: Local's sessions are not a stand-in for the default workspace's. Clients briefly allow connections to initialize first. An explicitly selected offline workspace reports an error. A disconnected active conversation stays in its workspace, including its draft, and never silently submits work to Local.

## Bridge proxy settings

Each device chooses **Direct** (the default) or an HTTP(S) proxy for each local workspace connection, for example when `*.workers.dev` is unreachable from that network. Home and office can use different settings for the same bridge.

```sh
marifold workspace create Home --bridge https://… --proxy http://127.0.0.1:7890
marifold workspace add https://… --proxy http://127.0.0.1:7890
marifold workspace proxy Home http://127.0.0.1:7890   # change later; "direct" clears it
```

The Web UI offers the same field when hosting or joining, and as **Bridge proxy on this device** in each workspace's settings. The proxy covers registration, pairing, the WebSocket and every reconnect; changing it reconnects at once. It is device-local: stored with this device's connection, never synchronized from the host or sent to the bridge, and shown without credentials. Re-pairing keeps the saved proxy unless a new one is given. Model-provider proxies and `HTTPS_PROXY` do not apply to bridge connections. TLS to the bridge runs inside the proxy's CONNECT tunnel, so the proxy sees only the bridge hostname.

## Execution and paths

Requests about the agent's own computer ("use your computer…") run on the host, which drives it; see `docs/agent-computer.md`.


The host owns each model call and conversation. Every ordinary agent run records three independent identities:

```json
{
  "workspaceId": "home",
  "originDeviceId": "office",
  "executionDeviceId": "macbook"
}
```

Origin comes from authenticated membership, not client-supplied device metadata. For ordinary guest requests, Automatic uses the guest if its executor is enabled; otherwise it uses the host. Skills are installed on the host, so Automatic also uses the host for a request that names a skill together with a management verb (install, update, remove, configure, set up, or their Chinese equivalents such as 安装 or 配置); merely using a skill stays on the guest. Source paths in such a request belong to the host unless the user names a device: "install abc from @office's ~/skills/abc" (`@device` after "from" or 从 in an install or update request, or "from my current device's …") still runs and installs on the host, but `manage_skill` reads the source on that device through its executor (`source_device`; executor opt-in required, one approval in the conversation, bounded to 100 regular files and 2 MB, no symlinks, never Marifold state or credential stores) and reports which device it read from. Runs are told which device sent the request, so "my current device" resolves. An `@device` mention without skill management still runs on that device, and an explicit device selection still wins; a guest run asked to manage skills is told to delegate that work to the host. Host runs change skills with `manage_skill`, whose `inspect` action lists installed skills without a prompt and whose `configure` action writes one skill-local dotfile or `*.toml` file (such as `.vars-path.toml`), optionally copied from another installed skill. A selected unavailable/disabled device fails explicitly. One execution device is fixed for the entire run. Its OS, architecture, home, working directory and capability set govern its tools. Provider authentication stays on the host; guest shell environments never inherit host secrets.

Marifold state (`~/.marifold`) follows who sent the request. A run on a device for its own local request has no hard block there: each access asks for approval and can never become an "always" or folder grant (unlike other sensitive account data such as `~/.ssh`, whose reads a profile may allow persistently). A run requested from another workspace device (a guest's request running on the host, or a host run executing on a guest) may read `profiles/`, `skills/`, `apps/`, `schedules/`, `tasks/`, `prompts/` and `runs/` (and their configured `[paths]`) with approval for each access, and never write them; everything else there, including `config.toml`, `workspaces/`, `service/`, `bridge/` and the sessions database, stays blocked even with approval. A run on an executor-only device keeps all of its Marifold state blocked. A request that names `~/.marifold` runs on the host, where the profiles and skills live, unless a device is selected.

For natural-language requests such as “ask my home Mac to create a report”, the model can call `delegate_device` with an online device name or ID. This requires approval and starts one child in the same workspace, using the same profile/model. The child cannot delegate again. Child approvals, clarifications, results and artifacts appear in the parent conversation. Cancelling the parent cancels its children. Revoking a device cancels active workspace runs involving that identity.

Local conversations on a device hosting a workspace also receive these device tools, including when the startup default is Local. Home can delegate to an opted-in guest through the bridge without SSH or Tailscale. Joining another workspace does not attach local conversations to it. Delegation retains the guest's local execution policy. See [device execution](device-execution.md) for locally enabled full access and durable jobs.

Device context identifies the workspace name, its host, the requesting device, and the execution device separately. A request for the workspace's home desktop targets its host; “my current device” means the requesting device. When these targets differ from the execution device, the agent must delegate the work or ask for clarification before acting.

Guest execution is an explicit, locally revocable opt-in. It supports the dedicated file tools (read, write, copy, create folder, move/rename, trash), attachment inspection and the existing macOS shell sandbox. A separate local full-access opt-in enables approved shell commands with the execution account’s OS permissions on macOS and Linux. All workspace devices belong to one owner, so guest calls follow the same file policy as the host (see `docs/architecture.md`, Agent tools): the guest assesses each call on its own filesystem and the requesting profile's approval settings decide. Ordinary file work inside the guest's home runs without a prompt, overwritten and trashed items go to the guest's Trash, and sensitive reads, writes outside home or to startup configuration, and full-access or sudo commands ask as they would on the host. The guest's own `deny` settings and hard blocks (Marifold state, protected system paths) still win, and nothing the host sends widens the guest's sandbox: a run carries only the requesting profile's home-relative trusted folders (`~/…`, and `~` for script home writes), which the guest checks against its own home and refuses when they leave home or cover credential stores, Marifold state or startup configuration. The guest adds its own global trusted folders; its own `~` never applies to delegated runs. An "Always allow reading `~/.ssh`" answer is stored home-relative on the profile, so it applies on every device. An approval left unanswered for five minutes stops the run. Uploading an attachment grants ID-scoped `inspect_attachment`, `read_attachment`, and `search_attachment` access without another prompt, as on the host. Inspected guest images return bytes to the host's model, never guest-local image paths. Disabling this device's executor cancels its active agent runs; already-started full-access jobs continue to completion. Pairing alone does not enable shell or filesystem execution.

Skills, SkillApps and schedules run on the host in this version. Their paths retain host meaning. An image Skill configured to output under the host's home directory writes there, without replacing usernames or translating absolute paths. For an ordinary guest execution, paths instead belong to that selected guest. The service never interprets a requesting device's path as an upload; attachments carry bytes.

Each model turn receives a small environment block with the runtime time, timezone, client interface (`terminal`, `web`, `desktop`, or `mobile` when known), and whether the request is local or remote to the workspace host. The connection establishes origin; client text cannot change it. Device inventories are fetched with `list_devices` only when needed, and `delegate_device` accepts `host` or a resolved device name/ID. Delegated runs preserve the originating interface and timezone. Terminal replies report execution-device paths; graphical clients use file cards and previews. A remote path is not a file saved on the browser device.

Regular files in a run's output directory become authenticated downloadable artifacts. Files deliberately written elsewhere stay on that execution device and are not automatically copied. Download controls save files on the computer running the browser. They do not run a file-copy command on the workspace host. Files appear in cards below the final answer; PNG/JPEG/WebP outputs show thumbnails with full-resolution viewing and download controls. Working details remain collapsible above the answer. A download click creates a short-lived scoped URL on the connected service, then the browser streams it directly and shows normal download progress. Thumbnails are resized on the source device before transfer. Completed artifact references persist separately from live run diagnostics and are restored when a session is reopened. Published output files survive the 24-hour cleanup of temporary run state and remain stored until explicitly removed from the output device. Execution capabilities and grants are never reconstructed. Downloads still require the relevant host and output device to be reachable; files or references removed by older versions cannot be recovered automatically. If a retained file expires or is removed, its filename and disabled Download entry remain visible with an unavailability notice. The browser checks file availability when reopening the conversation. Offline devices remain retryable and are not labeled expired.

Scoped execution cannot read another workspace's control state, credentials or local Marifold data, and scoped shell processes have no general network or desktop control. Explicit full-access commands use the destination account's permissions, including access to its data and network; administrator and macOS privacy grants remain OS requirements. The dedicated remote Python package tool remains outside this executor scope. Existing host Skill/package-install capabilities are unchanged.

## Data, pairing and isolation

A configuration can host its existing local workspace once and join multiple other workspaces, including ones on different bridges. Each connection has distinct keys and a distinct workspace ID. The host's API exposes only its own application resources; nested workspace APIs and device-local settings are rejected. UI drafts, routes and cached views are scoped by connection. Appearance stays a local UI preference. Provider key values never appear in the shared configuration response.

State lives below `<config directory>/workspaces/<config filename hash>/`:

- `control.db`: connection metadata, invitation verifiers, host-signed memberships, operation journals and recent run events. Files are owner-only; the enclosing workspace directory is mode 0700.
- `<workspace id>.credentials.json`: independent signing/encryption private keys, atomically replaced in a mode 0600 regular file. Symlinked or group/world-readable credential files are rejected. Keychain support is deferred.
- `runs/`: isolated guest execution directories and output files.
- `service.lock`: prevents two live services from coordinating the same config. A dead process's lock is recovered; a live process's lock is not replaced.

An invitation embeds the bridge URL and pinned host public identity plus a random 32-byte secret. Only its verifier is stored by the host. It expires in 15 minutes and is consumed by successful pairing. Creating another invitation invalidates unused prior invitations, without changing already-paired device keys. Each paired device receives its own host-signed membership. Use `revoke` to invalidate that device separately. Recover lost device keys by revoking and re-pairing; there is no shared permanent guest token. A revoked device retains its saved workspace; use **Rejoin workspace** with a fresh host invitation to replace the unavailable pairing without disconnecting it first. Revoking the current device in the Web UI opens the invitation form automatically. Invalid invitations leave the saved pairing intact; an active pairing or a locally hosted workspace cannot be replaced by joining. All paired devices belong to the same owner and can manage the shared workspace, except executor-only devices.

An executor-only invitation (`invite --executor-only`, or `{"access":"executor"}` on the `invite` operation) pairs a device that only runs work the host sends it: a headless machine where untrusted software could read the device key. (The agent computer does not pair at all; see `docs/agent-computer.md`.) The access is stored in the host-signed membership and taken from the host's invitation record, never from the joining device. The host refuses every bridge operation from that device except status and leaving: it cannot read sessions, runs or files, start runs, invite, rename, revoke, or list devices, even with its own key. Its executor is on from pairing. The device list labels it "executor only". A host run executing on it still has the host's tools, including `delegate_device`. Other permission roles are deferred.

Do not copy live workspace state between Macs: it would duplicate device identity and undermine delivery coordination. Back up the host's data and credential files securely for disaster recovery; pair additional devices instead of cloning them.

## Transport and interruptions

The bridge is a relay, with no model runtime or application API. Both endpoints connect outbound over WSS. HPKE (P-256, HKDF-SHA256, AES-256-GCM) protects content; Ed25519 endpoint signatures and authenticated headers bind workspace, sender, recipient, message ID and expiry. Membership verification pins the host identity. The relay sees public identities, routing, timing and packet sizes. It does not receive decrypted conversations or provider keys.

The bridge is one relay instance with SQLite state (a Durable Object on Cloudflare). A frame delivered to an online device waits in memory up to five seconds for its acknowledgment and is stored only if the ack is late or the device disconnects; frames for an offline device are stored at once. Stored inboxes hold at most 128 encrypted frames per recipient for five minutes, and a full inbox closes the sender with code 1013 (retry later). Messages expire after one minute. Large application payloads use authenticated chunks with acknowledgment, transfer-size limits and assembly expiry. Updated devices negotiate four chunks in flight per transfer, with eight bulk chunks total per connection; ordinary requests do not wait for a whole file transfer. Older receivers and relays retain sequential delivery. The relay delivers each inbox entry once per connection, replaying unacknowledged entries after reconnect instead of repeating them on every publish. Artifact downloads request up to 128 KiB per read with four reads ahead, preserving byte order and bounded memory; older hosts fall back to 32 KiB reads. The bridge database must persist host registrations and revocations.

An operation has a stable request ID and input hash. The receiving endpoint journals mutations before execution. Reconnection resends the same operation ID; completed results replay without repeating the effect. Reusing an ID with changed input is rejected. A process restart marks unfinished requests as interrupted/unknown; it never starts their model/tool loops again. Uncertain remote tool outcomes stop the run rather than invite the model to repeat an effect automatically.

Result payloads and recent run recovery have a 24-hour retention window (with bounded event buffers). Old request tombstones remain so expired IDs cannot execute again. Each service control journal caps accepted mutation IDs at 100,000 and fails closed at capacity; creating/re-pairing a new workspace preserves the host's normal profiles and sessions. Oversized completed results may expire immediately from the replay journal. Durable session history is independent of these recovery buffers.

One active request owns a conversation session. Another submission to that same session receives `SESSION_BUSY` (HTTP 409), with its active run ID when available. Separate sessions can run concurrently, up to the existing active-run limit. Clients resume SSE by event sequence without resubmitting a run. Guest execution leases expire after 45 seconds without host renewal; active commands are aborted. Known-offline workspaces reject new user commands; requests already in flight can reconnect under their original IDs. Accepted work can finish on an online host while the viewing client disconnects, then be viewed on reconnect.

## Verification and first deployment

Automated coverage exercises encrypted pairing, tampering/wrong-scope rejection, single-use invitations, secret exclusion, live shared data, same-session conflicts, remote approvals, child delegation/artifacts, large transfers, reconnect deduplication, revocation, executor opt-out, process restart and real macOS sandbox isolation. Chromium covers workspace switching, defaults, separate drafts and direct connections. The bridge tests cover replay after reconnect, a relay rebuilt between frames (Durable Object hibernation), revocation and backpressure; the same paired-device flow runs against the Cloudflare Worker under `wrangler dev`. Proxy tests tunnel registration, pairing and TLS through a local CONNECT proxy.

The remaining live acceptance step is a Cloudflare deployment with your actual host and MacBook. Verify a model response, a simple approved file write on each target, artifact download, concurrent separate sessions, bridge reconnect, host-offline behavior and device revocation before depending on it. These checks need your cloud account and second device; local tests do not claim to replace them.

Cloud-owned workspaces, offline editing, automatic conflict merging, browser-only pairing, iOS, Keychain, role tiers, other deployment providers and automatic installation of privileged OS helpers are deferred. The optional standalone Tailscale workflow uses existing OS permissions; see [device execution](device-execution.md). The local HTTP service remains private-network-only.

Web avatar saves crop to 512px and compress as WebP at quality 85, preserving transparency (PNG fallback where WebP encoding is unavailable). Existing saved avatars remain unchanged. Displays use 256px WebP thumbnails to keep image traffic from delaying workspace navigation. Other file transfers preserve original bytes. Transcript images request host-generated WebP thumbnails (up to 480px and 80,000 bytes); opening the image viewer still fetches the stored image. Executor requests, including attachment preparation and transfers, have a 120-second deadline and retain the same request ID across recovery. Bridge reads have a 60-second deadline; a connected-host timeout reports `WORKSPACE_TIMEOUT` (HTTP 504), distinct from `WORKSPACE_OFFLINE` (HTTP 503). Recovered connections refresh navigation metadata and other data views. Open conversation transcripts stay unchanged; reload the page or reopen the session to see messages and runs started on another device. Runs already followed by that view continue streaming.


## Experimental direct file downloads

The WebRTC experiment is **off by default**. It changes only remote original-file downloads, not pairing, model requests, thumbnails, or the compressed image viewer. Both the requesting service and the file's source service must run this build with `MARIFOLD_EXPERIMENTAL_WEBRTC=1`. For guest-owned files reached through the host, enable it on the host as well. No bridge redeployment is required.

For a source checkout, build once with `pnpm install && pnpm -r build`. Stop an existing managed service before starting a foreground test instance. On both Mac and Fedora, run from the updated checkout:

```sh
MARIFOLD_EXPERIMENTAL_WEBRTC=1 pnpm marifold service start
```

Keep the usual config/host/port options if your installation needs them. The experiment does not open a public HTTP listener, change firewall rules, or install a VPN. It opens WebRTC UDP sockets and uses ICE/STUN; existing VPN routing and network restrictions can prevent a direct path. The default discovery server is `stun:stun.l.google.com:19302`. Set `MARIFOLD_WEBRTC_STUN_URL=stun:hostname:port` locally on each service to use another reachable STUN server. This setting is not synchronized. Only STUN URLs are accepted; no TURN relay is added. STUN sees network addresses, not file contents. Connection descriptions, including DTLS fingerprints, travel over the existing authenticated, encrypted workspace RPC. The source resolves only already-published artifact IDs within that workspace.

The initial experiment supports files up to 64 MiB, four active/pending downloads per service, a 15-second negotiation/idle deadline and a two-minute transfer limit. Larger files, unsupported/disabled peers, connectivity failures, changed sources, checksum mismatches and timeouts fall back to the existing bridge path. Files stream in bounded 16 KiB data-channel messages with 512 KiB credit windows. The receiving service stages a private temporary copy and checks its length and SHA-256 before serving it to the browser. Therefore browser download progress starts **after** the direct transfer completes. Temporary files are removed when the response closes; interruption, membership removal and service shutdown close active transfers. An abrupt process kill can leave private temporary files in the OS temporary directory. There is no persistent original-file cache or resume yet.

To test from Fedora:

1. Open the paired workspace and download an existing image/file from the Mac.
2. In browser developer tools, preserve the Network log and inspect the `/v1/downloads/...` response. `X-Marifold-Transfer: webrtc` confirms direct file delivery. `bridge` means fallback; `X-Marifold-Direct-Fallback` distinguishes a disabled experiment from an unavailable direct connection.
3. Compare the same file with the experiment disabled, timing from the click through completion. Check the saved file's size/hash, not just the transfer label. Try both normal and VPN-connected networks.
4. If connectivity or performance is worse, stop the test service and restart without `MARIFOLD_EXPERIMENTAL_WEBRTC`, or set it to `0`. The existing bridge behavior returns without re-pairing or changing the bridge server.

Local tests cover real data-channel transfer, bounded negotiation, cancellation, source changes, authenticated workspace routing, and old-peer bridge fallback. They do not establish cross-network performance or Fedora/VPN compatibility.
