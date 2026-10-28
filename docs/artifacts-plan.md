# Artifacts implementation plan

**Status: steps 1 and 2 shipped in v0.107.0 (2026-10-28).** Implements [`artifacts.md`](artifacts.md). Each release ends with the user's own test before the version bump, as usual. Steps 1 and 2 ship together as v0.107.0, so a guest device never shows an empty second library.

Deviations so far: no new config keys in v1. The library lives in `artifacts/` beside `sessions.db` (as `projects/` does), and its limits are constants, because `ConfigManager` rewrites `config.toml` from what it parses and is near its size limit. A bundle saved with `dir` is refused when the run's output listing hit its 50-file cap, rather than saved incomplete. **Save as artifact** from an output row takes one file in v1 (an HTML page needing sibling files is saved by the profile with `save_artifact`). Markdown images display only in the artifact viewer; chat replies keep showing image syntax as links, so they never load remote images. The save event is `artifact_saved`, not `artifact` (taken by run outputs). A guest serves each view file by one `api` request to the host's ticket, not chunked like downloads; a file is at most the 25 MB version limit, under the bridge's transfer limit. A guest-executed run saving with `dir` lists its whole output folder on the device, so it is refused when that folder has 50 or more files, even if `dir` holds fewer.

## Findings that shape the plan

- **Tools need run context.** `ToolExecutionContext` carries no session or run id, so the artifact tools are built per run, like the project asset tools in `WorkspaceRuns.projectAssets`, with the session, project, profile, run id, and the run's outputs (`RunOutputs`: host files, or a guest's over the bridge).
- **Only service runs build tools per run.** Web and remote TUI runs go through `WorkspaceRuns.createRunner`; Telegram (`respond`), local TUI, and schedules call `runtime.createAgentRunner` directly. Step 1 wires artifact tools into `createRunner` (all Web runs, project or not, host or guest). Telegram follows the agreed decision (the entry file is sent as a document) in the polish step, and schedules get code-side delivery in step 3.
- **A run's output listing stops at 50 files** (`MAX_RUN_ARTIFACTS`, the download cap), so a bundle saved from a run has at most 50 files in v1, under the design's 500-file version limit.
- **A guest-executed run could not list its output folder mid-run**; it read single files over the bridge (`deviceRunOutputs`), and `executor.artifacts` ends the run. Step 2 adds `executor.artifact` `{ list: true }`, which lists the stored output folder without ending anything, so `dir` works on guests too.
- **`artifact` is taken** in `AgentEvent` (a run output). Library saves emit `artifact_saved`.
- **`mediaTypeFor` knows office formats, not the web.** The library has its own type map for serving bundles (HTML, CSS, JS, fonts, SVG, GIF, …).
- **The security hook runs before routing**: origin allowlist, Host check, then bearer auth (with `authorizeArtifact` for download tickets). View tickets get a predicate checked before the origin allowlist, which skips the origin and token checks but keeps the private-network and Host checks.

## Step 1 slices (release v0.107.0)

### 1a. Library store (core)

- `packages/core/src/artifacts/ArtifactLibrary.ts`: `artifacts.db` (better-sqlite3, WAL, busy timeout) with `artifact_categories`, `artifacts`, `artifact_versions`, `artifact_files`; `items/<id>/v<n>/`; `staging/` cleared on open.
- Create, add version (staged copy, validate paths/limits/entry, rename, one transaction), restore (copy as newest), rename/describe/move, mark seen, delete to Recently deleted, undelete, permanent delete, purge after 30 days, list with filters, folders (create, rename, reorder, delete → Unfiled).
- Tests: atomic version writes (a failed copy leaves nothing), path validation, limits, restore, delete/undelete/purge, folder delete making artifacts Unfiled.

### 1b. Agent side (core)

- `artifacts/ArtifactTools.ts`: `save_artifact`, `read_artifact`, `list_artifacts`, scoped to the session's, the project's, and mentioned artifacts; `artifact_saved` events; a short run instruction (when to make one, self-contained bundles, the usable list).
- `@[title]` / `@[id]` mentions in `agent/Mentions.ts` and its `@marifold/client` copy; `RunStartInput.artifactIds` for picker chips; ambiguous titles listed in the run instruction.
- Wired in `WorkspaceRuns.createRunner` for every run.
- Tests: scope (another session's artifact is invisible, a mentioned one is usable), save from a folder and from files, a new version by id, the mention parser's cases.

### 1c. Service

- `ArtifactRoutes.ts`: the routes in the design, plus view tickets (`ArtifactViews`: one version's files, sliding 1 h expiry capped at 12 h) served under the sandbox CSP limited to the bundle prefix, `Access-Control-Allow-Origin: *`, no framing headers.
- Security: the view predicate before the origin check; tests that the view route serves `Origin: null` and every other route still refuses it.
- Tests: CRUD, restore, delete/undelete, Save as artifact from a run output, ticket expiry and containment (no `..`, no other version).

### 1d. Web

- An **Artifacts** view in the top navigation: folders, list, viewer (sandboxed iframe for HTML, the app's Markdown renderer for Markdown with bundle images), rename, move, versions and restore, delete and Recently deleted, unread.
- Conversations: an artifact chip on run cards and the right-hand viewer column; **Save as artifact** on output rows; `@[` opens a library picker in the composer.
- Tests: the reducer folding `artifact_saved`, the library screen's main actions, the picker inserting a chip with the id.

## Step 2: projects and workspaces

The project **Artifacts** card and roster permissions; artifact routes forwarded to guest devices, their view pages proxied with a CSP built for the guest's origin, and guest runs' `dir` saves; verified live on the OrbStack guest.

Built: the Artifacts card in the project's Assets column (sheet and column, not the phone's session-list header), listing `GET /v1/artifacts?projectId=` and opening the viewer; roster profiles reach the project's artifacts through the run scope from step 1; **Save as artifact** records the run's project; deleting a project detaches its artifacts. `workspaceApiPath` forwards `/v1/artifacts…`, `/v1/artifact-folders…`, and GETs of view-ticket paths; the guest re-issues `POST …/view` as its own ticket (`ArtifactViews.issueRemote`).

## Steps 3 and 4

As in the design: scheduled delivery with the Schedules module (its own design document first), then polish (zip download, Telegram entry-file delivery and notice).
