---
name: projnavi
description: Use when the user asks to onboard projnavi, benchmark projnavi, or use projnavi guide for broad codebase navigation.
argument-hint: "onboard | benchmark | <task>"
---

<!-- projnavi-agent-claude:start -->
# projnavi

Use this project-local navigation layer before broad or ambiguous codebase work.

If `$ARGUMENTS` is `onboard`:

Run projnavi onboarding for this repo. Execute `projnavi onboard`, inspect the repo, improve the `.projnavi` project notes, module notes, flow notes, glossary, and claims for future guide queries, then run `projnavi onboard` again and `projnavi verify`. Update `CLAUDE.md` only if useful. Do not make unrelated code changes.

If `$ARGUMENTS` is `benchmark`:

Do not edit files. Based on the current project, choose a realistic complex codebase task. Dry-run investigation twice: first without projnavi using normal repo exploration, search, and file reads; then with projnavi by running `projnavi guide "<task>"` and inspecting only the recommended first-pass files. Measure wall time, command count, output bytes, output lines, approximate tokens, and qualitative relevance. Report a professional Markdown table, a compact shareable summary, whether projnavi pointed to the right files, and the caveat that approximate tokens are estimated from output bytes rather than model token accounting.

If `$ARGUMENTS` is empty:

Show the supported forms: `/projnavi onboard`, `/projnavi benchmark`, and `/projnavi <task>`. Do not run projnavi until the user provides an action or task.

Otherwise:

Run `projnavi guide "$ARGUMENTS"` and use the result as navigation advice only. Verify source files and tests before editing. Use projnavi first for high-entropy tasks such as cross-layer changes, frontend/display behavior, project-specific concepts, architecture-sensitive edits, provider integrations, scattered ownership, or unclear naming. For obvious single-slice backend/API tasks, normal search may be just as efficient; projnavi may still improve relevance, but may not reduce output size. Use `--max-items <n>` when you need to cap only the `Read first` list.
<!-- projnavi-agent-claude:end -->
