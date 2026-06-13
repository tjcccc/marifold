# Flow: add or route a provider / model

1. Add a registry entry in `config/ProviderRegistry.ts` (name, label, type, default base URL, api key env, known models). Use type `openai-compatible` unless it is Ollama or Anthropic.
2. For OAuth providers, add credential prompts in `packages/cli/src/commands/model.ts` and a refresh path in core (see `GitHubCopilotAuth.ts` / `ChatGptTokenRefresh.ts`) dispatched by `MarifoldRuntime.refreshProviderCredentialsIfNeeded`.
3. Responses-API-only models (e.g. Copilot gpt-5.4-mini) go in `GITHUB_COPILOT_RESPONSES_MODELS`; routing is handled by `MarifoldOpenAICompatProvider.endpointForModel`.
4. `marifold model add <provider> <model>` persists to `[models].options`; validation via `ProviderInspector`.
