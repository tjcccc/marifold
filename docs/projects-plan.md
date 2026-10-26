# Projects v1 implementation plan

**Status: slices 1–5 released in v0.103.0 (2026-10-27); slice 6 in progress: 6a (stored assets in core and the service) and 6b (linked assets) done, 6c (Web) next.** Implements [`projects.md`](projects.md). Each release below ends with the user's own test before the version bump, as usual. Releases A and B were tested together and ship as one version, v0.103.0, so the Assets release becomes v0.104.

Deviations so far: the project icon and the stored-asset limit get their columns with the features that use them (slices 5 and 6); profiles created by a CLI or local TUI without a running service skip the device-name check (it needs the service's device list); the Web composer's `@` detection (`useAgentController.ts`) moves to the shared parser in slice 5; the TUI's own `@` tokens (`inputTokens.ts`, highlighting and completion) stay until TUI project support. Slice 3: the run option is `replyToUserTurnIndex` (an explicit user-turn ordinal, not "the current turn"), so slice 4 names the message it answers and a regenerated message mid-session gets its replies back in place; the first reply's metrics stay in the original table so older versions sharing a `sessions.db` keep working, and later replies' go to `marifold_reply_metrics`; speakers are recorded only in project sessions (a reply without one is the session profile's). Regenerating reply 0 removes the message's later replies, and slice 4 reruns the other speakers with `replyToUserTurnIndex`. A multi-reply session continued in chat mode (after leaving its project) replays consecutive, unlabelled assistant turns through Priest, so project runs stay in agent mode. The Web and TUI show consecutive replies as plain assistant messages until slice 5. Slice 4: profiles are mentioned by name only, not display name (display names may collide with device names; names cannot); a new project session's Priest `profile_name` is its first speaker, not the Lead (the first run saves the session as usual, and a session moved out of its project becomes that profile's); speakers are linked by an explicit `handoff` event rather than clients discovering the next run; a request's `provider`, `model`, `deep` and `instructions` apply only to the speaker named by `profile`; a failed speaker does not stop the turn (cancel does, and so does a regenerated message whose first answer did not complete); regenerating leaves the floor alone; a skill must route to the one profile it was resolved for; every speaker shares the request's execution device. Creating a project's tables now creates the session tables first, which also fixed session reads failing in a database that held only projects. Slice 5: the Web reads `@` with a byte-identical copy of core's parser in `@marifold/client` (`mentions.ts`; a client test fails when the two differ), because the Web may not import core at runtime; the composer previews the host's routing to show "→ profile" and offers **Invite** before sending a mention of an off-roster profile (the host still refuses it); a message with a skill and several speakers is refused in the composer, since the host requires a skill to route to one profile. The icon is stored like a profile avatar, as `icon.<ext>` under `projects/<id>/` beside `sessions.db` (assets will share that folder), so no column was needed; deleting a project removes it. Project session lists carry `speakers` for the row avatars. Tests cover the routing preview, handoff placement and following, and the project commands; the menus and settings sheet were checked in the two-device preview instead of component tests. Slice 6 is split into 6a (stored assets: store, agent tools, routes), 6b (linked assets) and 6c (Web). Slice 6a: one version is at most 25 MB, because a guest downloads assets through the bridge, whose messages carry at most 40 MiB of base64; uploads are base64 JSON within the service's 25 MB request limit, so about 18 MB of file; the limit counts each distinct content once across versions and assets, so a copy under another name is free, and equal content adds no version; `save_asset` also stores text (`content` with `name`), so the agent need not write a file first; `read_asset` shows images to the model, returns text inline (capped like other tool output, with a work-folder copy on the host when longer), and copies another binary file into the run's work folder, which a guest-executed run cannot reach, so it refuses there (linked assets cover large or binary material on a device); only the first 50 files of an output folder can be saved, the download listing's cap. Slice 6b: links are rows of the stored assets' table (`kind`, `device_id`, `path`), so the two kinds share names, and one device path is linked once; an absolute path follows the device as `@office/Volumes/data`; the read grant joins the read-only roots on the link's device, which checks it again. File tools already read non-sensitive files anywhere, so the grant mostly opens linked folders outside home to scoped shell scripts on macOS. Home itself, app state, denied roots, and links holding or inside a sensitive or startup root get no grant, so reads there still ask or are blocked. Links and device availability are read as each run starts. Runs that `delegate_device` starts now carry the project (in 6a they had no asset tools), so they get the asset tools and the read grant for their device's links. Folder completion when adding a link is left to 6c.

## Findings that shape the plan

- **Sessions are profile-owned.** Priest's `sessions.profile_name` drives listing (`SessionResolver.list`, the profile contact list) and the profile a resumed session runs as. Project sessions keep that column (set at creation; slice 4 made it the first speaker, see the deviations above) so priest is unchanged; project membership lives in marifold tables.
- **`@` is taken by devices.** `WorkspaceRuns` parses `@name` anywhere in the objective, refuses more than one mention ("Select one @device per task"), and refuses `@device` with a `$skill` ("run skills and commands separately"). `@painter, use $make-midjourney-prompt …` would fail today, and `@dev_test,` captures the comma. Profile mentions must be parsed and removed before the device parser runs.
- **Turns are assumed to alternate.** One user message answered by several profiles produces consecutive assistant turns. Response metrics are keyed by user turn index (`upsertResponseMetrics`), and history replay (`sessionHistory`), compaction planning, edit/regenerate (`replaceUserTurnIndex`), and the Web thread builder all expect user/assistant pairs. This is the riskiest change and is isolated in its own slice.
- **Memory writes use the run's profile** (`memoryAccess.apply(settings.profile, …)`), which is already the answering profile when each speaker is its own run. That needs a test, not a change.
- **Guests reach host routes through an allowlist** (`workspaceApiPath` in `WorkspaceRoutes.ts`); `/v1/projects` must be added or guests cannot see projects.
- **Profile rename keeps sessions** (v0.95); rename and delete must also update rosters and the Lead.

## Slices

### 1. Mentions and names (core, small)

- `agent/Mentions.ts`: one parser for `@name` and `@"name"`, tolerant of trailing punctuation (`, . : ; ? !` and full-width `，。：；？！`), ignoring e-mail addresses and code spans. Returns mentions with positions and the objective with profile mentions removed.
- `WorkspaceRuns` uses it for device mentions; behavior outside projects is unchanged.
- Name collisions: creating or renaming a profile to a device's name (or a device to a profile's name) is refused.
- Tests: the parser's edge cases; the existing device-mention tests still pass.

### 2. Project store (core)

- `projects/ProjectStore.ts` with tables in `sessions.db`, created like the session display tables: `projects` (id, name, description, icon, instructions, lead, asset limit, timestamps), `project_members` (project id, profile, joined at), `project_sessions` (session id, project id, floor profile).
- Rules: the Lead is always a member; dismissing the Lead is refused; a profile rename updates rosters and the Lead; deleting a profile removes it from rosters and refuses when it leads a project.
- Project sessions are excluded from per-profile session lists and listed by project.
- **Move to project:** sets `project_sessions`, adds the session's profile to the roster.
- Tests: store rules, rename/delete cascades, listing exclusion.

### 3. Several replies per message (core, the risky slice)

- Allow consecutive assistant turns in a session. Response metrics move from "per user turn" to "per assistant turn" (with a migration that keeps existing rows), and each assistant turn records its `profile`.
- Audit and adapt each pair assumption: `sessionHistory` (labels speakers: "dev_test: …"), compaction planning and the summary prompt (keep speaker labels), edit/regenerate (regenerating a multi-reply exchange reruns the same speakers), `turnsBeforeUserTurn`, the Web thread builder.
- A run option `replyToUserTurnIndex` lets speakers 2..N answer the already-saved user turn instead of saving it again.
- Tests: ordinary sessions unchanged (existing suites); a 3-speaker exchange round-trips through history, compaction, metrics, and regenerate.

### 4. Project runs (core + service)

- Routing on the host: for a project session, resolve profile mentions against the roster (unknown member → a typed error the client turns into "Invite painter?"), apply the floor rule (last addressed, else the Lead), and remove profile mentions before device parsing.
- Instructions: profile instructions, then the project's instructions as an additional context block, which names the answering profile and the roster (history labels other speakers by name, and a compaction summary names every speaker, including the one answering).
- Every speaker run gets the message's images (a reply run's history lists only earlier turns' images), and a new project session is linked to its project before its first outcome is saved, so the first reply records its speaker (`moveSession` needs an existing session).
- Several mentions: a **project turn** in `RunRegistry` starts one run per speaker, in order, each with its own approvals; the next starts when the previous ends; cancelling cancels the rest. Each `RunRecord` carries `profile` so clients label it. After a multi-mention, the floor returns to the Lead.
- Routes: `/v1/projects` (list, create, get, patch, delete), `/v1/projects/:id/members` (invite, dismiss), `/v1/projects/:id/sessions`, `POST /v1/sessions/:id/project` (move). Added to `workspaceApiPath`. `docs/service-api.md` updated; new run fields and events get examples in `AgentEventExamples.ts`.
- Tests: routing and floor, instruction order, sequential speakers with cancel, memory written to each answering profile, route validation, guest forwarding.

**Release A (v0.103.0, with B): slices 1–4.** Usable through the API and tests; the Web UI follows. Verified live on the OrbStack guest: a project session started on the guest runs on the host with two speakers.

### 5. Web UI

- **Projects** tab beside **Agent**; the left column drills down from projects to a project's sessions (back arrow), each row with speaker avatars.
- Project settings: name, icon (folder by default), instructions, roster, Lead.
- Conversation: avatar and display name on each reply; composer shows "→ profile" and autocompletes `@` from the roster, then devices; `/invite @profile`, `/dismiss @profile`; the "Invite painter?" prompt.
- **Move to project…** in the session row menu (ChatGPT-style menu with **New project** first).
- Tests: component tests for routing display, commands, menu; manual two-device preview for the user.

**Release B (v0.103.0, with A): slice 5.** Verified live in the two-device preview, on the guest's page (headless): the project list with its icon, "→ default, painter", both replies with speaker headers, an edit that brings both back, a reload that stays in the project, the Invite prompt adding a profile to the host's roster, **Move to project…**, and Project settings.

### 6. Assets

- `projects/ProjectAssets.ts`: stored assets content-addressed under `~/.marifold/projects/<id>/assets/`, versions, the per-project limit (100 MB default, configurable), linked assets as device id + device-relative path with availability.
- Agent tools for project runs: `list_assets`, `read_asset` (stored; linked ones use the normal file tools on their device), `save_asset` (new asset or version, no approval). A short manifest in the run instructions, never content.
- A linked folder is a read grant for the project's runs; sensitive folders still ask; writes follow the profile's permissions.
- Routes for upload, list, versions, link, remove; added to the guest allowlist.
- Web: Assets panel, upload, "Add to assets" on run outputs, link with `@device/path`.
- Tests: limit accounting, versions, link resolution and offline state, tool permissions. Live: a guest-linked folder read from a host project run.

**Release C (v0.104): slice 6.**

## Out of scope for v1

Group chat (profile-to-profile replies), Teams, TUI project support, asset search and automatic folder descriptions, Artifacts (next, on top of assets).

## Effort

Slices 1, 2, 5 are routine. Slices 3, 4, and 6 change shared session, run, and permission behavior across devices and deserve the most care, review, and live testing.
