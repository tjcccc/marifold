# Workflow Composition — Ongoing Design Plan

This is a living design document for marifold's future multi-profile and
multi-model workflow system. It records the current direction and open
questions; it is not an implementation commitment or a frozen schema.

## Product boundary

Workflows should make marifold a lightweight orchestration layer for profiles,
models, Skills, and Apps. They should not turn marifold into a heavyweight
coding agent or project/goal manager. Long-running repository work remains a
better fit for tools such as Codex and Claude Code.

The central rule is:

> One declarative workflow definition, executed by one shared runtime through
> multiple interfaces.

## Interfaces and triggers

The workflow runtime should be owned by `packages/core`. Every client should
use the same definitions, run state, events, approvals, and output contracts.

- **CLI** — create, edit, validate, run, inspect, and list workflows.
- **TUI** — list, run, monitor, cancel, and approve workflow runs. A graph
  editor is not a TUI requirement.
- **Web UI** — visually author workflows and inspect their execution timeline,
  node outputs, approvals, failures, and reruns.
- **Chat** — optionally trigger an existing workflow through a small command
  such as `/workflow run make-news-to-word`.
- **Scheduler** — invoke the same workflow runtime with declared inputs.
- **Service API** — expose the transport-neutral workflow and run contracts
  used by all clients.

Execution should be available across CLI, TUI, and Web UI even if the first
authoring experience is TOML plus CLI scaffolding.

## CLI direction

The CLI should manipulate the same files that users can edit by hand. It must
not become a second configuration system.

```bash
marifold workflow init make-news-to-word

marifold workflow node add make-news-to-word \
  --profile news-collector \
  --name get-news

marifold workflow node add make-news-to-word \
  --profile office-lady \
  --name make-word

marifold workflow validate make-news-to-word
marifold workflow run make-news-to-word
marifold workflow inspect make-news-to-word
```

Likely supporting commands:

```bash
marifold workflow list
marifold workflow show make-news-to-word
marifold workflow runs make-news-to-word
marifold workflow run make-news-to-word --input topic="AI news"
```

An explicit `run` subcommand keeps execution distinct from workflow-management
operations.

## Definition layout

Proposed user-level storage:

```text
~/.marifold/workflows/
└── make-news-to-word/
    ├── workflow.toml
    ├── nodes/
    │   ├── get-news.toml
    │   └── make-word.toml
    └── prompts/
        ├── get-news.md
        └── make-word.md
```

`workflow.toml` owns graph-level inputs, nodes, edges, and run policy:

```toml
version = 1
name = "make-news-to-word"
description = "Collect recent news and produce a Word report."

[inputs]
topic = { type = "string", required = true }

[run]
failure_policy = "stop"
max_parallel = 2

[[nodes]]
id = "get-news"
config = "nodes/get-news.toml"

[[nodes]]
id = "make-word"
config = "nodes/make-word.toml"

[[edges]]
from = "get-news.news"
to = "make-word.news"
```

A profile node declares only the capabilities and values needed for its task:

```toml
version = 1
profile = "news-collector"
prompt_file = "../prompts/get-news.md"
skills = ["search-news"]

[inputs]
topic = "workflow.topic"

[outputs.news]
type = "json"
required = true
```

The downstream document node consumes the declared output, not the preceding
node's transcript:

```toml
version = 1
profile = "office-lady"
prompt_file = "../prompts/make-word.md"
skills = ["documents"]

[inputs]
news = "get-news.news"

[outputs.document]
type = "file"
formats = ["docx"]
required = true
```

Inline prompts may be supported, but separate prompt files are easier to edit,
review, and reuse.

## Execution and isolation

Every invocation receives a workflow run ID and a persistent run directory:

```text
~/.marifold/runs/<workflow-run-id>/
├── inputs/
├── nodes/
│   ├── get-news/
│   └── make-word/
├── outputs/
├── events.jsonl
└── run.json
```

Each node should receive:

- a fresh model context;
- its selected profile and that profile's default model, with an optional
  explicit node override;
- only its declared skills and upstream inputs;
- a node-specific workspace;
- the normal marifold approval and filesystem policies.

Node history must be isolated. A downstream profile must not inherit an
upstream transcript, cached skill instructions, or unrelated conversation
context. Data crosses node boundaries only through declared, validated inputs
and outputs.

Initial output types:

- `text`
- `json`
- `file`
- `files`

Structured outputs are a core reliability boundary. A node's output must not
mean merely "whatever the model said last."

Workflow runs should produce renderer-neutral events so CLI, TUI, Web UI, and
future clients can show the same state: queued, running, waiting for approval,
completed, failed, cancelled, and skipped.

## Scheduling and approvals

Schedules should remain separate from workflow definitions. A workflow
describes what happens; a schedule describes when a particular machine should
run it.

```bash
marifold schedule add daily-news \
  --workflow make-news-to-word \
  --cron "0 8 * * *" \
  --input topic="AI"
```

The Web UI may show schedules associated with a workflow without embedding
machine-specific trigger policy into `workflow.toml`.

Scheduled runs must never bypass the existing approval system. If an unattended
node needs an unapproved capability, the run pauses in a waiting-for-approval
state.

## First implementation boundary

The first release should remain deliberately constrained:

- directed acyclic graphs;
- profile nodes;
- explicit inputs and outputs;
- sequential and parallel execution;
- stop/continue failure policy;
- manual and scheduled triggers;
- cancellation and approval;
- rerun a failed node or the entire workflow;
- durable run status and artifacts.

Defer until real use demonstrates a need:

- loops;
- dynamic graph generation;
- arbitrary conditions;
- embedded scripting;
- a general-purpose workflow programming language;
- goal/project management.

## Relationship to Apps

Workflows and Apps should share typed variables, approval vocabulary,
actor/model invocation, and artifact handling. A later App action may invoke a
workflow, and a workflow may eventually use an App as a node:

```toml
type = "app"
app = "document-reviewer"
```

The intended composition is:

```text
Workflow
  -> profile/model nodes
  -> skill nodes
  -> App nodes
  -> structured artifacts
```

Profile nodes are the appropriate first implementation. Skill and App
nodes should be added only after their input/output and UI contracts are
stable.

## Open design questions

These points remain intentionally unresolved:

1. Whether workflow and node schemas use numeric `version` fields or namespaced
   schema identifiers such as `marifold.workflow.v0`.
2. Whether node model overrides are necessary in v0 or whether distinct
   profiles are the only model-selection mechanism.
3. How JSON output schemas are declared and validated without making the
   definition format cumbersome.
4. Whether rerunning one node invalidates all descendants automatically or
   offers the user a choice.
5. How workflow runs and node sessions appear in ordinary session history.
6. Which deterministic node types, if any, belong in the first release.
7. How the Web UI graph editor represents artifacts, approvals, and parallel
   branches without becoming a developer-only tool.
8. How workflow definitions are exported, imported, and shared safely.

Update this document as discussion resolves these questions. Move stable
contracts into dedicated specifications only when implementation begins.
