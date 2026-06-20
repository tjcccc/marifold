import type { Mode, NoticeTone } from './appState.js';

/**
 * Operations a `/command` can perform. The App implements this against the
 * live runtime and dispatcher; tests pass a fake to assert dispatch. Commands
 * are deterministic and never call the model — that is the design rule that
 * separates `/command` (code) from `$skill` (model-backed).
 */
export interface CommandContext {
  notify(text: string, tone?: NoticeTone): void;
  setMode(mode: Mode): void;
  newSession(): void;
  clear(): void;
  stop(): void;
  steer(text: string): void;
  exit(): void;
  setThink(on: boolean): void;
  openModelPicker(): void;
  openProfilePicker(): void;
  openSkills(): void;
  showPermissions(): void;
  showHelp(): void;
  showStatus(): void;
  copyLast(): void;
  showSessions(): void;
  runDoctor(): void;
  installSkill(arg: string): void;
  readFile(path: string): void;
  setImage(arg: string): void;
  remember(text: string): void;
  forget(query: string): void;
  deleteMemory(query: string): void;
}

export interface CommandSpec {
  name: string;
  /** Alternate invocations (e.g. quit → exit). */
  aliases?: string[];
  summary: string;
  run(ctx: CommandContext, args: string): void;
}

const COMMANDS: CommandSpec[] = [
  { name: 'help', summary: 'List commands and input syntax.', run: ctx => ctx.showHelp() },
  { name: 'status', summary: 'Show profile, mode, model, thinking, and session.', run: ctx => ctx.showStatus() },
  { name: 'copy', summary: "Copy the last response's original text to the clipboard.", run: ctx => ctx.copyLast() },
  { name: 'exit', aliases: ['quit'], summary: 'Leave the TUI.', run: ctx => ctx.exit() },
  { name: 'new', summary: 'Start a fresh session (clear transcript).', run: ctx => ctx.newSession() },
  { name: 'agent', summary: 'Switch to agent mode (default).', run: ctx => ctx.setMode('agent') },
  { name: 'chat', summary: 'Switch to chat mode.', run: ctx => ctx.setMode('chat') },
  { name: 'clear', summary: 'Clear the transcript.', run: ctx => ctx.clear() },
  { name: 'stop', summary: 'Cancel the running task.', run: ctx => ctx.stop() },
  {
    name: 'btw',
    summary: 'Steer the running task without cancelling it: /btw <text>.',
    run: (ctx, args) => {
      const text = args.trim();
      if (!text) ctx.notify('Usage: /btw <text>', 'warn');
      else ctx.steer(text);
    },
  },
  { name: 'model', summary: 'Pick the active model.', run: ctx => ctx.openModelPicker() },
  { name: 'profile', summary: 'Switch profile.', run: ctx => ctx.openProfilePicker() },
  { name: 'session', summary: 'List recent sessions.', run: ctx => ctx.showSessions() },
  {
    name: 'think',
    summary: 'Toggle thinking: /think on|off.',
    run: (ctx, args) => {
      const value = args.trim().toLowerCase();
      if (value === 'on') ctx.setThink(true);
      else if (value === 'off') ctx.setThink(false);
      else ctx.notify('Usage: /think on|off', 'warn');
    },
  },
  { name: 'permissions', summary: 'Show approval modes and active session grants.', run: ctx => ctx.showPermissions() },
  { name: 'skills', summary: 'List skills (Enter runs, Del removes).', run: ctx => ctx.openSkills() },
  {
    name: 'install-skill',
    summary: 'Install a skill: /install-skill <path>.',
    run: (ctx, args) => {
      const arg = args.trim();
      if (!arg) ctx.notify('Usage: /install-skill <path>', 'warn');
      else ctx.installSkill(arg);
    },
  },
  { name: 'doctor', summary: 'Check provider/model health.', run: ctx => ctx.runDoctor() },
  {
    name: 'read',
    summary: 'Read a file into context: /read <path>.',
    run: (ctx, args) => {
      const file = args.trim();
      if (!file) ctx.notify('Usage: /read <path>', 'warn');
      else ctx.readFile(file);
    },
  },
  {
    name: 'image',
    summary: 'Attach an image: /image <path> | /image clear.',
    run: (ctx, args) => ctx.setImage(args.trim()),
  },
  {
    name: 'remember',
    summary: 'Save a memory: /remember <text>.',
    run: (ctx, args) => {
      const text = args.trim();
      if (!text) ctx.notify('Usage: /remember <text>', 'warn');
      else ctx.remember(text);
    },
  },
  {
    name: 'forget',
    summary: 'Forget matching memories: /forget <query>.',
    run: (ctx, args) => {
      const query = args.trim();
      if (!query) ctx.notify('Usage: /forget <query>', 'warn');
      else ctx.forget(query);
    },
  },
  {
    name: 'delete-memory',
    summary: 'Delete matching memories: /delete-memory <query>.',
    run: (ctx, args) => {
      const query = args.trim();
      if (!query) ctx.notify('Usage: /delete-memory <query>', 'warn');
      else ctx.deleteMemory(query);
    },
  },
];

const REGISTRY = new Map<string, CommandSpec>();
for (const spec of COMMANDS) {
  REGISTRY.set(spec.name, spec);
  for (const alias of spec.aliases ?? []) REGISTRY.set(alias, spec);
}

export function listCommands(): CommandSpec[] {
  return COMMANDS;
}

export function findCommand(name: string): CommandSpec | undefined {
  return REGISTRY.get(name.toLowerCase());
}

/** Run a parsed command. Returns false when the name is unknown so the caller
 * can surface a hint. */
export function runCommand(ctx: CommandContext, name: string, args: string): boolean {
  const spec = findCommand(name);
  if (!spec) return false;
  spec.run(ctx, args);
  return true;
}
