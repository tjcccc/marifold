/** Shared TUI palette. Hex values render on truecolor terminals; Ink falls
 * back to the nearest ANSI color elsewhere. */
export const ACCENT = '#EAA221';
export const DIM_ACCENT = '#87744F';
export const DIM = '#999999';
/** Inline attachment tokens like `[image #1]`. */
export const ATTACHMENT = '#3FB950';
/** Submitted `/command` echoes in the transcript. */
export const COMMAND = '#A371F7';
/** Submitted `$skill` echoes in the transcript. */
export const SKILL = '#56B6C2';
/** Inline and fenced code in assistant Markdown; matches SKILL on purpose. */
export const CODE = SKILL;

/** The terminal's background tone: `MARIFOLD_THEME=light|dark`, else the
 * background index in `COLORFGBG` (set by iTerm2, rxvt, Konsole…; 7 or 15 is
 * light), else dark. */
export function terminalTheme(env: NodeJS.ProcessEnv = process.env): 'light' | 'dark' {
  const forced = env.MARIFOLD_THEME?.trim().toLowerCase();
  if (forced === 'light' || forced === 'dark') { return forced; }
  const background = env.COLORFGBG?.split(';').at(-1);
  return background === '7' || background === '15' ? 'light' : 'dark';
}

let userTurnBand = terminalTheme() === 'light' ? '#EFEFEF' : '#0F0F0F';

/** Background band behind submitted input in the transcript: derived from the
 * terminal's reported background when known (see `setUserTurnBackground`). */
export function userTurnBackground(): string {
  return userTurnBand;
}

export function setUserTurnBackground(color: string): void {
  userTurnBand = color;
}
