# CLAUDE.md

Project memory for Claude Code. Kept thin on purpose — this loads every turn.

## Authoritative docs (read for design; don't restate them)

- `AGENTS.md` — stack, package boundaries, validation gates.
- `docs/architecture.md` — runtime pieces, package rules, dependency directions, trust boundaries, glossary, decisions. Update it in the same change that moves a boundary.
- `docs/roadmap.md` / `docs/vision.md` — direction and milestone history.
- `DEVLOG.md` — newest-first change log. When older docs conflict with dated DEVLOG evidence, trust DEVLOG.
- `docs/workspaces.md`, `docs/device-execution.md`, `apps/bridge/HOSTING.md` — device-hosted workspaces, bridge, full-access execution.

## Working here

- Ownership: Claude Code is the primary developer again from 2026-10-08 (v0.79.1); v0.45–v0.79 were built mostly with Codex. `AGENTS.md` is the shared rulebook for both agents — put durable project rules there, keep this file to Claude-specific notes.
- Branches: work on `dev`; `main` receives `Merge branch 'dev'` merges. Toolchain, package boundaries, and lint rules are in `AGENTS.md`; enable the pre-commit hook once per clone (`git config core.hooksPath .githooks`).
- Live workspace/bridge testing uses disposable OrbStack Linux guests with isolated config/data, a private Headscale/Tailscale test tailnet, and a mocked model. Inspect the existing local setup first; never use the personal tailnet or real `~/.marifold` state for tests.
  - Cross-device workspaces are a core feature — verify workspace changes live, not only with unit tests.
  - Ubuntu arm64 VM `marifold-recovery-test` (`orb -m marifold-recovery-test -u root …`). Local, git-ignored harness in `output/bridge-review-orbstack/`: `setup-marifold.sh`/`setup-vpn.sh` provision the guest, `run.cjs` (delegation, Tailscale outage/recovery) and `run-full-access.cjs` (full-access jobs, sudo) drive the built `packages/*/dist` with temp `host-state-*` dirs and write `report.json`/`full-access-report.json`. Rebuild and redeploy the guest bundle first — paired devices require exactly matching versions.
  - Workflow: `pnpm -r build` → `output/bridge-review-orbstack/deploy-guest.sh` (copies dist into the guest bundle and restarts its bridge/guest services) → run a harness with `NODE_EXTRA_CA_CERTS=output/bridge-review-orbstack/guest-bundle/fixture-tls.crt` (self-signed bridge cert, valid until 2027-01-06; regenerate with the same `IP:192.168.139.54` SAN). `run-capacity.cjs [runs]` (delegation regression) and `run-rejoin.cjs` (offline host keeps a pairing; revoked guest rejoins) set a temp `HOME` so host runs never touch `~/.marifold`; `run.cjs` and `run-full-access.cjs` still use the real `~/.marifold/runs` for host runs and need the guest's `marifold-test-tailscale` service running.
  - Manual two-device Web preview for the user: `output/bridge-review-orbstack/preview-serve.cjs`, installed in the VM as `/home/tester/marifold-ui-preview/serve.cjs` with the current `dist` (systemd unit `marifold-ui-preview`; host UI `http://192.168.139.54:32240`, guest UI `:32241`; the bridge is throttled to `PREVIEW_BRIDGE_KBPS`, default 2000, so slow uploads are visible).
  - The user's real service listens on 32140 on this Mac; local CLI/TUI experiments use a temp `HOME` and `service start --port 0`.

<!-- projnavi-agent-claude-policy:start -->
## projnavi

Before broad or ambiguous codebase work, run `projnavi guide "<task>"` and use the result as navigation advice only — then verify the named files and line ranges before editing. Use the `/projnavi` skill for `onboard` and `benchmark` workflows.

`projnavi guide` is strongest for high-entropy tasks such as cross-layer changes, project-specific concepts, architecture-sensitive edits, provider integrations, scattered ownership, or unclear naming. Skip it for trivial single-file edits where the exact location is already known; plain `rg` is fine there. Use `--max-items <n>` to cap only the `Read first` list.

Maintenance is bounded: after changing files referenced by `.projnavi/claims.jsonl`, `.projnavi/glossary.json`, or `.projnavi` notes, run `projnavi onboard` then `projnavi verify` — not continuously.
<!-- projnavi-agent-claude-policy:end -->
