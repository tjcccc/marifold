# Artifacts

**Status: design agreed 2026-10-28; not built.** Agreed in discussion: one artifact library under `~/.marifold/artifacts/` for every profile and project, each artifact a folder bundle named by a short id, folders as metadata (a category table) rather than directories, the recommendations in [Decisions](#decisions), and `@[artifact]` mentions. Details such as limits and tool names may still change during implementation; deviations go in the DEVLOG.

An **Artifact** is a page a profile makes for the user to read or use: a report, a dashboard, a small interactive HTML app, or a Markdown document with images. Artifacts live in one **artifact library** per marifold service, organised into folders, and update in place as new versions when a later reply changes them. Any profile can make one, in an ordinary session, in a project session, or from a schedule.

The motivating case: a folder **AI News**, and a schedule on profile `news` that writes a report every morning into that folder for the user to read.

## Concepts

- **Artifact**: a titled bundle of files with an entry file (`index.html` or `index.md`), a kind (`html` or `markdown`), versions, and where it came from (profile, session, run, and the project or schedule when there is one).
- **Bundle**: the files of one version. An HTML page keeps its `.js`, `.css`, and images beside it; a Markdown document keeps its images. Everything an artifact shows comes from its own bundle.
- **Version**: a complete, immutable copy of the bundle. Editing an artifact ("make the chart blue") adds a version; earlier versions stay readable and can be restored.
- **Folder**: a named group in the library, shown in the UI. Folders are metadata (a category row), not directories: an artifact points at one folder, and renaming or moving changes one row while files never move. An artifact without a folder is **Unfiled**.
- **Artifact library**: the single store under `~/.marifold/artifacts/` that every profile and project saves into. It is the user's, the way sessions are: profiles contribute to it but cannot browse it (see [Permissions](#permissions)).

### Naming: artifacts vs run outputs

marifold already calls the files a run leaves in its output directory "artifacts" in code (`RunArtifact`, `GET /v1/runs/:id/artifacts`). The Web UI already shows those as **Outputs**. From now on:

- In the UI and docs, **Artifact** means a library item as defined here, and a run's files are **outputs**.
- Code and routes for run outputs keep their names (`RunArtifact`, `/v1/runs/:id/artifacts`) for compatibility; their doc comments and the glossary in `architecture.md` say "run output". New code lives in `packages/core/src/artifacts/` with `Artifact…` names.
- An output can become an artifact (**Save as artifact**), the way an output can become a project asset today.

### Relation to projects

The [Projects design](projects.md) originally planned an Artifact as a stored HTML asset of a project. Because profiles make artifacts outside projects too, artifacts get their own library instead, and projects reference them:

- An artifact made in a project session records the project (`project_id`). It appears in that project's Assets column (an **Artifacts** card) and the project's roster profiles may read and update it, like the project's stored assets.
- It is still in the library, so it shows up with everything else the user reads, filterable by project.
- Project **assets** stay what they are: material the project's work builds on (uploads, saved files, linked folders). An artifact is a page made for the user. A file can be both when the user saves it twice; v1 does not try to merge the two stores.

## Storage

```
~/.marifold/artifacts/          [paths].artifacts_dir, default <marifold home>/artifacts
  artifacts.db                  SQLite, WAL, busy_timeout
  items/<id>/v1/index.html      one directory per artifact, one per version
  items/<id>/v1/chart.js
  items/<id>/v2/...
  staging/<random>/             versions being written; cleared on service start
```

- **Ids** are short random strings (10 characters of lowercase base32), checked for collisions on insert. Titles live in the database, never in paths, so a title can contain anything.
- **A separate database.** The library has its own `artifacts.db` rather than tables in `sessions.db`, so the whole library is backed up or moved by copying one folder, and a problem in one database never touches the other.
- **Writing a version is atomic.** Files are copied into `staging/<random>/`, checked (paths, sizes, entry file present), renamed to `items/<id>/v<n>/`, and only then recorded in the database in one transaction. A failed or cancelled run leaves no half-written version; leftovers in `staging/` are deleted on start.
- **Paths inside a bundle** are relative, `/`-separated, without `..`, absolute parts, drive letters, control characters, or a leading dot segment; at most 8 levels deep. Symlinks are never copied (their targets could leave the bundle).
- **Limits** (configurable under `[artifacts]`): 25 MB and 500 files per version, 1 GB for the whole library including all versions. A save over a limit is refused with a message saying which limit and the current use.
- **No de-duplication in v1.** Each version is a full copy: artifacts are small, and plain directories stay easy to inspect. Content-addressing can come later without changing the API.

### Data model

`artifact_categories`:

| Column | Notes |
|---|---|
| `id` | short id |
| `name` | unique among siblings, case-insensitive; trimmed; at most 80 characters |
| `parent_id` | always null in v1; reserved so nested folders need no migration |
| `sort_order` | user ordering in the folder list |
| `keep_latest` | optional; when set, the oldest untouched schedule-delivered artifacts beyond this count move to Recently deleted after a new one arrives (for daily reports) |
| `created_at`, `updated_at` | |

`artifacts`:

| Column | Notes |
|---|---|
| `id` | short id; also the directory name |
| `title`, `description` | shown in the UI; the description is optional |
| `kind` | `html` or `markdown` |
| `category_id` | null means Unfiled; deleting a folder makes its artifacts Unfiled |
| `project_id` | set when made in a project session |
| `current_version` | the version shown by default |
| `created_by_profile`, `session_id`, `run_id`, `schedule_id` | where it came from; kept after the session or schedule is deleted, for display only |
| `seen_at` | null until the user opens the current version; a new version clears it (the unread dot) |
| `touched_at` | set when the user edits, renames, or moves it, or a profile adds a version; pruning skips touched artifacts |
| `deleted_at` | set while in Recently deleted; purged after 30 days |
| `created_at`, `updated_at` | |

`artifact_versions`: `artifact_id`, `version`, `entry` (the entry file's path), `file_count`, `size`, `created_by_profile`, `run_id`, `note` (what changed, from the saving call), `created_at`.

`artifact_files`: `artifact_id`, `version`, `path`, `size`, `media_type`, `sha256`. This lets the service list and serve files with the right type and size without scanning the disk, and lets a later integrity check find damaged bundles.

## How profiles make and change artifacts

### When

A profile makes an artifact for substantial, standalone content the user will read or reuse: a report, a dashboard, a page, a document longer than a chat reply. It never makes one for a short answer. The user can always ask ("make this a page"). The agent's instructions say this in a few lines; they also say artifacts must be self-contained (see [Viewing safely](#viewing-safely)).

### Tools

- `save_artifact({ title, kind, entry, dir | files, folder?, description?, note?, artifact_id? })`: the profile writes the bundle in its run's output directory (it can already write there without approval), then calls `save_artifact` with that directory or file list. Without `artifact_id` it creates an artifact; with one it adds a version. `folder` names a folder; a missing folder is created. The result returns the id, version, and a one-line link the reply can mention.
- `read_artifact({ artifact_id, version?, path? })`: lists a version's files, or returns one file's text, so the profile can edit it and save a new version.
- `list_artifacts()`: lists only the artifacts this profile may use (below), never the whole library.

There is no delete tool: deleting is the user's action.

### Permissions

Saving into the library needs no approval: it is marifold-owned and reversible, since versions keep earlier content. That matches saving a project asset today.

A profile may read and update:

- artifacts made in the current session (any speaker's, in a project session);
- artifacts of the current project, when the session belongs to one;
- artifacts the user hands it in the message with an `@[artifact]` mention (see [Mentioning artifacts](#mentioning-artifacts)).

### Mentioning artifacts

`@[AI News — 2026-10-28]` hands an artifact to the answering profile. The brackets keep it apart from `@name` / `@"name"` mentions of profiles and devices (their names cannot contain `[`) and let titles hold spaces and punctuation.

- **In the composer**, typing `@[` opens the library picker; choosing inserts a chip shown as `@[title]`, and the message carries the artifact's id, so equal titles are never confused.
- **Typed by hand** (Telegram, or without the picker), `@[title]` matches an exact title, case-insensitively, and `@[<short id>]` matches the id. When several artifacts match, nothing is guessed: the reply lists them with their ids. A title containing `]` can be handed over only through the picker or by id.
- **Parsing**: the mention tokenizer (`agent/Mentions.ts`, mirrored in `@marifold/client`) skips `@[` for profile and device mentions and reads `@[...]` as its own token, outside code spans as today. Both copies change together.
- A mentioned artifact joins the run's artifact manifest (title, kind, id, current version), and the profile reads it with `read_artifact`; content is never sent by default.

Everything else in the library is invisible to it. This keeps the existing rule that profiles share by talking, not by reading each other's things.

### In the conversation

A run that saves an artifact emits an additive `AgentEvent` (`{ type: 'artifact', artifactId, version, title }`). The Web reducer treats unknown events as no-ops, so older clients are unaffected. The run card shows an artifact chip; pressing it opens the viewer in a resizable column on the right, the same column the project Assets use. A later reply that adds a version updates the open viewer.

## Viewing safely

Artifacts contain HTML and scripts written by a model, possibly after reading untrusted web pages. The viewer must assume a hostile page and still keep the user's marifold safe.

- **Sandboxed origin.** Artifact files are served with a `Content-Security-Policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox …` header, never with `allow-same-origin`. That gives the page an opaque origin even when it is opened directly in a new tab. It cannot read the marifold app's storage or cookies, cannot navigate the app's window, and cannot submit forms. Links (a news report's sources) open in a new tab outside the sandbox.
- **Only its own bundle.** The same CSP limits every source (`default-src`, `script-src`, `style-src`, `img-src`, `font-src`, `connect-src`, …) to the URL prefix of that version's bundle, plus `'unsafe-inline'`, `data:` and `blob:` (models write inline scripts and styles). The page can load and `fetch` its own files (a dashboard reading `data.json`), but cannot call the marifold API, reach another artifact, or use the network beyond its bundle. That includes images on other sites: a news report has to download the images it shows into its bundle (links to sources still work; they open in a new tab).
- **The view route answers a sandboxed page; the rest of the API does not.** A sandboxed page sends `Origin: null` on module scripts, fonts, and `fetch`, and the service refuses any origin that is not same-origin or listed in `[service].cors_origins`. So `/v1/artifact-views/*` skips that origin check and answers with `Access-Control-Allow-Origin: *` (it serves only one bundle and needs no credentials). Every other `/v1` route keeps refusing `Origin: null`. A test pins both directions, so later changes to the origin policy cannot open the API to artifact pages or break module-based pages.
- **Framing.** The app's pages must allow the iframe (no `frame-src` restriction excluding the service), and artifact responses must not send `X-Frame-Options` or a `frame-ancestors` that blocks the app. Implementation checks both.
- **View tickets.** A sandboxed page cannot send the bearer token, so files are served under a capability URL: `POST /v1/artifacts/:id/view` (authenticated) returns `/v1/artifact-views/<ticket>/`. The ticket is random and grants exactly one version's files. Its expiry slides: each request extends it to 1 hour after the latest use, capped at 12 hours from issue, so the iframe's URL stays stable while the page is open (a renewed URL would reload the page and lose an interactive page's state). This is the existing download-ticket pattern with a wider path. Each response carries `x-content-type-options: nosniff`, `cache-control: no-store`, `referrer-policy: no-referrer`, and a media type from the file's extension.
- **Markdown renders in the app, not as a page.** A `markdown` artifact is shown by the Web UI's own Markdown renderer, which has no raw HTML or scripts, and its images load from the bundle through the view ticket. Markdown therefore needs no script sandbox at all and matches the app's typography.
- **Self-contained by design.** With no network, a page that loads Chart.js from a CDN shows nothing. The agent's instructions say to put libraries in the bundle. CDNs are also unreliable from China, where this user runs marifold. (Libraries served by marifold are left out of v1; see [Decisions](#decisions).)
- **A separate origin later.** A dedicated port or host for artifact content (like Claude's separate user-content domain) is stronger still. The opaque-origin sandbox plus path-limited CSP is sufficient for v1 on a single-user service; the routes are shaped so content can move to another origin without client changes.

## Web UI

- **Artifacts** joins the Agent, Projects, and Apps entries in the top navigation.
- Three columns, Mail-style like Settings, drilling down on phones:
  - **Folders**: All, Unread, Unfiled, then each folder with its count and unread count, and **Recently deleted** at the bottom. **+** creates a folder; a folder's menu renames, deletes (its artifacts become Unfiled), and sets **Keep latest N**.
  - **List**: title, the maker's avatar, date, and an unread dot; newest first; filters by profile and project; search by title.
  - **Viewer**: the artifact, with a header holding title (rename), version picker (**Restore** makes the chosen version current by adding a copy as the newest version), **Move to folder**, **Open in new tab**, **Download** (the entry file; the whole bundle as a `.zip` arrives in step 4), **Open session** (the session that made it), and **Delete**, which moves it to Recently deleted (restorable for 30 days, then purged; **Delete now** there removes it permanently).
- In conversations: the artifact chip on run cards and the right-hand viewer column described above. An output row gains **Save as artifact** (title, folder).
- In projects: the Assets column gains an **Artifacts** card listing the project's artifacts.
- Opening the current version marks it seen.

## Schedules that deliver artifacts

Schedules already run a profile's agent unattended on a cron and keep the result as a task. A schedule gains an optional **delivery**:

```
delivery = { artifact: { folder: "<category id>", title: "AI News — {date}" } }
```

- The run is told where to write: a folder inside its own output directory (`output/artifact/`), with `index.html` or `index.md` as the entry. Profiles never write into marifold state directly. **Code saves the result, not the model**: after a successful run, marifold copies that folder through `artifacts/staging/` and commits it as a new artifact in the folder with the rendered title. The model only writes content, so a daily report cannot land in the wrong place or under a different name.
- Scheduled runs are unattended, so any approval that would ask is denied. A news report needs web search and network to be allowed for that profile without asking (`agent.approval.network = "allow"`, and web search enabled). The schedule editor checks the profile's permissions and warns when a delivery schedule would be refused what it needs.
- A failed run, or one that leaves no entry file, creates nothing. The schedule's existing last-result fields show the failure.
- Each firing makes a **new artifact**, not a new version: a daily series is many artifacts in one folder, newest first. The folder's **Keep latest N** prunes old ones, but only artifacts a schedule delivered that nobody has edited, moved, or renamed since; an artifact saved into the folder by hand, or changed by the user, is never pruned. Pruned artifacts go to **Recently deleted** (see [Web UI](#web-ui)), not straight to permanent deletion.
- `{date}` renders in the service's local time zone as `YYYY-MM-DD`; `{time}` (`HH:mm`) and `{name}` (the schedule name) are also available.
- A schedule may also name a project, so its run uses that project's instructions and assets, and the artifact records the project.
- Schedules become editable in the Web UI (today they are managed with `marifold schedule …` and read-only over HTTP): name, profile, objective, cron (with a readable preview such as "every day at 07:00"), enabled, and delivery.

## Workspaces

The library lives on the workspace host, like profiles, sessions, and projects. Other workspace devices list, open, rename, and move artifacts through the bridge. The artifact routes join the forwarded set in `workspaceApiPath`, and view tickets and files are proxied the way remote downloads are. The guest serves the page to its browser, so it builds the sandbox-and-bundle CSP for its own origin and path. It never passes the host's header through and never applies the existing remote-download CSP (`default-src 'none'`, which would block every script). A guest device's runs save into the host's library through the same workspace operations project assets use. As with every workspace change, this is verified live on the OrbStack guest, not only in unit tests.

## Service API (sketch)

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/artifacts` | `?folder=&project=&profile=&unread=&q=&limit=&cursor=`; metadata only |
| GET | `/v1/artifacts/:id` | metadata, versions, and the current version's file list |
| PATCH | `/v1/artifacts/:id` | `{ title?, description?, folder?, seen? }` |
| DELETE | `/v1/artifacts/:id` | moves it to Recently deleted; `?permanent=true` removes it and all versions |
| POST | `/v1/artifacts/:id/undelete` | restores it from Recently deleted |
| POST | `/v1/artifacts` | `{ runId, output, title, kind?, folder? }`: Save as artifact from a run output |
| POST | `/v1/artifacts/:id/restore` | `{ version }`: adds a copy of that version as the newest |
| POST | `/v1/artifacts/:id/view` | `{ version? }`: returns `{ url, expiresAt }` for a view ticket |
| GET | `/v1/artifact-views/:ticket/*` | the version's files, under the sandbox CSP; no bearer needed |
| GET, POST | `/v1/artifact-folders` | list and create folders |
| PATCH, DELETE | `/v1/artifact-folders/:id` | rename, reorder, set `keepLatest`; delete makes its artifacts Unfiled |

Schedule writes (`POST`, `PATCH`, `DELETE /v1/schedules…`) come with the schedule editor. All changes are additive to `v1`.

## Delivery plan

1. **Library and viewer**: the store, the agent tools, the routes and view tickets, the Artifacts view with folders, the chip and viewer column in conversations, Save as artifact, versions and restore, and Recently deleted. HTML and Markdown.
2. **Projects and workspaces**: the project Artifacts card, project roster permissions, and guest devices through the bridge, verified live.
3. **Scheduled delivery**: schedule delivery into folders, the Web schedule editor, unread markers, and Keep latest N.
4. **Polish**: download as one `.zip` (a small store-only zip writer, no new dependency), a Telegram "your report is ready" notice, and anything left from review.

Steps 1 and 2 can ship as one release; step 3 is the AI News case end to end.

## Decisions

Agreed 2026-10-28:

1. **No libraries served by marifold in v1.** Pages embed what they need; revisit after seeing what profiles actually write.
2. **Deleting a project keeps its artifacts** in the library, detached from the project, since they are the user's reading.
3. **Artifacts made from Telegram** are sent as the entry file (Markdown, or self-contained HTML), with a note that they are also in the library.
4. **Artifacts are mentioned as `@[title]`**, not `#` (the user's own Skills already use `#`); see [Mentioning artifacts](#mentioning-artifacts).
5. **Nested folders** stay reserved in the schema (`parent_id`) and are not exposed in v1.
