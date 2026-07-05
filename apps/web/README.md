# @marifold/web

The Marifold Web UI — a browser client over the service API (`docs/service-api.md`),
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
| `src/lib/` | Pure utilities: markdown token tree, formatting, permission resolution, hash routing. | Import React, api, or state. |
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
pnpm marifold service --cors-origin http://localhost:5173

# 2. Run the dev server (proxies nothing; talks straight to :32140):
pnpm --filter @marifold/web dev
```

`VITE_MARIFOLD_URL` overrides the dev service URL. If the service runs with a
token, set it in the app via the toolbar connection popover (⌁).

## Production

```sh
pnpm --filter @marifold/web build
pnpm marifold service --web-dir apps/web/dist        # or [service].web_dir in config.toml
```

Served same-origin, no CORS configuration needed; with a token configured,
auth covers `/v1/*` while the shell stays reachable.

## Tests

`pnpm --filter @marifold/web test` — unit (SSE parser, thread reducer,
follower reconnect, libs), component smoke (jsdom + testing-library), and an
integration suite that drives the real `ApiClient` against a real
`createMarifoldService` instance.
