# Device execution

Local and bridge-delegated agents share the same `shell_exec` implementation.
The destination device decides whether full access is available. Pairing,
executor opt-in, and approving a command do not enable full access themselves.

## Enable on the test Mac

Install the same build on Home and the MacBook Pro and restart their Marifold
services to load it. Then run this **locally on the MacBook Pro**, using the
config that its Marifold service uses:

```sh
marifold execution mode
marifold execution mode full
```

For a nondefault config, put `--config /absolute/path/config.toml` before
`execution`. The setting is per device/config, outside shared configuration and
HTTP configuration APIs. A service restart is not required. Guest executor opt-in
is still required for delegation.

Ask Home: “On my MacBook Pro, check the execution mode, then use full access to
run `id -un` and `uname -s`. Retrieve the job result.” Approve the command in the
requesting conversation. Test this harmless operation before a network restart.
The result must identify the MacBook Pro's OS account and platform.

To disable future full-access commands:

```sh
marifold execution mode scoped
```

Revocation does not interrupt already-started jobs. Cancelling a conversation or
disabling the guest executor likewise does not kill these jobs halfway through
an operation. Stop a running process locally if that is explicitly needed.

## Capability and approval

- `shell_exec` defaults to `access: "scoped"`, preserving the existing sandbox.
- `shell_exec` with `access: "full"` runs `/bin/sh` as the Marifold OS account on
  macOS or Linux. It inherits that process's environment and can access its files,
  network, processes, applications, and credentials. Full access is a trust grant
  for that account; scoped protections of Marifold state and attachments do not
  constrain an approved full-access command.
- Full-access calls require individual approval, even when shell policy is
  `allow`. They cannot persist an “Always” or “Trust” grant. Shell policy `deny`
  still blocks them, and unattended runs without an approval handler fail closed.
- Full access does not grant root, macOS Automation, Accessibility, or Full Disk
  Access permissions. Configure required OS permissions on the execution device.
  Marifold does not collect administrator passwords or install sudo privileges.
- Dedicated file and attachment tools retain their existing scope. Use an
  explicitly approved full-access shell command for broader device operations.

Full access is never an automatic fallback for a missing sandbox. Linux scoped
shell execution remains unsupported; Linux full access requires the same explicit
local opt-in and per-command approval as macOS.

## Durable jobs and reconnects

A full-access call returns a job ID after recording its request and starting a
detached local worker. `shell_job_status` with `job_id` returns completion and
bounded output; `wait_seconds` can wait up to 10 seconds. Without an ID it reports
the execution mode and the 20 latest jobs. Retrieve completion before reporting
that the requested operation succeeded.

The local CLI provides the same read-only inspection:

```sh
marifold execution jobs
marifold execution jobs JOB_ID
```

Jobs continue through bridge loss or conversation cancellation, have a 10-minute
execution limit, and retain up to 128k characters of combined output. Commands
and output can contain sensitive data; the job directory is local and private.
The submitted command is removed after the worker reads it, while its SHA-256
hash and timestamps remain for identifying an uncertain submission. Environment
values are not serialized into job files.

A missing worker or stale startup is reported as `unknown`, never success. Do
not resubmit an uncertain command automatically: reconnect to the same execution
device, inspect recent jobs and actual device state first. A transport request
grant is consumed once. Separate, newly approved calls are separate jobs.

The worker is not an OS recovery daemon. Power loss, reboot, killing its process,
or a service manager terminating the entire service process group can interrupt
it. There is no automatic replay on startup. Output files from jobs finishing
after their originating agent run ended may require a new run to retrieve them.

## Choose a device with @

In the Web composer, type `@` at the start of a message to list online devices
with execution enabled in the current workspace. Type part of a name to filter;
use the arrow keys and Enter/Tab, or click, to insert it. For example:

```text
@STJC-M1P-2.local use sudo_exec to run id -u, then retrieve the result.
```

The service resolves the mention to a device ID before starting the run. It
applies to that message and overrides the default execution-device selection.
The original message remains in history. Unknown, ambiguous, offline, or
execution-disabled targets fail without falling back to Home. The list refreshes
every ten seconds; the service checks availability again at submission.

Names with spaces use `@"Office Mac"`. Duplicate names use the device ID in the
completion, with the device name displayed alongside it. A bare name without
`@` remains ordinary natural-language input. Mentions select devices within the
current workspace; they do not switch workspace connections or grant access.
Start a new turn after the current run finishes (or stop it) to select another
device. Use a plain task after the mention; `/commands` and `$skills` remain
separate leading-token actions.

## Password authorization from the requesting device

For a privileged task, the agent uses `sudo_exec` with the exact command to run
as root on the destination. The destination must have full execution enabled,
its shell policy must permit individual approval, and its OS account must be
allowed to use sudo. The general command runner invokes a root `/bin/sh`, so a
sudoers rule permitting only a specific executable will not authorize it.
Marifold does not change sudoers. Ordinary user operations continue through `shell_exec`.
If an existing OS policy already authorizes a noninteractive command, the agent
can use an approved full-access shell command; `sudo_exec` explicitly requests a
fresh password each time it is used.

The Web UI displays a password field in the approval dialog on the device where
you sent the request. It identifies the target hostname, target OS account, and
command. Enter **that target account's password**, not the requesting device's
password. TUI and CLI clients collect it privately on the requesting terminal.
The password is never requested in chat or through `ask_user`.

The requesting client encrypts the password for an ephemeral RSA-OAEP/SHA-256
key generated on the target. Authorization is bound to the command and a unique
challenge, expires after five minutes, and can be consumed only once. The host
model never receives the credential. The bridge sees encrypted traffic; the
workspace host relays an encrypted password when the target is another device.
The target decrypts it only at execution and pipes it directly to the detached
worker, which supplies it to `sudo -k -S`. The command itself receives `/dev/null`
as stdin, including when sudo's policy does not consume a password.

No plaintext password is written to Marifold configuration, task state,
transcripts, events, job records, command arguments, environment, or logs. The
worker does not update sudo's authentication cache. Password buffers are cleared
when consumed; client text fields are cleared on submission/cancellation and
references are discarded. JavaScript does not guarantee immediate erasure of
all temporary string copies from physical memory. Passwords are limited to 128
UTF-8 bytes without NUL or line breaks.

Wrong passwords produce a failed job, with no automatic retry. A new privileged
attempt requires a new approval and password. Cancellation before submission or
expiry prevents execution. After acceptance, the existing durable-job behavior
applies: cancelling the chat does not kill an already-started privileged command.

Web password entry requires HTTPS or localhost (Web Crypto); there is no
plaintext fallback. Non-TTY CLI clients and older clients without secure
credential support fail closed. Telegram has no password collection UI and
cannot authorize these calls. This flow uses the target account's normal sudo
policy; it cannot replace Accessibility, system-extension approval, hardware
security keys, interactive multi-factor PAM conversations, or other local OS
consent mechanisms.

To test from Home: “On my MacBook Pro, use `sudo_exec` to run `id -u`, then
retrieve its job result.” Approve on Home and enter the MacBook Pro account's
password there. A successful result is `0`. Test a harmless command before
restarting networking. Install the new build on the host, target, and requesting
client/service so all three understand the credential channel.

## Standalone macOS Tailscale test

The optional workflow supports the app downloaded from tailscale.com, with
bundle ID `io.tailscale.ipn.macsys`. It uses Tailscale's documented
[`down-for-update`, `rungui`, and `up` sequence](https://tailscale.com/docs/integrations/mdm/mac).
It does not use the App Store variant or Linux daemon commands.

First run the read-only preflight on the MacBook Pro:

```sh
marifold execution tailscale check
```

It verifies the bundle and signature and checks existing noninteractive sudo
authorization for exactly:

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale down-for-update
```

If it reports that a password is required, full access alone is insufficient for
an unattended restart. The new `sudo_exec` dialog supports individually approved
privileged commands with a password; it does not populate a sudo cache for this
noninteractive CLI helper. To use the helper unchanged, configure narrowly
limited OS authorization locally;
do not grant unrestricted passwordless sudo or run the whole service as root.
A temporary interactive sudo authentication may not apply to the service's
noninteractive session. The preflight does not change permissions.

Keep the MacBook Pro physically accessible during the first restart test. Verify
that its bridge and model traffic can reach the internet independently of
Tailscale, including any proxy, DNS, or exit-node dependency. A separate bridge
URL by itself does not establish that independence.

After preflight succeeds, ask Home to run the following **on the MacBook Pro via
`shell_exec` with `access: "full"`**, then retrieve the durable job result:

```sh
marifold execution tailscale restart
```

The workflow checks permissions before stopping, attempts app startup and `up`
even if the stop command fails or times out, and retries startup once. Recovery
never repeats the stop. Each subprocess is limited to 20 seconds. `restarted`
reports stop/start command success; `vpnReady` reports `BackendState=Running`,
not proof that another device is reachable. Verify connectivity separately.
No restart can guarantee recovery from every OS, authentication, or network
failure; this workflow does not survive a device reboot.

The macOS restart sequence is covered with command mocks; real standalone-app
restart acceptance remains the MacBook Pro test. The full-access executor is
covered by actual detached-process tests and bidirectional local bridge tests.
A disposable OrbStack Linux guest also passed real Tailscale daemon restart,
startup-failure reporting, and recovery through Marifold full-access jobs over a
local TLS bridge. Its private Headscale test tailnet verified outage and recovery;
an additional forced bridge socket disconnect confirmed job continuation and
subsequent bridge execution. This does not verify macOS app behavior or the
production Aliyun route.
