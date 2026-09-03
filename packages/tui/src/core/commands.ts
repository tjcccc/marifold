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
  /** Persist `mode` as the current profile's default (profile.toml) and apply it now. */
  setDefaultMode(mode: Mode): void;
  newSession(): void;
  clear(): void;
  stop(): void;
  steer(text: string): void;
  exit(): void;
  setThink(on: boolean): void;
  openModelPicker(): void;
  openProfilePicker(): void;
  selectProfile(name: string): void;
  openSkills(scope?: 'global' | 'profile'): void;
  showPermissions(): void;
  showHelp(): void;
  showStatus(): void;
  /** Arm a one-shot forced plan for the next message (toggles off if armed). */
  toggleForcePlan(): void;
  copyLast(): void;
  /** Re-run the last plain-text message through the current profile/model/mode. */
  retryLast(): void;
  /** Send one prompt with attached images preserved byte-for-byte. */
  sendOriginal(text: string): void;
  showSessions(): void;
  runDoctor(fix?: boolean): void;
  installSkill(arg: string): void;
  readFile(path: string): void;
  setImage(arg: string): void;
  remember(text: string): void;
  forget(query: string): void;
  deleteMemory(query: string): void;
  /** Show the current context budget + usage. */
  showContextWindow(): void;
  /** Set the context budget for this session (tokens), or 0/undefined to disable. */
  setContextWindow(tokens?: number): void;
  /** Persist the context budget as the current profile's default (profile.toml). */
  setDefaultContextWindow(tokens?: number): void;
  /** Compact the current session now (model-backed). */
  compactNow(): void;
  /** Trust a folder for the active profile — file writes there won't prompt. */
  trustFolder(path: string): void;
}

export interface CommandSpec {
  name: string;
  /** Alternate invocations (e.g. quit → exit). */
  aliases?: string[];
  summary: string;
  run(ctx: CommandContext, args: string): void;
}

export interface CommandCompletion {
  name: string;
  hint: string;
}

const COMMANDS: CommandSpec[] = [
  { name: 'help', summary: 'List commands and input syntax.', run: ctx => ctx.showHelp() },
  { name: 'status', summary: 'Show profile, mode, model, thinking, and session.', run: ctx => ctx.showStatus() },
  { name: 'copy', summary: "Copy the last response's original text to the clipboard.", run: ctx => ctx.copyLast() },
  { name: 'retry', aliases: ['regenerate'], summary: 'Re-run your last message (e.g. after /model to compare).', run: ctx => ctx.retryLast() },
  {
    name: 'attach-original',
    summary: 'Send attached images unchanged for this message: /attach-original <prompt>.',
    run: (ctx, args) => {
      const text = args.trim();
      if (!text) ctx.notify('Usage: /attach-original <prompt>', 'warn');
      else ctx.sendOriginal(text);
    },
  },
  { name: 'exit', aliases: ['quit'], summary: 'Leave the TUI.', run: ctx => ctx.exit() },
  { name: 'new', summary: 'Start a fresh session (clear transcript).', run: ctx => ctx.newSession() },
  {
    name: 'agent',
    summary: 'Agent mode: /agent (this session) or /agent default (save to profile).',
    run: (ctx, args) => (args.trim() === 'default' ? ctx.setDefaultMode('agent') : ctx.setMode('agent')),
  },
  {
    name: 'chat',
    summary: 'Chat mode: /chat (this session) or /chat default (save to profile).',
    run: (ctx, args) => (args.trim() === 'default' ? ctx.setDefaultMode('chat') : ctx.setMode('chat')),
  },
  { name: 'clear', summary: 'Clear the transcript.', run: ctx => ctx.clear() },
  { name: 'steps', summary: 'Force a step-by-step plan on your next message (one-shot).', run: ctx => ctx.toggleForcePlan() },
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
  {
    name: 'profile',
    summary: 'Switch profile: /profile [name] (omit name for a picker).',
    run: (ctx, args) => {
      const name = args.trim();
      if (name) ctx.selectProfile(name);
      else ctx.openProfilePicker();
    },
  },
  {
    name: 'resume',
    aliases: ['session'],
    summary: 'Resume a recent session from an interactive picker.',
    run: ctx => ctx.showSessions(),
  },
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
  {
    name: 'trust-folder',
    summary: 'Trust a folder for this profile: /trust-folder <path> (writes there stop asking).',
    run: (ctx, args) => {
      const target = args.trim();
      if (!target) ctx.notify('Usage: /trust-folder <path>', 'warn');
      else ctx.trustFolder(target);
    },
  },
  {
    name: 'skills',
    summary: 'Manage skills: /skills (this profile) or /skills --global.',
    run: (ctx, args) => ctx.openSkills(args.trim() === '--global' ? 'global' : 'profile'),
  },
  {
    name: 'install-skill',
    summary: 'Install a skill: /install-skill [--global] <path|url>.',
    run: (ctx, args) => {
      const arg = args.trim();
      if (!arg) ctx.notify('Usage: /install-skill <path>', 'warn');
      else ctx.installSkill(arg);
    },
  },
  {
    name: 'doctor',
    summary: 'Check health; /doctor --fix migrates this profile\'s legacy instructions.',
    run: (ctx, args) => {
      const value = args.trim();
      if (!value) ctx.runDoctor(false);
      else if (value === '--fix') ctx.runDoctor(true);
      else ctx.notify('Usage: /doctor [--fix]', 'warn');
    },
  },
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
  {
    name: 'context-window',
    aliases: ['ctx'],
    summary: 'Context budget: /context-window, set <tokens|off> [default].',
    run: (ctx, args) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) { ctx.showContextWindow(); return; }
      if (parts[0].toLowerCase() !== 'set') {
        ctx.notify('Usage: /context-window [set <tokens|off> [default]]', 'warn');
        return;
      }
      const toDefault = parts[2]?.toLowerCase() === 'default';
      const raw = (parts[1] ?? '').toLowerCase();
      if (raw === 'off') {
        if (toDefault) ctx.setDefaultContextWindow(undefined); else ctx.setContextWindow(undefined);
        return;
      }
      const tokens = parseTokens(raw);
      if (tokens == null) {
        ctx.notify('Usage: /context-window set <tokens|off> [default] (e.g. 16000 or 16k)', 'warn');
        return;
      }
      if (toDefault) ctx.setDefaultContextWindow(tokens); else ctx.setContextWindow(tokens);
    },
  },
  { name: 'compact', summary: 'Compact the current session now (summarize older turns).', run: ctx => ctx.compactNow() },
];

/** Parse a token count: "16000" or "16k"/"16K" → 16000. Returns undefined when invalid. */
function parseTokens(raw: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(k)?$/i.exec(raw);
  if (!match) return undefined;
  const value = Number(match[1]) * (match[2] ? 1000 : 1);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

const REGISTRY = new Map<string, CommandSpec>();
for (const spec of COMMANDS) {
  REGISTRY.set(spec.name, spec);
  for (const alias of spec.aliases ?? []) REGISTRY.set(alias, spec);
}

export function listCommands(): CommandSpec[] {
  return COMMANDS;
}

/** Canonical command names plus discoverable aliases for the input menu. */
export function listCommandCompletions(): CommandCompletion[] {
  return COMMANDS.flatMap(spec => [
    { name: spec.name, hint: spec.summary },
    ...(spec.aliases ?? []).map(alias => ({
      name: alias,
      hint: `Alias for /${spec.name}. ${spec.summary}`,
    })),
  ]);
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
