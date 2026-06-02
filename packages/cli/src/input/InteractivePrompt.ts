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
      throw error;
    }
  }

  close(): void {
    this.interface.close();
  }
}
