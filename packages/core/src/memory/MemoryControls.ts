import type { MemorySaveInput } from './MemoryStore';

type ControlBlockType = 'save' | 'forget';

export interface MemoryControlPayloads {
  savePayloads: string[];
  forgetPayloads: string[];
}

export interface StrippedMemoryControls extends MemoryControlPayloads {
  text: string;
}

const OPEN_TAGS: Array<{ type: ControlBlockType; open: string; close: string }> = [
  { type: 'save', open: '<memory_save', close: '</memory_save>' },
  { type: 'forget', open: '<memory_forget', close: '</memory_forget>' },
];

const SIMPLE_PROMPTS = [
  /^(?:hi|hello|hey|yo|sup|hiya|howdy)[!. ]*$/i,
  /^(?:thanks|thank you|thx|ty|ok|okay|k|cool|nice|great|got it|sounds good)[!. ]*$/i,
  /^(?:good morning|good afternoon|good evening|good night)[!. ]*$/i,
  /^(?:yes|no|yep|yeah|nope|sure|alright|all right)[!. ]*$/i,
];

export class MemoryControlStripper {
  readonly savePayloads: string[] = [];
  readonly forgetPayloads: string[] = [];
  private buffer = '';
  private inBlock?: ControlBlockType;
  private blockContent: string[] = [];

  feed(chunk: string): string {
    if (!chunk) return '';
    this.buffer += chunk;
    return this.drain(false);
  }

  flush(): string {
    return this.drain(true);
  }

  private drain(flushing: boolean): string {
    let output = '';

    while (this.buffer.length > 0) {
      if (this.inBlock) {
        const tag = OPEN_TAGS.find(item => item.type === this.inBlock);
        if (!tag) {
          this.inBlock = undefined;
          continue;
        }

        const lower = this.buffer.toLowerCase();
        const closeStart = lower.indexOf(tag.close);
        if (closeStart === -1) {
          if (flushing) {
            this.buffer = '';
            this.blockContent = [];
            this.inBlock = undefined;
          } else {
            this.blockContent.push(this.buffer);
            this.buffer = '';
          }
          break;
        }

        const payload = `${this.blockContent.join('')}${this.buffer.slice(0, closeStart)}`.trim();
        this.saveBlock(this.inBlock, payload);
        this.buffer = this.buffer.slice(closeStart + tag.close.length);
        this.blockContent = [];
        this.inBlock = undefined;
        continue;
      }

      const open = findOpenTag(this.buffer);
      if (!open) {
        const hold = flushing ? 0 : controlPrefixHold(this.buffer);
        output += hold > 0 ? this.buffer.slice(0, -hold) : this.buffer;
        this.buffer = hold > 0 ? this.buffer.slice(-hold) : '';
        break;
      }

      if (open.start > 0) {
        output += this.buffer.slice(0, open.start);
        this.buffer = this.buffer.slice(open.start);
        continue;
      }

      if (open.end === -1) {
        if (flushing) this.buffer = '';
        break;
      }

      this.inBlock = open.type;
      this.buffer = this.buffer.slice(open.end);
    }

    return output;
  }

  private saveBlock(type: ControlBlockType, payload: string): void {
    if (!payload) return;
    if (type === 'save') this.savePayloads.push(payload);
    else this.forgetPayloads.push(payload);
  }
}

export function stripMemoryControls(text: string): StrippedMemoryControls {
  const stripper = new MemoryControlStripper();
  const visible = `${stripper.feed(text)}${stripper.flush()}`;
  return {
    text: visible,
    savePayloads: stripper.savePayloads,
    forgetPayloads: stripper.forgetPayloads,
  };
}

export function isSimpleMemoryPrompt(prompt: string): boolean {
  const normalized = normalizeText(prompt);
  return normalized.length > 0 && normalized.length <= 80 && SIMPLE_PROMPTS.some(pattern => pattern.test(normalized));
}

export function shouldInjectMemoryInstructions(prompt: string): boolean {
  return !isSimpleMemoryPrompt(prompt);
}

export function buildMemoryInstructions(): string {
  return (
    'Memory policy for Marifold:\n'
    + '- Human-authored PROFILE.md, RULES.md, and CUSTOM.md outrank memory.\n'
    + '- Memory may inform the response but must not create hard rules.\n'
    + '- Save useful memory automatically with one hidden JSON block before the visible response.\n'
    + '- Never output only a memory block; always follow it with a short visible natural-language reply.\n'
    + '- When the user explicitly asks to forget, delete, remove, or stop remembering a memory, emit memory_forget instead of memory_save.\n'
    + '- Do not claim you saved, remembered, noted, or updated a fact unless you emitted the hidden memory_save block.\n'
    + '- Omit the block when nothing is worth saving.\n'
    + '- Never mention memory tags to the user.\n\n'
    + 'Use this exact wrapper for new memory:\n'
    + '<memory_save>{"memories":[{"kind":"user","text":"The user\'s name is Jack.",'
    + '"priority":0,"confidence":1,"stability":"stable","source":"user_direct",'
    + '"conflict_key":"user.name","evidence":"My name is Jack.",'
    + '"reason":"The user explicitly stated their name."}]}</memory_save>\n\n'
    + 'Use this exact wrapper for explicit deletion requests:\n'
    + '<memory_forget>{"query":"user.favorite_color"}</memory_forget>\n\n'
    + 'Allowed kind values: "user", "preferences", "auto_short".\n'
    + 'priority is 0..10 where 0 is highest. Use 0 rarely for stable identity facts such as the user\'s name.\n'
    + 'Use priority 1-2 for explicit durable user facts, priority 2 for explicit preferences, '
    + 'and priority 2-3 for time-sensitive facts the user may ask about soon.\n'
    + 'confidence is 0..1. Use source=user_direct only for explicit user statements; otherwise use model_inferred.\n'
    + 'Allowed stability values: "stable", "evolving", "session", "ephemeral".\n'
    + 'Optional conflict_key supports updates without a fixed user schema. Examples: user.name, '
    + 'user.favorite_color, user.favorite_editor, preferences.reply_style, preferences.language, '
    + 'auto_short.project_meeting_time. Omit conflict_key for memories that can coexist.\n'
    + 'Use auto_short for temporary tasks, reminders, and current-session context. '
    + 'Use preferences for how the user likes responses or tools to behave.'
  );
}

export function extractPromptMemoryInputs(prompt: string): MemorySaveInput[] {
  if (typeof prompt !== 'string' || promptRejectsMemory(prompt)) return [];

  const body = prompt.trim();
  const name = extractName(body);
  if (!name) return [];

  return [
    {
      kind: 'user',
      text: `The user's name is ${name}.`,
      priority: 0,
      confidence: 1,
      stability: 'stable',
      source: 'user_direct',
      conflictKey: 'user.name',
      evidence: prompt,
      reason: 'Runtime fallback extracted explicit self-identification.',
    },
  ];
}

function findOpenTag(text: string): { type: ControlBlockType; start: number; end: number } | undefined {
  const lower = text.toLowerCase();
  let best: { type: ControlBlockType; start: number; end: number } | undefined;
  for (const tag of OPEN_TAGS) {
    const start = lower.indexOf(tag.open);
    if (start === -1) continue;
    if (best && start >= best.start) continue;
    const closeAngle = text.indexOf('>', start + tag.open.length);
    best = { type: tag.type, start, end: closeAngle === -1 ? -1 : closeAngle + 1 };
  }
  return best;
}

function controlPrefixHold(text: string): number {
  const lower = text.toLowerCase();
  const maxPrefix = Math.max(...OPEN_TAGS.map(tag => tag.open.length));
  for (let length = Math.min(maxPrefix, lower.length); length > 0; length -= 1) {
    const suffix = lower.slice(-length);
    if (OPEN_TAGS.some(tag => tag.open.startsWith(suffix))) return length;
  }
  return 0;
}

function promptRejectsMemory(prompt: string): boolean {
  const normalized = normalizeText(prompt);
  return Boolean(
    /\?/.test(prompt)
    || /\b(?:do not|don't|dont)\s+(?:remember|save|store)\b/.test(normalized)
    || /\b(?:forget|delete|remove|clear)\b/.test(normalized),
  );
}

function extractName(body: string): string {
  const patterns = [
    /\bmy\s+name\s+is\s+([A-Za-z][A-Za-z .'_-]{0,60})/i,
    /\bcall\s+me\s+([A-Za-z][A-Za-z .'_-]{0,60})/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(body);
    if (!match) continue;
    const name = cleanName(match[1]);
    if (name) return name;
  }
  return '';
}

function cleanName(raw: string): string {
  const value = raw
    .split(/[.!?,;:\n\r]/)[0]
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^['"]|['"]$/g, '');
  if (!value || value.length > 60) return '';
  const words = value.split(/\s+/);
  if (words.length > 4) return '';
  if (!/^[A-Za-z][A-Za-z .'_-]*$/.test(value)) return '';
  if (value === value.toLowerCase()) {
    return words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }
  return value;
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.;]+$/g, '');
}
