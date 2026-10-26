/** Ask the terminal for its background color (OSC 11), followed by a device
 * attributes query (DA1) that every terminal answers in order: once the DA1
 * reply arrives, any OSC 11 reply has arrived too, so unsupported terminals
 * cost one round trip instead of a timeout, and no late reply leaks into the
 * TUI's input. */
const OSC11_QUERY = '\x1b]11;?\x1b\\';
const DA1_QUERY = '\x1b[c';
const OSC11_REPLY = /\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i;
const DA1_REPLY = /\x1b\[\?[\d;]*c/;

export interface Rgb { r: number; g: number; b: number }

interface ProbeInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export async function probeTerminalBackground(
  input: ProbeInput,
  output: { isTTY?: boolean; write(text: string): unknown },
  timeoutMs = 500,
): Promise<Rgb | undefined> {
  if (!input.isTTY || !output.isTTY || !input.setRawMode) { return undefined; }
  const wasRaw = input.isRaw === true;
  let received = '';
  return new Promise<Rgb | undefined>(resolve => {
    const finish = () => {
      clearTimeout(timer);
      input.off('data', onData);
      if (!wasRaw) { input.setRawMode?.(false); }
      input.pause();
      resolve(parseOsc11(received));
    };
    const onData = (chunk: Buffer | string) => {
      received += chunk.toString();
      if (DA1_REPLY.test(received)) { finish(); }
    };
    const timer = setTimeout(finish, timeoutMs);
    input.setRawMode?.(true);
    input.on('data', onData);
    input.resume();
    output.write(OSC11_QUERY + DA1_QUERY);
  });
}

/** `rgb:RRRR/GGGG/BBBB` (1–4 hex digits per channel) → 0–255 channels. */
export function parseOsc11(reply: string): Rgb | undefined {
  const match = OSC11_REPLY.exec(reply);
  if (!match) { return undefined; }
  const [r, g, b] = match.slice(1, 4).map(hex => Math.round(parseInt(hex, 16) / (16 ** hex.length - 1) * 255));
  return { r, g, b };
}

/** A band just off the background: lighter on a dark terminal, darker on a light one. */
export function bandColor(background: Rgb): string {
  const luminance = (0.2126 * background.r + 0.7152 * background.g + 0.0722 * background.b) / 255;
  const mix = (channel: number) => luminance < 0.5
    ? channel + (255 - channel) * 0.06
    : channel * 0.94;
  return `#${[background.r, background.g, background.b].map(channel => Math.round(mix(channel)).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}
