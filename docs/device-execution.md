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
an unattended restart. Configure a narrowly limited OS authorization locally;
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
