const RESET = '\x1b[0m';

const CODES = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

export class TerminalStyle {
  constructor(private readonly enabled = supportsColor(process.stdout)) {}

  bold(text: string): string {
    return this.wrap(CODES.bold, text);
  }

  dim(text: string): string {
    return this.wrap(CODES.dim, text);
  }

  red(text: string): string {
    return this.wrap(CODES.red, text);
  }

  yellow(text: string): string {
    return this.wrap(CODES.yellow, text);
  }

  private wrap(code: string, text: string): string {
    return this.enabled ? `${code}${text}${RESET}` : text;
  }
}

export function supportsColor(stream: NodeJS.WriteStream): boolean {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.NO_COLOR !== undefined) return false;
  return Boolean(stream.isTTY);
}
