import * as fs from 'fs';
import * as path from 'path';
import { MarifoldConfig } from '../config/ConfigSchema';

export class Workspace {
  constructor(readonly config: MarifoldConfig) {}

  get profilesDir(): string {
    return this.config.paths.profilesDir;
  }

  get sessionsDb(): string {
    return this.config.paths.sessionsDb;
  }

  ensureSessionDirectory(): void {
    fs.mkdirSync(path.dirname(this.sessionsDb), { recursive: true });
  }
}
