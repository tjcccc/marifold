# UI Spec

Project-layer UI rules for marifold's two visual surfaces: the Web UI (`apps/web`) and the terminal UI (`packages/tui`). Both render the same service contracts and `AgentEvent` stream, so a feature added to one should look and read like the same feature in the other.

## Scope

- This spec documents the existing visual system. Preserve it unless a redesign is requested; record deliberate changes here.
- The global UI principles (`~/.claude/docs/ui-principles.md`, mirrored in `~/.codex/docs/`) still apply. No template-layer guidance is used.
- Code structure is covered elsewhere: Web layer rules in `apps/web/README.md`, the mobile layout in its "Mobile layout" section, TUI behavior in `docs/tui.md`, and package boundaries in `docs/architecture.md`.
- Measured counts below were taken on 2026-10-09 and are a baseline, not targets.

## Stack

| Surface | Stack | Styling |
|---|---|---|
| Web UI | React 19, Vite, TypeScript | CSS Modules (`*.module.css` beside each component) over global tokens in `src/theme/palette.css` and resets in `src/theme/base.css`. No CSS framework, component library, or icon library. |
| TUI | Ink (React for terminals), TypeScript | Ink `<Text>`/`<Box>` props with the shared palette in `src/ui/theme.ts`. |

## Design direction

- Calm, native-feeling product UI in the macOS/iOS idiom: system fonts, neutral grey surfaces, hairline separators, soft elevation, and one warm accent.
- The accent is marigold `#EAA221`, used for brand marks, selection, focus, and primary actions, and shared by both surfaces.
- Light and dark modes are equal citizens; every Web color is defined for both.
- Original concept: `docs/design/marifold-web-concept.dc.html`. The shipped tokens in `palette.css` are authoritative where they differ.

## Web UI

### Tokens

All color, elevation, type-family, and radius values come from custom properties on `:root` in `src/theme/palette.css`, each defined once with `light-dark()`:

| Group | Tokens | Use |
|---|---|---|
| Brand | `--brand-fill`, `--on-brand`, `--brand-text`, `--brand-deep`, `--brand-tint`, `--brand-shadow` | `--brand-fill` keeps the exact marigold in both modes and pairs with the dark `--on-brand` label. Use `--brand-text` for accent-colored text and `--brand-tint` for selected rows, soft focus rings, and inline sheet outlines. |
| Surfaces | `--canvas`, `--content`, `--surface`, `--surface-2`, `--surface-3` | Chrome (navigation and sidebars) sits on `--canvas`; the working pane (thread, config detail, apps) sits on `--content`; cards, inputs, and sheets use `--surface`; `--surface-2`/`-3` are recessed fills. |
| Text | `--text`, `--text-2`, `--text-3` | Primary, secondary, and tertiary text. |
| Lines | `--separator`, `--separator-soft` | Hairline borders and dividers. |
| Semantic | `--ok`, `--danger` | Success and destructive or error states. There is no warning token yet. |
| Elevation | `--shadow-card`, `--shadow-sheet` | Selected segments and cards; floating sheets and popovers. |
| Type | `--font-ui`, `--font-mono` | System UI stack; system monospace stack for code. |
| Shape | `--radius-sm` 6px, `--radius-md` 10px, `--radius-lg` 14px | Small controls; buttons, inputs, and rows; sheets and cards. |

Rules:

- Use tokens in component CSS. Add a new token to `palette.css` (with both modes) rather than a raw color in a module.
- Theme preference is `auto`, `light`, or `dark` (`src/theme/theme.ts`, stored as `marifold.theme`). `auto` leaves `:root` without `data-theme`, so `color-scheme: light dark` follows the OS. An explicit choice sets `data-theme`, which forces `color-scheme`.
- Pills use `border-radius: 999px` and avatars or dots use `50%`; neither needs a token.

### Typography

- Body: `--font-ui` at 13px with line-height 1.45 (`base.css`); code and `pre` at 12px in `--font-mono`.
- Observed scale: 12px and 13px dominate (secondary text, rows, controls), with 12.5px, 11.5px, and 11px for metadata, 14px for emphasized rows and mobile controls, 16px for dialog titles and mobile inputs, and 20–24px for page and empty-state titles.
- Weights: 600 and 700 carry hierarchy, 650 is used for some labels, and 400/500 are rare.
- No type-scale tokens exist (see Open questions); reuse a size already used by a sibling component instead of adding a new one.

### Layout

- App shell (`App.tsx`): status notices (`role="status"`) above one `<main>` that hosts the Agent, Apps, or Config screen; connection and workspace popovers float above it.
- Desktop (900px and wider): a resizable primary sidebar (`ResizableSidebar`, 256px default, 200px minimum, at most 40% of the window, width persisted per sidebar, pointer and keyboard resizing) beside the working pane. Sidebars share `SidebarChrome` for the brand header, rows, and footer.
- Mobile (899px and narrower): a separate touch layout, not compressed columns. It uses list-to-detail drill-down, a bottom tab bar, bottom sheets, safe-area padding, and visual-viewport sizing for the on-screen keyboard; see the README's "Mobile layout". The breakpoint is `(max-width: 899px)` in CSS and in the `MOBILE_QUERY` constant used with `useMediaQuery`.
- Secondary breakpoints (560, 640, 720, 760, 360px) only adjust individual components.

### Components and patterns

- **Sheets** (`*Sheet.tsx`) are modal or inline panels on `--surface` with `--radius-lg` and `--shadow-sheet`. Modal sheets and confirmation dialogs sit over a darkening backdrop and become bottom sheets on mobile. The in-thread Approval and Question sheets are framed with a `--brand-tint` border and outline so they read as requests for the owner.
- **Banners** (`CatchUpBanner`, `SessionBlockedBanner`) sit at the top of the thread for state the owner must notice, with one primary action and an optional dismiss.
- **Controls:** `SegmentedControl` for small exclusive choices, native `<select>` with the chevron from `base.css`, and circular Send/Stop in the composer. Primary actions fill with `--brand-fill` and label with `--on-brand`.
- **Icons** are inline SVG components or small inline `<svg>` elements. `MarigoldLogo` is the brand mark and is colored with `--brand-fill`.
- **Focus:** inputs and controls show focus with a `--brand-fill` border or a 2px `--brand-fill` outline (`--brand-tint` for softer rings, `--danger` mixes on invalid fields).
- **Feedback:** progress uses small spinners or shimmer, plus explicit text such as "Sending…" or "Opening workspace…". Errors use `--danger` text with the reason, not color alone.

### Motion

- Transitions are short (100–160ms, `ease` or `ease-out`) and limited to color, background, opacity, and small push-in or pop-in moves for sidebars and sheets.
- Animated components switch their animation off under `@media (prefers-reduced-motion: reduce)` (one exception is listed in Open questions); do the same for new animations.

### Accessibility

- Icon-only buttons carry `aria-label`; decorative SVG uses `aria-hidden`.
- Dialogs set `aria-modal` with `aria-labelledby` and, where useful, `aria-describedby`; busy regions set `aria-busy`; toggles use `aria-pressed` or `aria-expanded`.
- Notices use `role="status"`. Keyboard paths exist for sidebar resizing and composer actions.

## TUI

### Palette

`src/ui/theme.ts` holds the shared hex colors. Truecolor terminals show them exactly, and Ink falls back to the nearest ANSI color elsewhere.

| Constant | Value | Use |
|---|---|---|
| `ACCENT` | `#EAA221` | Brand name, header and selector borders, selected items, run status verb. |
| `DIM_ACCENT` | `#87744F` | The `> ` prompt on submitted messages. |
| `DIM` | `#999999` | Secondary text, hints, separators, the status line, info blocks. |
| `ATTACHMENT` | `#3FB950` | Inline attachment tokens such as `[image #1]`. |
| `COMMAND` | `#A371F7` | Submitted `/command` echoes. |
| `SKILL` | `#56B6C2` | The `$skill` head of submitted skill invocations. |

Status colors use named ANSI colors so they follow the terminal theme: `red` for errors and deny, `yellow` for warnings and approval prompts, `green` for verified results, and `gray` for tool lines and info notices. Text attributes: `bold` for titles and selected items, `DIM` or `dimColor` for secondary text, `italic` only for Markdown emphasis, and no underline.

### Screen modes

- Full-screen (default): alternate screen, mouse editing, drag-to-copy, and a scrollable viewport (`FullScreen.tsx`).
- Inline (`--no-fullscreen` or `tui.fullscreen = false`): the transcript is committed to scrollback through Ink `<Static>`, with the input and status line pinned below.
- Launch flags, `MARIFOLD_FULLSCREEN`, and config precedence are in `docs/tui.md`.

### Layout and patterns

- **Header:** one rounded `ACCENT` box with three rows, each pairing a left identity segment with a right-aligned `DIM` hint.
- **Transcript rhythm:** one blank line between rows of different kinds; consecutive rows of the same kind (such as a stream of tool lines) stay tight (`topGap`).
- **Turns:** each submitted input is framed by `DIM` top and bottom rules and acts as the divider between turns. A plain message shows a `> ` prompt in `DIM_ACCENT`; `/command` and `$skill` echoes use their own colors.
- **Glyphs:** tool request `→` and result `←` (`✗` on error); plan steps `✓` done, `▶` in progress, `•` pending; `✓ verified` or `⚠ not verified` for verification.
- **Activity:** a braille spinner with `· verb… (detail) · esc to cancel` in `ACCENT` and `DIM`.
- **Status line:** `DIM` segments separated by ` | ` and ` · `.
- **Overlays:** rounded boxes with horizontal padding. Selectors and questions use an `ACCENT` border with a bold `ACCENT` title; approvals use a `yellow` border and title, a `red` escalation reason, and a single `gray` bordered detail block. Key hints bracket the key letter, as in `[d]eny`, with the rest of the word in `DIM`. A list row may carry a bracketed `yellow` status badge before its label, such as `[in use]`.

## Cross-surface consistency

- Use the same terms on both surfaces: profile, session, run, approval, workspace, device, Skill, SkillApp.
- Give a capability the same state and wording on both surfaces; for example, a session held elsewhere shows a Web banner with "Open here" and a TUI busy notice that names `--takeover`.
- Keep the accent for brand, selection, and primary action on both; do not introduce a second accent color.

## Open questions and known drift

Recorded so later work can decide deliberately; none of these is a redesign request.

1. **Type scale:** there are no font-size tokens, and Web CSS uses 20 distinct sizes. Decide whether to tokenize a scale before normalizing sizes.
2. **Radius literals:** these sit beside the radius tokens: `8px` (12 uses), `7px` (9), `6px` (8), `10px` (6), `9px` (3), `12px` (3). Map them to tokens or add a token only when touching a component.
3. **Raw colors in modules:**
   - `#d99b20` warning amber in `AppsScreen.module.css`, because there is no warning token.
   - `var(--danger, #c33)` fallback in `ProfileSettingsPage.module.css`.
   - Modal backdrops use three treatments: `color-mix(in srgb, #000 36%, transparent)` in four modules, `rgba(0, 0, 0, 0.32)` in `CreateProfileSheet` and `AvatarCropper`, and a `--text` 12% tint with `blur(2px)` in `ConnectionPopover`. A `--scrim` token is a candidate.
   - Image preview and cropper overlays use raw black/white alphas, which is likely intentional for media.
4. **Warning color:** the Web UI has no warning token, while the TUI uses `yellow`. Decide the Web value (likely a dedicated token rather than the brand color).
5. **Breakpoints:** `MOBILE_QUERY` is declared separately in `AgentScreen.tsx` and `ConfigScreen.tsx`, and `899px` is repeated across CSS modules; there is no shared breakpoint constant.
6. **Reduced motion:** the `RunCard.module.css` spinner has no `prefers-reduced-motion` rule.
7. **TUI palette:** `Markdown.tsx` keeps a local `CODE_COLOR` with the same value as `SKILL`, and status colors are named ANSI while brand colors are hex. Decide whether code color belongs in `theme.ts`.
