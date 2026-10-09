# Providers / priest boundary Module

marifold talks to models only through `@priest-ai/core` (`../priest-typescript`). The SDK owns request bodies, streaming, tool-call wire mapping, reasoning, and usage parsing; marifold owns provider selection, endpoint routing, subscription headers, and credentials.

Use this note for: provider routing, GitHub Copilot, ChatGPT/xAI subscription OAuth, the Responses API path, hosted web search, credential refresh, or the provider registry.

- `packages/core/src/runtime/ProviderEngines.ts` — `create` builds a `PriestEngine` per provider; `refreshCredentials` refreshes OAuth credentials (GitHub Copilot, ChatGPT, xAI) before each chat turn and agent run; `priestConfig` builds the Priest request config (limits, reasoning, hosted-search options); `supportsThink`.
- `packages/core/src/config/OAuthCredentials.ts` — `withOAuthCredentials` serializes refreshes per config/provider and persists rotated tokens; `ChatGptTokenRefresh.ts`, `XaiTokenRefresh.ts`, `GitHubCopilotAuth.ts` perform the exchanges.
- `packages/core/src/config/MarifoldOpenAICompatProvider.ts` — wraps the SDK's `OpenAICompatProvider` and `OpenAIResponsesProvider`; `endpointForRequest` sends ChatGPT, Copilot Responses-only models, and hosted-search requests to Responses and everything else to Chat Completions; adds Copilot/ChatGPT headers.
- `packages/core/src/config/ProviderFactory.ts` — builds adapters by type (`ollama`, `openai-compatible`, `anthropic`) and resolves `nativeWebSearchStrategy` (Responses tool, Bailian chat option, or none).
- `packages/core/src/config/ProviderRegistry.ts` — registry entries (local runtimes, API providers, OAuth providers `github_copilot`/`chatgpt`/`xai`, `custom`); every non-Ollama, non-Anthropic entry uses `openai-compatible`. `GITHUB_COPILOT_RESPONSES_MODELS` + `isGitHubCopilotResponsesModelId` gate Copilot Responses routing.
- `packages/core/src/config/ProviderInspector.ts` — provider status, model listing, and model validation (no deletion).
- CLI sign-in: `packages/cli/src/input/ModelPicker.ts` with `packages/cli/src/auth/`.

Tests: `packages/core/tests/MarifoldOpenAICompatProvider.test.ts`, `packages/core/tests/OAuthCredentials.test.ts`, `packages/core/tests/NativeWebSearch.test.ts`, `packages/core/tests/ProviderInspector.test.ts`.
