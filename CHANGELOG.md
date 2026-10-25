# Changelog

User-facing changes in each version of marifold published to npm, newest first. Versions that were never published are folded into the next published one. The detailed development log is [DEVLOG.md](DEVLOG.md); longer notes for GitHub releases are in [docs/releases](docs/releases/README.md).

Devices paired in a workspace must run the same version, so update them together.

## [0.96.0] - 2026-10-25

Covers 0.95.1–0.96.0. [Release notes](docs/releases/v0.96.0.md).

### Added

- `marifold workspace bridge deploy cloudflare` deploys your workspace bridge to Cloudflare Workers (free plan) in one command and saves its URL and registration token on that device. `marifold workspace create <name>` and the Web UI's host form on that device use them automatically.
- A bridge proxy per device and workspace: `--proxy` on `workspace create` and `add`, `marifold workspace proxy <workspace> <url|direct>`, and a proxy field in the Web UI. It covers registration, pairing and the connection, and is stored only on that device.

### Changed

- The bridge stores its state in SQLite (a Durable Object on Cloudflare, or a file next to Node) instead of Redis. Messages acknowledged within five seconds are never stored.
- The Linux installer (`marifold workspace bridge install`) no longer sets up Redis; data lives on a Docker volume.

### Removed

- The Redis bridge store and the Vercel deployment.

### Fixed

- Images attached in the TUI while connected to another device's workspace are sent correctly.

### Upgrading

- A workspace on a 0.70–0.95 bridge has to be created again on the new one: `marifold workspace remove` and `create` on the host, then `remove` and `add` with a fresh invitation on each guest. Profiles and sessions stay on the host.
- Linux bridges installed by 0.95 and earlier are refused by `marifold workspace bridge update`; remove them and install again.

## [0.95.0] - 2026-10-20

Covers 0.91.0–0.95.0.

### Added

- `copy_file` tool for copying text or binary files, including results of earlier runs.
- In a workspace, other devices can read the host's marifold profiles, skills, apps and schedules with approval each time; configuration, keys and sessions stay blocked.
- Settings → Agent computer is visible from other workspace devices, with Give access / Remove access.
- TUI: `@` offers the workspace's devices, and `/device use` accepts a device name.

### Changed

- **Think is now Deep**, a single global switch (`[default].deep`, `/deep`, `ask --deep`, SkillApp `{ deep }`). On asks the model for medium effort, off for low; it is no longer set per profile.
- A profile's model is one line in `profile.toml`: `model = "provider/model"`, or `model = "default"` to follow the global default.
- Renaming a profile keeps its sessions, schedules, tasks and agent computer account.
- Trust is offered only for a folder that is safe to trust.
- Saving the agent computer's proxy takes effect immediately.

### Fixed

- ChatGPT token refresh and sign-in use the provider's proxy.
- Requests that mention `~/.marifold` or the agent computer run on the workspace host.
- In Local mode the TUI refuses an `@device` mention instead of running the task on this device.

### Upgrading

- Run `marifold doctor --fix` once: it renames `think` to `deep` in `config.toml` and installed SkillApps, removes per-profile Think, and rewrites profile models to the one-line form, with backups.
- Sessions orphaned by a rename on an older version come back with `marifold profile rename <old> <new>`.

## [0.90.1] - 2026-10-13

Covers 0.86.0–0.90.1.

### Added

- **The agent computer:** a Linux container (OrbStack, Docker Desktop, Colima or Docker) where the agent works without approval prompts. Each profile with access gets its own account and home folder, kept across rebuilds. Network access goes only through a filtering egress proxy, optionally through your own proxy. Tools: `computer_exec`, `computer_write_file`, `computer_put`, `computer_get`.
- Executor-only devices: `marifold workspace invite <workspace> --executor-only` pairs a device that only runs work the host sends it.
- Approvals can allow a folder for the rest of the run ("Allow folder for this run", `r` in the TUI).
- Skills can be installed, updated and configured from any workspace device; the change happens on the host, and the source can be another device (`from @office's ~/x`).

### Changed

- An approval left unanswered until it times out stops the run instead of being denied silently.
- New profile names must be valid Linux usernames (lowercase letters, numbers, `_`, `-`).

### Upgrading

- Per-profile computers from 0.89 are replaced by the single agent computer when you create it.

## [0.85.0] - 2026-10-10

Covers 0.81.1–0.85.0.

### Added

- `marifold --sessions` opens the TUI on the session picker; TUI `/takeover` moves a session taken elsewhere back.
- TUI `/btw <question>`: a side question about the conversation that is never saved.
- Session archive: archived sessions refuse new turns, with Unarchive in the Web UI and `/archive`, `/unarchive`, `/resume --archived` in the TUI.
- Profile memory works in agent runs; Web Config can show and restore forgotten memories.
- Later turns can look at images from earlier turns of the session.

### Changed

- The TUI is agent-only; `marifold ask` stays a one-shot answer.
- A message is saved as soon as it is sent, so a new session appears and can be retried before the answer arrives.
- All browser tabs on one service share a session; a reload or second tab no longer shows "in use".
- SkillApp buttons run as cancellable operations with inline errors; apps that fail to load are listed with the reason.

### Fixed

- `--resume` and `--sessions` work with a remote default workspace and report an offline workspace instead of opening Local.

## [0.81.0] - 2026-10-09

Covers 0.79.2–0.81.0.

### Added

- Session takeover between your devices: **Open here** in the Web UI, `marifold --resume <id> --takeover` in the TUI.
- Upload progress ("Sending…") before a remote task starts.
- The TUI session picker shows titles and marks sessions in use elsewhere.

### Changed

- `marifold --resume <id>` exits with an error when the session is missing or in use instead of opening an empty one.
- Paired devices can no longer change the host's providers or endpoints.

### Fixed

- Guests stopped accepting delegated work after 50 runs a day.
- A running task keeps its session reserved; network drops no longer cancel remote runs.
- File tools resolve symlinks to their real destination, and trust is never stored for a broader folder than intended.
- Terminal control sequences in model or tool output can no longer affect the terminal.
- A named pipe can no longer hang `read_file`; one bad schedule file no longer stops all schedules; `config.toml` is written atomically.

## [0.79.1] - 2026-10-06

### Fixed

- Sessions open correctly on connected workspace devices.
- A revoked or unavailable guest can rejoin with a fresh invitation without deleting its saved workspace; the Web UI offers Rejoin.

## [0.79.0] - 2026-10-05

Covers 0.78.0–0.79.0.

### Added

- **Full-screen TUI** by default (`[tui] fullscreen`, `--no-fullscreen` for inline), with scrolling, mouse selection and copy, word movement and deletion.
- A session can be open in only one client at a time, across Web pages, local and remote TUIs.
- Backspace deletes a whole `$skill`, `/command` or `[image #N]` token.

### Changed

- Completed runs collapse their reasoning and progress; Ctrl+O shows them.

### Fixed

- Resumed and recalled prompts keep their images; resize redraws cleanly.

## [0.77.3] - 2026-09-29

### Fixed

- Signing in again to xAI, ChatGPT or Copilot takes effect in a running service or TUI without a restart.

## [0.77.2] - 2026-09-29

Covers 0.76.0–0.77.2.

### Added

- Device-local full execution: `execution mode full` lets approved shell commands run as your account on macOS and Linux, with durable jobs that survive a dropped connection.
- `sudo_exec`, with the password entered on the device that asked, encrypted, and never stored.
- `@device` mentions to run a request on a chosen workspace device, completed in the Web composer.
- `/`, `$` and `@` complete anywhere in a message, not only at the start.

## [0.75.1] - 2026-09-28

### Added

- Conversations on the hosting device can list and delegate work to the workspace's guest devices.

## [0.75.0] - 2026-09-23

Covers 0.74.3–0.75.0.

### Added

- The Web sidebar shows the version.

### Changed

- Pairing and requests between devices with different versions are refused.
- Models know which provider and model they run as.
- Web UI: loading indicators for lists and conversations, a taller composer, download feedback, smaller transcript thumbnails.

### Fixed

- Images attached on a guest are readable by the host's model.
- xAI model listing refreshes expiring credentials through the proxy.

## [0.74.2] - 2026-09-16

Covers 0.74.0–0.74.2.

### Added

- Transcript thumbnails and a larger viewer image, generated on the device that holds the file; originals stay behind Download.
- Experimental direct device-to-device downloads over WebRTC (off by default).

### Fixed

- The image viewer no longer jumps while loading, and repeated opens are cached.

## [0.73.1] - 2026-09-16

### Fixed

- The published CLI reported an older version string.

## [0.73.0] - 2026-09-16

Covers 0.72.0–0.73.0.

### Added

- Generated files appear under the final answer, with image thumbnails, a full-size viewer and browser downloads, also from paired devices.
- Requests carry the local time, timezone and interface to the model.

### Changed

- Downloads stay available after reopening a session or restarting a device.
- The workspace device list shows the host first, then guests in join order.

## [0.71.1] - 2026-09-13

### Changed

- Web search answers show compact source tags with previews, and the agent reads sources before answering instead of only promising to search.

## [0.71.0] - 2026-09-13

Covers 0.70.6–0.71.0.

### Added

- Experimental built-in web research, on by default: native provider search first, otherwise keyless DuckDuckGo with Brave as fallback, with bounded page reading. `[web_search].enabled = false` turns it off.

### Changed

- Open conversations no longer reload when another device changes the workspace; reopen the session to see those changes.

## [0.70.5] - 2026-09-12

Covers 0.69.1–0.70.5.

### Added

- **Device-hosted workspaces (in testing):** share one device's profiles, sessions and models with your other devices through an encrypted bridge you host, with single-use pairing, revocation and an executor opt-out. Workspace selection in the CLI, TUI and Web UI.
- The workspace bridge, with a Linux installer (`marifold workspace bridge install`, Docker Compose with Redis and optional Caddy HTTPS), `workspace bridge update`, and a Vercel option.

### Changed

- Web avatars are saved as 512 px WebP and loaded as small thumbnails.

### Fixed

- GPT-6 Astra appears in the ChatGPT model list.
- SkillApp outputs copy reliably, and SkillApp forms keep their input during background refreshes.

## [0.69.0] - 2026-09-03

Covers 0.68.0–0.69.0.

### Changed

- **Agent only:** the Chat/Agent selector and mode commands are gone; every message runs as an agent turn.
- Skills you install are global by default; `--profile <name>` targets one profile.
- A profile's instructions are one `INSTRUCTIONS.md` file instead of three.

### Upgrading

- `marifold doctor --fix` merges an older profile's `RULES.md`, `PROFILE.md` and `CUSTOM.md` into `INSTRUCTIONS.md`, with a backup. Unmigrated profiles keep working.

## [0.67.0] - 2026-09-02

### Added

- `$skillapp-builder`, a built-in skill that turns an idea into a SkillApp through questions and installs it after one approval.
- SkillApp Markdown preview and text download components, and a Reset action.

## [0.66.0] - 2026-09-01

Covers 0.65.1–0.66.0.

### Added

- Profile-backed SkillApps (`marifold.skillapp.v2`): an App can use a profile's model, instructions and skills, with read-only file access it declares.
- SkillApp attachments and bookmarkable `/apps/<name>` routes.

### Fixed

- Enter inserts a line break in the mobile Web composer.

## [0.65.0] - 2026-08-31

Covers 0.64.2–0.65.0.

### Added

- A mobile Web layout with drill-down navigation and a keyboard-aware composer.
- Native web search for the OpenAI API, xAI and Bailian models; `native_web_search` per provider; Ollama Cloud as an opt-in search backend.

### Fixed

- New sessions can be created from Web clients opened over plain HTTP on the LAN.

## [0.64.1] - 2026-08-27

### Fixed

- The Sessions `+` button works on a profile with no session selected.

## [0.64.0] - 2026-08-27

Covers 0.62.0–0.64.0.

### Added

- `marifold update` updates marifold from npm.
- Built-in `$skill-installer` and `$skill-creator` skills with an approval-aware `manage_skill` tool.
- Agents work with attached documents through inspection, range reads and search instead of loading them whole, and generated files are downloadable.

### Fixed

- ChatGPT subscription models rejected requests with an output-token limit.

## [0.61.0] - 2026-08-26

Covers 0.60.1–0.61.0.

### Added

- The service prints usable LAN and Tailscale URLs; `--verbose` shows technical details.
- Add a provider from the Web UI's Providers column.
- Native web search for ChatGPT models.

## [0.60.0] - 2026-08-25

The first version published to npm. [Release notes](docs/releases/v0.60.0.md).

### Added

- One `npm install -g marifold` installs the CLI, terminal UI, local service and Web UI; the service hosts the Web UI.
- Optional display names for profiles.

## Before 0.60.0

Versions 0.1.0–0.59.0 (2026-06-02 to 2026-08-23) were developed and used locally and never published. Together they built the base that 0.60.0 shipped:

- **CLI and chat:** profiles with their own model, instructions and memory; providers including Ollama, OpenAI-compatible APIs, Anthropic, ChatGPT and GitHub Copilot subscriptions and xAI Grok, with per-provider proxies; model management and sessions.
- **Agent:** an agent loop with tools, approvals, per-profile permissions and trusted folders, Markdown skills (`SKILL.md`), web search, scheduling, and conversation compaction.
- **Terminal UI:** the interactive TUI with completion, session resume and Markdown rendering.
- **Local service and Web UI:** an HTTP service (`marifold service`, daemon mode, private-network access) with streaming chat and live agent runs, and a Web UI for agents, sessions, attachments and configuration.
- **Telegram:** a bridge for chatting with a profile, with approvals and files.
- **SkillApps:** model-driven form apps (`skillapp.ts`) that run through the service and render in the Web UI.
