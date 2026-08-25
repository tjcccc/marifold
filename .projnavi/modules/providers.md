# Providers / priest boundary Module

marifold talks to models only through `@priest-ai/core`. The one provider marifold implements itself is the OpenAI-compatible adapter, because of Copilot's Responses API.

Use this note for: provider routing, GitHub Copilot, the Responses API path, tool wire-format mapping, credential refresh, or the provider registry.

- `config/MarifoldOpenAICompatProvider.ts` — implements the SDK `ProviderAdapter`. Routes chat-completions vs the Copilot **Responses API** (`endpointForModel`); maps tools on both paths incl. streaming function-call deltas.
- `config/ProviderRegistry.ts` — 21 provider entries (Ollama, OpenAI, Anthropic, DeepSeek, Bailian, Kimi, MiniMax, GitHub Copilot OAuth, ChatGPT OAuth, custom, ...). `GITHUB_COPILOT_RESPONSES_MODELS` lists responses-only models (e.g. gpt-5.4-mini); `isGitHubCopilotResponsesModelId` gates routing.
- `config/ProviderFactory.ts` — builds adapters from config.
- `config/GitHubCopilotAuth.ts` + `config/ChatGptTokenRefresh.ts` — OAuth credential refresh; dispatched by `MarifoldRuntime.refreshProviderCredentialsIfNeeded` before each provider call.
- Supported adapter types: `ollama`, `openai-compatible`, `anthropic`. Everything else maps onto `openai-compatible`.
