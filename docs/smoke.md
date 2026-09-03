# Smoke Checks

These checks exercise the migrated priests-style CLI surface without requiring a live model response.

Run them after `pnpm build` from the repo root.

Automated command matrix:

```bash
pnpm command-test
```

Provider-backed memory eval:

```bash
pnpm build
pnpm memory-eval -- --provider ollama --model gemma4:e4b --suite professional
```

The script discovers every current command and subcommand from `--help`, then runs isolated command flows in a temp marifold workspace with a mock Ollama/OpenAI-compatible HTTP server. It covers the noninteractive forms of the current commands and their options, including `init`, `config`, `profile`, `model`, `provider`, `ask`, `agent`, and `session`. New future commands are automatically included in the help discovery pass; add a targeted flow to `scripts/test-commands.mjs` when a future command has stateful behavior that should be smoke-tested.

Useful script options:

```bash
pnpm command-test -- --verbose
pnpm command-test -- --keep-temp
```

Manual spot checks:

```bash
tmp="$(mktemp -d)"

node packages/cli/dist/index.js --version

node packages/cli/dist/index.js \
  --config "$tmp/config.toml" \
  init \
  --profiles-dir "$tmp/profiles" \
  --sessions-db "$tmp/sessions.db"

node packages/cli/dist/index.js --config "$tmp/config.toml" config show
node packages/cli/dist/index.js --config "$tmp/config.toml" profile show default
node packages/cli/dist/index.js --config "$tmp/config.toml" profile memory default
node packages/cli/dist/index.js --config "$tmp/config.toml" model list
node packages/cli/dist/index.js --config "$tmp/config.toml" provider status

ANTHROPIC_API_KEY=test \
  node packages/cli/dist/index.js --config config.example.toml model validate claude-test --provider anthropic

rm -rf "$tmp"
```

Expected signals:

- `--version` prints the package version.
- `init` creates config, profile files, session DB path parent, and memory JSONL files.
- `profile show default` prints model and memory state plus profile file sections.
- `profile memory default` lists active structured memory records when records exist.
- `model list` shows the saved default provider/model option.
- `provider status` prints configured provider status rows.
- Anthropic validation returns a warning without network access when `ANTHROPIC_API_KEY` is set.
- `memory-eval` creates a temporary profile/session, sends a fixed prompt sequence, checks visible replies and JSONL memory state, and exits non-zero on failures.
