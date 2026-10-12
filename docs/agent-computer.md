# Agent computer

Each profile can have its own Linux computer: a Docker container on this device that the agent drives without approval prompts, with passwordless `sudo`. It is for installing packages, building, running scripts and long jobs, and producing files, without touching the user's own machines.

## Setup

Settings → **Agent computer** (Web UI, on the device that hosts the profiles):

1. **Docker** shows the detected runtime: OrbStack, Docker Desktop, Colima, or plain Docker. Install one if it says Docker is missing; start it if it says Docker is not running. The service looks for `docker` on `PATH` and in the usual install locations, so a launchd service without the shell `PATH` still finds it.
2. **Proxy** (optional): the HTTP proxy you use on this device, such as `http://127.0.0.1:7890`. The computers reach a proxy on this device's loopback as `host.docker.internal:<port>`. Leave it empty to connect directly.
3. **Base image** (optional, default `ubuntu:24.04`): use a mirror image name when Docker Hub is unreachable.
4. **Create** next to a profile. The first computer builds the image (about two to four minutes); later ones start in seconds. **Rebuild** rebuilds the image and recreates the computer; **Remove** deletes it. Both discard the computer's files.

Service API: `GET /v1/agent-computer`, `PUT /v1/agent-computer/settings`, `POST /v1/agent-computer/computers/:profile` (`{rebuildImage?}`), `DELETE /v1/agent-computer/computers/:profile`, and `DELETE /v1/agent-computer` (everything this configuration created). These routes are device-local: they are never forwarded through a workspace bridge.

## What the agent gets

A profile with a computer gets four tools; profiles without one do not see them.

- `computer_exec`: a bash command as the `agent` account in `/home/agent`, up to one hour, with combined output and the exit code. Cancelling the run kills the command inside the computer.
- `computer_write_file`: write a text file there.
- `computer_put`: copy a file or folder from the user's device into the computer (default `/home/agent/inbox/`). Reading the source follows the device's ordinary read approvals and run-scoped grants. Credential stores (`~/.ssh`, `~/.aws`, `~/.config/gh`, …), Marifold state, and any folder containing them are refused, even with approval. Limits: 512 MB and 20,000 files.
- `computer_get`: bring one file back as a downloadable run result (archive folders first).

Nothing inside the computer asks for approval. Everything that touches the user's devices still does.

The computer belongs to the device that hosts the profiles. In a workspace, a request that mentions the agent's computer ("use your computer…", "on your own Linux machine", "用你的电脑…") runs on the host under Automatic, even when sent from another device, and its results download on that device as usual. Runs that execute on another device do not get the `computer_*` tools; they are told to delegate to the host.

## Isolation

- **No host access:** no bind mounts, no Docker socket, not privileged, no host network. Marifold drives the container from outside with `docker exec`; no Marifold key, token, or service runs inside.
- **Network:** each computer sits on an internal Docker network with no route out. Its only exit is the egress proxy container (`EgressProxy`), which allows HTTP `CONNECT` and plain HTTP to public addresses and refuses loopback, private, link-local, CGNAT, ULA, documentation and reserved addresses in every spelling (IPv4 in IPv6, integer and octal forms), plus local names such as `localhost`, `host.docker.internal`, and `*.local`. In direct mode it connects to the exact address it checked. With a proxy setting it opens its own `CONNECT` tunnel to the checked host through your proxy, so a kept-alive connection cannot switch to an unchecked host. Root inside the computer has no route around it.
- **Residual risk:** with a proxy setting, your proxy resolves names itself. A name that resolves publicly for the egress proxy but privately for your proxy (DNS rebinding) could reach your local network through your proxy. Keep services on this device behind a token or bound to loopback.
- Tools that ignore `HTTP(S)_PROXY` (raw DNS, ssh, git over ssh) have no network. `apt`, `pip`, `npm`, `curl` and git over HTTPS use the proxy, including under `sudo` (`env_keep`).

Each computer is limited to 4 GB of memory, 2 CPUs and 2,048 processes. Everything Marifold creates carries `dev.marifold.computer.*` labels scoped to this configuration, and only labeled objects are listed or removed.

## Why containers, not a VM

A spike on OrbStack 2.2.3 (October 2026) found that an OrbStack machine created with `--isolated --isolate-network` still reaches the Mac's LAN address and other OrbStack machines, so a sudo-capable agent could read services listening on the Mac. A container on an internal network behind the egress proxy reached none of them, root included.

## Not yet

Snapshots, a terminal or file browser in the Web UI, creating a computer automatically for new profiles, and a CLI. The image includes Python, Node, git and build tools; heavier stacks (Playwright browsers, `uv`) are installed by the agent with `sudo` when needed.
