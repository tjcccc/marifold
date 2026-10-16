# Agent computer

The agent has its own Linux computer: one Docker container on this device that the agent drives without approval prompts, with passwordless `sudo`. It is for installing packages, building, running scripts and long jobs, and producing files, without touching the user's own machines. Each profile you give access works there in its own account and home folder.

## Setup

Settings → **Agent computer** (Web UI, on the device that hosts the profiles; other devices in its workspace see the same page with only **Give access** and **Remove access**):

1. **Docker** shows the detected runtime: OrbStack, Docker Desktop, Colima, or plain Docker. Install one if it says Docker is missing; start it if it says Docker is not running. The service looks for `docker` on `PATH` and in the usual install locations, so a launchd service without the shell `PATH` still finds it.
2. **Proxy** (optional): the HTTP proxy you use on this device, such as `http://127.0.0.1:7890`. The computer reaches a proxy on this device's loopback as `host.docker.internal:<port>`. Not set means a direct connection. Saving it takes effect at once: the egress container reads it from `~/.marifold/agent-computer-egress/upstream`, a folder mounted read-only into it, on every connection.
3. **Base image** (optional, default `ubuntu:24.04`): use a mirror image name when Docker Hub is unreachable. When Docker's own download of the base image fails (Docker uses its own network settings, not the proxy setting) and a proxy is set, marifold downloads the image from the registry through the proxy, checks every blob's digest, and loads it with `docker load`. A failed download says why, with the raw output under **Details**. With the proxy, package installs during the build also go through it, so the first build can take ten minutes or more.
4. **Create agent computer** builds the image (about two to four minutes) and starts the computer. **Rebuild** rebuilds the image and recreates the computer: home folders are kept, software installed outside them (for example with `apt`) is not. **Remove** deletes the computer with every account and file.
5. **Profiles**: the `default` profile is the agent itself. Its account, `marifold`, is created with the computer and always has access. For any other profile, **Give access** creates an account named after the profile, with the home folder `/home/<profile>`. **Remove access** takes the tools away and keeps the account and files, so giving access again finds them. **Remove account** deletes the account and its home folder.

Accounts follow their profiles: renaming a profile (`marifold profile rename`) renames its account and home folder, along with its sessions, task records, schedules and config references, and deleting a profile deletes its account. When the computer is unreachable at that moment, the change is applied on its next use. Accounts keep a fixed UID (from 2000) in `agent-computer.json`, so files keep their owner after a rebuild. All accounts have `sudo`, so they keep profiles tidy, not apart from each other.

New profile names must be valid account names: lowercase letters, numbers, `_` and `-`, starting with a letter, at most 32 characters; system account names such as `root`, `ubuntu` and `marifold` are reserved. An older profile whose name does not fit is told to rename itself before it can have an account.

Service API: `GET /v1/agent-computer`, `PUT /v1/agent-computer/settings`, `POST /v1/agent-computer/computer` (`{rebuildImage?}`), `DELETE /v1/agent-computer/computer`, `PUT /v1/agent-computer/profiles/:profile` (`{access}`), `DELETE /v1/agent-computer/profiles/:profile` (remove the account), and `DELETE /v1/agent-computer` (everything this configuration created, images included). Through a workspace, other full-member devices may use only `GET /v1/agent-computer` (its response carries `managedHere: false` for them) and `PUT /v1/agent-computer/profiles/:profile`; every other route answers 403 `HOST_ONLY_SETTING`. The check uses the bridge-authenticated sending device, so the host's own Web UI keeps full control through its hosted workspace. Executor-only devices cannot use the workspace API at all.

## What the agent gets

A profile with access gets four tools; other profiles do not see them.

- `computer_exec`: a bash command as the profile's account in its home folder, up to one hour, with combined output and the exit code. Cancelling the run kills the command inside the computer.
- `computer_write_file`: write a text file there.
- `computer_put`: copy a file or folder from the user's device into the computer (default `inbox/` in the account's home). Reading the source follows the device's ordinary read approvals and run-scoped grants. Credential stores (`~/.ssh`, `~/.aws`, `~/.config/gh`, …), Marifold state, and any folder containing them are refused, even with approval. Limits: 512 MB and 20,000 files.
- `computer_get`: bring one file back as a downloadable run result (archive folders first).

Nothing inside the computer asks for approval. Everything that touches the user's devices still does.

The computer belongs to the device that hosts the profiles. In a workspace, a request that mentions the agent's computer ("use your computer…", "on your own Linux machine", "用你的电脑…") runs on the host under Automatic, even when sent from another device, and its results download on that device as usual. Runs that execute on another device do not get the `computer_*` tools; they are told to delegate to the host.

## Isolation

- **No host access:** no bind mounts (only a named Docker volume for `/home`, stored inside Docker, not on the Mac), no Docker socket, not privileged, no host network. Marifold drives the container from outside with `docker exec`; no Marifold key, token, or service runs inside.
- **Network:** the computer sits on an internal Docker network with no route out. Its only exit is the egress proxy container (`EgressProxy`), which allows HTTP `CONNECT` and plain HTTP to public addresses and refuses loopback, private, link-local, CGNAT, ULA, documentation and reserved addresses in every spelling (IPv4 in IPv6, integer and octal forms), plus local names such as `localhost`, `host.docker.internal`, and `*.local`. In direct mode it connects to the exact address it checked. With a proxy setting it opens its own `CONNECT` tunnel to the checked host through your proxy, so a kept-alive connection cannot switch to an unchecked host. Root inside the computer has no route around it.
- **Through a proxy:** the egress resolves names itself, over DNS-over-HTTPS (`1.1.1.1`) through your proxy (local DNS may be poisoned where a proxy is needed), refuses private answers, and opens the tunnel to the checked IP address, so your proxy never resolves a name and DNS rebinding cannot steer it to your network. If DNS-over-HTTPS is unreachable it falls back to local DNS, still pinning the address. Proxy rules that match domain names do not apply, since the proxy sees addresses.
- **Delegation:** a run that can use the computer can still ask the user's devices for work with `delegate_device`, which always asks for approval; that prompt says the run also works on the agent computer, where downloaded content could try to steer it.
- Tools that ignore `HTTP(S)_PROXY` (raw DNS, ssh, git over ssh) have no network. `apt`, `pip`, `npm`, `curl` and git over HTTPS use the proxy, including under `sudo` (`env_keep`).

The computer is limited to 4 GB of memory, 2 CPUs and 2,048 processes. Everything Marifold creates carries `dev.marifold.computer.*` labels scoped to this configuration, and only labeled objects are listed or removed.

## Why containers, not a VM

A spike on OrbStack 2.2.3 (October 2026) found that an OrbStack machine created with `--isolated --isolate-network` still reaches the Mac's LAN address and other OrbStack machines, so a sudo-capable agent could read services listening on the Mac. A container on an internal network behind the egress proxy reached none of them, root included.

## Not yet

Snapshots, a terminal or file browser in the Web UI, giving new profiles access automatically, and a CLI. The image includes Python, Node, git and build tools; heavier stacks (Playwright browsers, `uv`) are installed by the agent with `sudo` when needed.
