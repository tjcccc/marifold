# Projects and Assets

**Status: Projects released in v0.103.0 (2026-10-27); Assets not yet.** The decisions below were agreed in discussion (2026-10-26). [`projects-plan.md`](projects-plan.md) tracks the slices and where the implementation deviates.

A **Project** is a shared place for one piece of ongoing work: its own instructions, several conversations (sessions), the profiles invited to take part, and the files the work needs (**Assets**). Projects come before Artifacts because Artifacts, SkillApp results, and Workflow outputs all need a home wider than one session, and an Artifact is largely an HTML asset rendered live (see [Relation to Artifacts](#relation-to-artifacts)).

The name follows Claude and ChatGPT, where "Projects" already means instructions + files + many chats, so it needs no explanation. In the UI, a folder on disk is a "folder", never a "project folder", to avoid the coding sense of the word.

## Concepts

- **Project**: name, optional description, an icon (a folder icon by default, replaceable with an image like a profile avatar), project instructions, a roster of invited profiles, a Lead, sessions, and assets. Projects are marifold-owned state and live on the workspace host like profiles and sessions.
- **Roster**: the profiles invited to the project. Any number; a profile can be in many projects.
- **Lead**: the roster profile that answers when a session has not addressed anyone yet. `default` unless changed. The Lead is always on the roster and cannot be dismissed (change the Lead first).
- **Project session**: a session that belongs to the project rather than to one profile. Each assistant turn records which profile answered it.
- **Asset**: a file or folder the project's profiles can use across sessions, either stored by marifold or linked on a device.

## Profiles in a project

Each profile works as itself: its own model, provider, Deep setting, Skills, memory, and permissions. A project has no permissions of its own.

- **Instructions** are layered: the profile's own instructions first, then the project instructions on top (more specific, so they win where they conflict). Human-authored instructions still outrank memory.
- **Memory stays private.** A profile reads and writes only its own memory, also inside a project. Project knowledge belongs in project instructions or assets, not in a profile's memory.
- **Transcript is shared.** Every roster profile sees the whole session, with each reply labelled by its speaker ("dev_test: …"). Compaction works per session as today; the summary keeps speaker labels.
- **Skills resolve against the addressed profile**: `@painter … $make-midjourney-prompt` uses painter's Skills.

### Managing the roster

- Project settings list the roster with add/remove and a Lead picker.
- In a project session, `/invite @painter` adds a profile and `/dismiss @painter` removes it. Both change the *project's* roster (shown as a notice in the session), not just that session's.
- Dismissing keeps the profile's earlier replies in the transcript; it just stops answering.
- Mentioning a profile that is not on the roster offers "Invite painter?" instead of failing.

## Addressing: `@` routing

`@name` already selects an execution device in a run objective (`@office`, `@"Home Mac"`; see [service API](service-api.md#execution-device-mentions)). Projects reuse the same `@`, resolved by name: **roster profiles first, then devices**. `@painter on @office …` means painter answers, executing on the office Mac.

- Profile and device names must not collide: creating or renaming a profile or device to a name used by the other is refused, so a mention is never ambiguous.
- Matching follows device mentions: case-insensitive, ending at punctuation. Profiles match by name (`@dev_test`); devices by name or id, quoted when they contain spaces (`@"Home Mac"`).

### Who answers

1. A message with one profile mention goes to that profile.
2. A message with no mention goes to **the last profile addressed** in this session (the floor). Follow-ups are the common case: after `@dev_test, which engine…`, "and for 2D?" still goes to dev_test.
3. A new session, or the first message after a multi-mention (below), goes to the **Lead**. `@<lead>` hands the floor back explicitly.
4. The composer always shows who will answer ("→ dev_test"), so the floor is never hidden.

### Several mentions in one message

`I want to listen to your thoughts, @dev_test, @app_tester` runs each mentioned profile **one after another, in mention order**, each as its own run on the same session.

- Each later speaker sees the earlier replies as labelled history; the user's message stays the prompt. Nobody's reply is fed to another profile as its prompt.
- **No chain reactions:** a profile mentioning another profile in its reply never starts a run.
- Cancel stops the current speaker and everyone queued after them. Approvals are asked per profile.
- Cost is roughly one run per speaker (each receives the conversation); it is the user's explicit choice.
- Sequential runs fit the existing rule that one run at a time writes a session; parallel runs would need that reworked.

This is a deliberate subset of group chat. Real group chat (profiles replying to each other, choosing when to speak or stay silent, a cap on profile-to-profile turns) is [deferred](#deferred); it can be added on top without changing how sessions are stored.

## Assets

Assets are the files a project's work builds on and produces. Attachments stay one-message inputs; assets last for the whole project.

### Kinds

- **Stored**: uploads and saved agent outputs, copied into marifold state on the host. They have versions: replacing `report.xlsx` adds v2 and keeps v1. Stored assets (all versions) count toward a per-project limit, `100 MB` by default and configurable.
- **Linked**: a file or folder on a named device, read live. Written as `@device/path`, e.g. `@home_mac_mini/~/tempfiles` or `@"Home Mac"/~/tempfiles`.
  - Without a tag, the link names the device the user is on when adding it; marifold fills the tag in and shows it, so a link is never ambiguous for a project used from several devices.
  - The device is stored by id and shown by its current name, so renaming a device keeps the link.
  - `~` is that device's home, the same rule as delegation.
  - An offline device's links show as unavailable; the agent's asset list says "home_mac_mini is offline" rather than failing on read.

Recommended practice for large or growing material: keep the files in a local folder and link it. Linked assets never count toward the limit, and the files stay where the user can open them.

### Scope

A project's assets belong to that project only. A profile's ordinary sessions outside the project cannot use them, and ordinary sessions have no assets of their own: `/add-dir` and trusted folders already make folders readable, run outputs stay downloadable with the reply that made them, and attachments cover one-off files.

When a quick chat grows into real work, **Move to project…** on a session moves it into a new or existing project (its profile joins the roster if needed). Files from that session, such as its run outputs, can then be added as project assets.

### Permissions

Reads are free and writes are gated, as everywhere else:

- A linked folder lets the project's profiles read inside it (a project-scoped read grant; reads of sensitive folders such as `~/.ssh` still ask, as they do today).
- Writing into a linked folder follows the writing profile's own permissions and approvals.
- Adding a run's output to stored assets needs no approval: it is marifold-owned and reversible (versions keep the previous content).

### How the agent sees assets

Assets are **not** sent to the model by default. Each run gets a short manifest (name, kind, device, type, size, version, one-line description) and reads content with tools only when needed:

- a `list_assets` / `read_asset` path for stored assets (linked ones use the normal file tools on their device, through delegation when remote);
- `save_asset` to store an output file (new asset or new version).

This keeps per-turn cost low, in line with the token-saving goal.

### Example

1. In "Game dev discuss", the user links `@home_mac_mini/~/tempfiles/sprites`.
2. `@dev_test make an Excel inventory of the sprites folder`: dev_test reads the linked folder, writes `sprites.xlsx`, and saves it as a project asset.
3. `@painter build a dashboard HTML from sprites.xlsx`: painter reads the stored asset and saves `dashboard.html`, which the Web UI can render (the Artifacts step).

## Web UI

- A **Projects** entry beside the **Agent** tab at the top right.
- Left column: the project list. Clicking a project turns it into that project's session list with a back arrow, the same drill-down as profiles (works on phones). Each session row shows small avatars of the profiles who spoke in it.
- Conversation: each reply shows the speaker's avatar and display name. The composer shows the answering profile and autocompletes `@` from the roster first, then devices.
- An **Assets** panel per project lists stored and linked assets with device, version, and availability; add by upload, from a run output ("Add to assets"), or by link (`@device/path`, with folder completion on the local device).
- Project settings: name, icon, instructions, roster, Lead, stored-asset limit.
- A profile session's row menu gains **Move to project…**, which opens a scrollable menu (like ChatGPT's): **New project** with a folder-plus icon at the top, a divider, then every project with its icon, sorted by name. Choosing a project moves the session at once; **New project** opens the create dialog (name, icon) and moves the session into the new project when it is created.

The TUI can follow later with the same commands (`/invite`, `/dismiss`, `@` routing); it is not needed for v1.

## Data model (sketch)

- `projects`: id, name, description, icon, instructions, lead profile, stored-asset limit, created/updated.
- `project_members`: project id, profile name, joined at.
- Sessions gain an optional `project_id`; a project session has no single owning profile. Each assistant turn's metadata records the answering profile (user turns record the addressed profiles).
- `assets`: id, project id, kind (stored or linked), name, description, media type, size; stored assets have versions (content addressed under the marifold state directory); linked assets store device id + device-relative path.

Today a session belongs to one profile, and session ownership, takeover between devices, and listing are built around that. Moving ownership to the project is the main implementation risk and must be verified live across devices, not only in unit tests.

## Relation to Artifacts

An Artifact is a stored HTML (or small app) asset rendered live in a sandboxed panel beside the conversation, with versions from later replies. Building Assets first leaves Artifacts mostly as the viewer and its sandbox, which SkillApps reuse.

## Deferred

- **Group chat**: profiles replying to each other, floor routing, silence, bounded profile-to-profile turns (the 2026-08-27 Topics and Teams design in `DEVLOG.md`).
- **Teams**: reusable profile rosters with a collaboration policy.
- TUI project support.
- Asset search and automatic descriptions for large folders.
