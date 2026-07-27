import * as fs from 'fs';
import * as path from 'path';
import { MarifoldError } from '../errors/MarifoldError';
import { AppDefinition } from './AppSchema';
import { validateAppToml } from './AppValidator';

const SAFE_APP_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFINITION_FILE = 'app.toml';

/** Global App bundles under `<appsDir>/<name>/app.toml`. Invalid bundles are
 * skipped by list(); get() reports their exact validation failure. */
export class AppStore {
  constructor(private readonly directory: string) {}

  list(): AppDefinition[] {
    if (!fs.existsSync(this.directory)) return [];
    const apps: AppDefinition[] = [];
    for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_APP_NAME.test(entry.name)) continue;
      try {
        const app = this.get(entry.name);
        if (app) apps.push(app);
      } catch {
        // A catalog stays usable when one local definition is malformed.
      }
    }
    return apps.sort((a, b) => a.app.title.localeCompare(b.app.title));
  }

  get(name: string): AppDefinition | undefined {
    assertSafeAppName(name);
    const source = path.join(this.directory, name, DEFINITION_FILE);
    if (!fs.existsSync(source)) return undefined;
    const result = validateAppToml(fs.readFileSync(source, 'utf-8'));
    if (!result.ok || !result.definition) {
      throw MarifoldError.appInvalid(
        `Invalid App '${name}': ${result.errors.join(' ')}`,
        source,
      );
    }
    if (result.definition.app.name !== name) {
      throw MarifoldError.appInvalid(
        `App app.name '${result.definition.app.name}' must match bundle directory '${name}'.`,
        source,
      );
    }
    return result.definition;
  }

  require(name: string): AppDefinition {
    const app = this.get(name);
    if (!app) throw MarifoldError.appNotFound(name);
    return app;
  }
}

function assertSafeAppName(name: string): void {
  if (!SAFE_APP_NAME.test(name)) {
    throw MarifoldError.appInvalid(`Invalid App name '${name}'.`);
  }
}
