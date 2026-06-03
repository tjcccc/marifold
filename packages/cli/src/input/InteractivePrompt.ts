import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

export class InteractivePrompt {
  private readonly interface = readline.createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY),
  });

  async readUserMessage(label = 'user> '): Promise<string | undefined> {
    try {
      return await this.interface.question(label);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return undefined;
      if (error instanceof Error && error.message === 'readline was closed') return undefined;
      throw error;
    }
  }

  async readMultilineMessage(label = 'user > ', continuationLabel = '... > '): Promise<string | undefined> {
    const lines: string[] = [];
    let prompt = label;

    while (true) {
      const line = await this.readUserMessage(prompt);
      if (line === undefined) return lines.length > 0 ? lines.join('\n') : undefined;

      if (!line.endsWith('\\')) {
        lines.push(line);
        return lines.join('\n');
      }

      lines.push(line.slice(0, -1));
      prompt = continuationLabel;
    }
  }

  close(): void {
    this.interface.close();
  }
}
