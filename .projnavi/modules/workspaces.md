# Workspaces and Bridge Module

Device-hosted workspaces: one device hosts profiles, sessions, Skills, Apps, schedules, and credentials; the owner's other devices join through an end-to-end encrypted relay. Docs: `docs/workspaces.md`, `docs/device-execution.md`, `apps/bridge/HOSTING.md`, and the trust boundaries in `docs/architecture.md`.

Use this note for: pairing, invitations, membership and revocation, the bridge relay, forwarding API requests to a host, running host runs on a guest device (executor), device delegation, or version matching between paired devices.

- `packages/workspace-protocol/src/` — wire types and limits (`types.ts`: `PROTOCOL_VERSION`, `WorkspaceMessage`, headers), identities, signing, membership certificates, and encryption (`identity.ts`). Shared by core and the bridge; no runtime or transport code.
- `packages/core/src/workspace/WorkspaceManager.ts` — pairing, invitations, revocation, presence, and one `BridgePeer` per workspace (`packages/core/src/workspace/bridge/BridgePeer.ts`, `ChunkTransfers.ts`); `WorkspaceStore.ts` persists identities, memberships, and the request/run journal beside the config.
- `packages/core/src/workspace/WorkspaceRuns.ts` routes runs to an execution device; `WorkspaceExecutor.ts` runs host-requested tools on a guest with its own capabilities and short-lived grants; `DeviceDelegateTool.ts` (`delegate_device`) and `WorkspaceDevicesTool.ts` (`list_devices`) let a host conversation delegate. `MarifoldVersion.ts` enforces same-release pairing; `ArtifactWebRtc.ts`/`WorkspaceArtifactTransfer.ts` move artifacts.
- Service: `packages/service/src/WorkspaceRoutes.ts` (`/v1/workspaces`, `workspaceApiPath` allowlist for forwarded `/v1/workspaces/:id/api/*`, host-only settings refused), `WorkspaceRequestContext.ts`. CLI: `packages/cli/src/commands/workspace.ts`. Client: `packages/client/src/workspaceStartup.ts`.
- `apps/bridge/src/index.ts` — `createBridge` relay server (authenticates members, forwards encrypted frames); `apps/bridge/src/Store.ts` — in-memory and Redis relay stores; `apps/bridge/src/serve.ts` — process entry.
- Paired devices must run the same release. Live testing uses the OrbStack harness described in `CLAUDE.md`.

Tests: `packages/core/tests/WorkspaceBridge.test.ts`, `packages/core/tests/WorkspaceRecovery.test.ts`, `packages/service/tests/MarifoldWorkspaces.test.ts`, `apps/bridge/tests/Bridge.test.ts`, `packages/workspace-protocol/tests/identity.test.ts`.
