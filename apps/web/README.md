# @marifold/web

The marifold Web UI — a browser client over the service API (`docs/service-api.md`),
rendering the same contracts the TUI renders. Design reference:
`docs/design/marifold-web-concept.dc.html` (marigold `#EAA221` system, light + dark).

## Module responsibilities

The layout enforces a one-way dependency flow; each layer has one job:

```
screens/ ──► components/ ──► state/ ──► api/ ──► theme
   │              │             │         │
   └──────────────┴──────► lib/ ◄─────────┘
```

| Layer | Owns | May not |
|---|---|---|
| `src/api/` | Talking to the service: fetch wrapper, SSE parser, typed route wrappers, the `followRun` reconnect loop. The only layer that knows URLs. | Import React. |
| `src/state/` | The domain model: `threadReducer` (session turns + chat streams + run cards in one thread) and `RunFollowers`. Pure and unit-tested. | Import React or fetch directly. |
| `src/lib/` | Pure utilities: markdown token tree, formatting, permission resolution, clean-path routing. | Import React, api, or state. |
| `src/components/` | Shared presentational React (SegmentedControl, Markdown, ConnectionPopover…). Props in, callbacks out. | Fetch data or hold business rules. |
| `src/screens/` | Composition per view (`agent/`, `apps/`, `config/`): hooks, controllers, dispatch. The only layer that wires api + state + components together. | — |
| `src/theme/` | `palette.css` (design tokens once, via `light-dark()`), `base.css`, `useTheme`. | — |

`src/api/types.ts` is the single file importing from `@marifold/core`, and only
with `import type` — the wire contract stays one source of truth while the
Node-only core never reaches the browser bundle (`verbatimModuleSyntax` turns a
slip into a compile error).

## Development

```sh
# 1. Run the service with the Vite dev origin allowed:
marifold service --cors-origin http://127.0.0.1:5173

# 2. Run the dev server (proxies nothing; talks straight to :32140):
pnpm --filter @marifold/web dev
```

`VITE_MARIFOLD_URL` overrides the dev service URL. If the service runs with a
token, set it in the app through the sidebar's Connection sheet.

## Server connections

The Connection sheet keeps a named list of marifold services. **This server**
uses the origin that delivered the Web UI; additional entries use an explicit
HTTP(S) service root and their own bearer token. A candidate is saved and made
active only after its `/v1/status` response identifies a compatible marifold v1
service. Switching servers remounts the data-owning screens and namespaces the
last Agent route and composer drafts by server, preventing one server's
profiles or sessions from remaining in another server's workspace.

An explicit remote URL is cross-origin from the local shell, so its service
must allow the shell's exact origin with `[service].cors_origins`. Directly
opening the Web UI hosted by the remote service remains same-origin and needs
no CORS entry.

## Production

```sh
marifold service # npm installs serve the bundled Web UI at http://127.0.0.1:32140
```

Served same-origin, no CORS configuration needed; with a token configured,
auth covers `/v1/*` while the shell stays reachable. Source builds stage this
app into `@marifold/service`; `[service].web_dir` or `--web-dir` remains an
override for a different built bundle.

## Attachments

The composer accepts images, plain-text/code files, and modern Microsoft Office
files: Word `.docx`, Excel `.xlsx`, and PowerPoint `.pptx`. Office files are
OOXML ZIP archives; marifold opens them locally in the browser, extracts text
with useful paragraph/slide/sheet structure, and inlines that text into the model
prompt. In chat mode the original binary stays in the browser. In agent mode it
is additionally staged by the local service as a read-only file in the private
run workspace so file tools can inspect it; raw Office bytes are not sent to the
model.

While the selected conversation is responding, the circular Send control
becomes Stop. It cancels a live agent run through the service run API or aborts
a plain chat stream; partial chat text already received remains visible.

Submitted `$skill [args]` turns are resolved by `/v1/skills/resolve` before a
model run starts. The service expands the selected profile/global skill once;
the Web UI runs those instructions without prior skill-turn history and keeps
the original `$skill …` text in the transcript.

The Apps view renders global `~/.marifold/apps/<name>/skillapp.ts` bundles from
the service's normalized JSON contract. Agent and Apps share one persistent
desktop shell: switching tabs changes only the sidebar catalog body and
right-pane content, preserving the marifold brand, system footer, sidebar
width/visibility, and header controls. Apps renders no profile/session list,
transcript, or composer. It supports semantic row/column form layouts,
service-owned state, direct buttons, and debounced latest-wins operations over
an app-local Skill and explicit model. A workspace footer exposes the App
version and an Activity drawer for runs, genuine warnings/errors, latency, and
token use; missing required input remains a silent idle form state. See
`docs/app.md` and `examples/apps/translator`.

## Profile navigation

The primary sidebar treats profiles like contacts: 40 px avatars, one-line
previews from the latest assistant response, a relative activity time, and
recent-session ordering. Pinned profiles remain above the activity-sorted list
and use the same glyph as pinned sessions. Each row's hover/focus menu can
pin/unpin the profile or open its Config page.

Profile Config includes confirmed removal for stored profiles. The configured
default profile must be changed first, active requests must finish or be
cancelled, and the built-in `default` profile cannot be removed. The user must
type the exact profile name in the destructive dialog before its final action
enables. Removal deletes the profile directory (instructions, memories, skills,
and avatar) but preserves its SQLite conversation history.

Provider Config uses the same typed-confirmation pattern. A provider cannot be
removed while it is the global default or referenced by a profile override.
Removal clears its local credentials/config and saved model options without
touching provider-owned models or remote accounts. OAuth provider pages expose
a **Re-authenticate…** dialog with a copyable
`marifold provider reauth <provider>` command. The command runs on the
service host because a remotely forwarded browser's loopback callback points at
the client machine, not the Mac hosting marifold.

Completed chat and agent responses show a shared time/token/reasoning/cost
footer. The service persists those content-free metrics by session and stable
user-turn ordinal, so the footer survives navigation, page reload, and service
restart; providers that omit a usage field simply leave that field hidden.

Agent clarification sheets render ordinary questions as radio choices and
questions marked `multiple` as “select all that apply” checkboxes. A
multi-select answer may combine suggested choices with “Something else” text;
the run resumes only after every question has a complete answer.

Office source files are limited to 16 MiB, selected expanded XML to 8 MiB, and
extracted prompt text to 256 KiB. Embedded images, charts, complex formatting,
macros, password-protected/encrypted files, and legacy `.doc`/`.xls`/`.ppt`
binaries are not interpreted.

## Tests

`pnpm --filter @marifold/web test` — unit (SSE parser, thread reducer,
follower reconnect, libs), component smoke (jsdom + testing-library), and an
integration suite that drives the real `ApiClient` against a real
`createMarifoldService` instance.

`pnpm --filter @marifold/web test:e2e` builds the relevant packages, starts a
real service over disposable profile/session storage, and runs the desktop
workspace flows in Chromium, including profile/session search, Office uploads,
archive/drafts, image galleries, accessible dialogs, and global settings. Browser artifacts stay under
`output/playwright/`.
