import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentConfig, SessionResolver } from '../../../../packages/core/dist/index.js';
import { createMarifoldService } from '../../../../packages/service/dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-playwright-'));
const profilesDir = path.join(stateDir, 'profiles');
const profileDir = path.join(profilesDir, 'default');
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), '# Default\n\nA disposable browser-test profile.\n');
fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'mode = "agent"\nmemories = false\n');
const researchProfileDir = path.join(profilesDir, 'research-lab');
fs.mkdirSync(researchProfileDir, { recursive: true });
fs.writeFileSync(path.join(researchProfileDir, 'PROFILE.md'), '# Research Lab\n\nA second profile for sidebar search.\n');
fs.writeFileSync(path.join(researchProfileDir, 'profile.toml'), 'mode = "agent"\nmemories = false\n');

const loadedConfig = {
  config: {
    default: { provider: 'ollama', model: 'fixture-model', profile: 'default', think: false },
    models: { options: ['ollama/fixture-model'] },
    memory: { sizeLimit: 50000, contextLimit: 2400 },
    paths: {
      profilesDir,
      sessionsDb: path.join(stateDir, 'sessions.db'),
      tasksDir: path.join(stateDir, 'tasks'),
      schedulesDir: path.join(stateDir, 'schedules'),
      skillsDir: path.join(stateDir, 'skills'),
    },
    providers: { ollama: { type: 'ollama', baseUrl: 'http://127.0.0.1:9' } },
    agent: resolveAgentConfig(),
    webSearch: { enabled: false, maxResults: 5, provider: 'duckduckgo' },
  },
  configPath: path.join(stateDir, 'config.toml'),
  foundConfig: true,
};

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=';
const sessions = new SessionResolver(loadedConfig.config.paths.sessionsDb);
await sessions.appendExchange(
  'session-gallery',
  'default',
  'Compare these two images',
  'They are fixture images for the gallery.',
  [
    { data: png, mediaType: 'image/png' },
    { data: png, mediaType: 'image/png' },
  ],
);
sessions.updateDisplay('session-gallery', { title: 'Image gallery', pinned: true });
await sessions.appendExchange('session-travel', 'default', 'Plan a quiet train trip', 'Travel notes.');
sessions.updateDisplay('session-travel', { title: 'Travel notes' });
await sessions.appendExchange('session-archived', 'default', 'Old archived prompt', 'Archived answer.');
sessions.updateDisplay('session-archived', { title: 'Archived ideas', archived: true });
await sessions.appendExchange(
  'session-research',
  'research-lab',
  'Summarize the experiment',
  'Research reply preview.\nAdditional fixture detail.',
);
sessions.close();

const server = createMarifoldService({
  loadedConfig,
  scheduler: false,
  web: { dir: path.join(root, 'apps/web/dist') },
});
await server.listen({ host: '127.0.0.1', port: 32141 });
process.stdout.write('Marifold Playwright fixture listening at http://127.0.0.1:32141\n');

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close().catch(() => undefined);
  fs.rmSync(stateDir, { recursive: true, force: true });
  process.exit(0);
}

process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
await new Promise(() => undefined);
