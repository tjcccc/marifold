import { createBridge, MemoryRelayStore } from '../../../../apps/bridge/dist/index.js';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentConfig, SessionResolver, WorkspaceStore, listRunArtifacts } from '../../../../packages/core/dist/index.js';
import { createMarifoldService } from '../../../../packages/service/dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-playwright-'));
const profilesDir = path.join(stateDir, 'profiles');
const profileDir = path.join(profilesDir, 'default');
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'INSTRUCTIONS.md'), '# Default\n\nA disposable browser-test profile.\n');
fs.writeFileSync(path.join(profileDir, 'profile.toml'), 'memories = false\n');
const researchProfileDir = path.join(profilesDir, 'research-lab');
fs.mkdirSync(researchProfileDir, { recursive: true });
fs.writeFileSync(path.join(researchProfileDir, 'INSTRUCTIONS.md'), '# Research Lab\n\nA second profile for sidebar search.\n');
fs.writeFileSync(path.join(researchProfileDir, 'profile.toml'), 'memories = false\n');
const appsDir = path.join(stateDir, 'apps');
fs.cpSync(path.join(root, 'examples/apps'), appsDir, { recursive: true });
const writerFixtureDir = path.join(appsDir, 'writer-fixture');
fs.cpSync(path.join(appsDir, 'translator'), writerFixtureDir, { recursive: true });
const writerFixtureSource = path.join(writerFixtureDir, 'skillapp.ts');
fs.writeFileSync(
  writerFixtureSource,
  fs.readFileSync(writerFixtureSource, 'utf8')
    .replace("name: 'translator'", "name: 'writer-fixture'")
    .replace("title: 'Marifold Translation'", "title: 'Writer Fixture'"),
);

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
      appsDir,
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

const remoteStateDir = path.join(stateDir, 'remote');
const remoteProfilesDir = path.join(remoteStateDir, 'profiles');
const remoteProfileDir = path.join(remoteProfilesDir, 'remote-only');
fs.mkdirSync(remoteProfileDir, { recursive: true });
fs.writeFileSync(path.join(remoteProfileDir, 'INSTRUCTIONS.md'), '# Remote Only\n\nA profile owned by the remote fixture.\n');
fs.writeFileSync(path.join(remoteProfileDir, 'profile.toml'), 'memories = false\n');
const remoteLoadedConfig = {
  config: {
    ...loadedConfig.config,
    default: { ...loadedConfig.config.default, profile: 'remote-only' },
    paths: {
      profilesDir: remoteProfilesDir,
      sessionsDb: path.join(remoteStateDir, 'sessions.db'),
      tasksDir: path.join(remoteStateDir, 'tasks'),
      schedulesDir: path.join(remoteStateDir, 'schedules'),
      skillsDir: path.join(remoteStateDir, 'skills'),
      appsDir: path.join(remoteStateDir, 'apps'),
    },
    service: {
      token: 'remote-fixture-token',
      corsOrigins: ['http://127.0.0.1:32141'],
    },
  },
  configPath: path.join(remoteStateDir, 'config.toml'),
  foundConfig: true,
};
// A deliverable whose live run expired two days ago must still download through
// the paired guest. All fixture bytes and session state are disposable.
const artifactRunId = `run_browser_fixture_${Date.now()}`;
const artifactDirectory = path.join(os.homedir(), '.marifold', 'runs', artifactRunId);
const artifactOutput = path.join(artifactDirectory, 'output');
fs.mkdirSync(artifactOutput, { recursive: true });
const sharp = createRequire(path.join(root, 'packages/core/package.json'))('sharp');
const artifactPng = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#37576a' } }).png().toBuffer();
fs.writeFileSync(path.join(artifactOutput, 'home-desktop.png'), artifactPng);
fs.writeFileSync(path.join(artifactOutput, 'worklogs.csv'), 'Date,Hours\n2026-09-16,8\n');
fs.writeFileSync(path.join(artifactOutput, 'expired-desktop.png'), Buffer.from(png, 'base64'));
const artifactStarted = new Date(Date.now() - 2 * 86400000).toISOString();
const artifactFinished = new Date(Date.parse(artifactStarted) + 1000).toISOString();
const artifactSessions = new SessionResolver(remoteLoadedConfig.config.paths.sessionsDb);
await artifactSessions.appendExchange('session-download', 'remote-only', 'Capture the home desktop.', 'The screenshot is ready.', undefined, {
  mode: 'agent', provider: 'ollama', model: 'fixture-model', think: false,
  startedAt: artifactStarted, finishedAt: artifactFinished, latencyMs: 1000,
});
artifactSessions.close();
const artifactStore = new WorkspaceStore(remoteLoadedConfig.configPath);
const realNow = Date.now;
try {
  Date.now = () => Date.parse(artifactFinished);
  artifactStore.runJournal.save({
    id: artifactRunId, sessionId: 'session-download', profile: 'remote-only', objective: 'Capture the home desktop.',
    summary: 'The screenshot is ready.', status: 'completed', createdAt: artifactStarted, finishedAt: artifactFinished,
    eventCount: 1, artifacts: listRunArtifacts({ outputDir: artifactOutput }), pendingApprovals: [], pendingUserInputs: [],
  });
} finally { Date.now = realNow; artifactStore.close(); }
fs.unlinkSync(path.join(artifactOutput, 'expired-desktop.png'));
const remoteServer = createMarifoldService({ loadedConfig: remoteLoadedConfig, scheduler: false });
await remoteServer.listen({ host: '127.0.0.1', port: 32142 });
process.stdout.write('Remote Marifold fixture listening at http://127.0.0.1:32142\n');

const bridgeServer = createBridge(new MemoryRelayStore(), 'fixture-registration-token-32-characters');
await new Promise(resolve => bridgeServer.listen(32144, '127.0.0.1', resolve));
const bridgeUrl = 'http://127.0.0.1:32144';
const hosted = await remoteServer.inject({ method: 'POST', url: '/v1/workspaces', headers: { authorization: 'Bearer remote-fixture-token' }, payload: { name: 'Home workspace', bridgeUrl, registrationToken: 'fixture-registration-token-32-characters' } });
if (hosted.statusCode !== 200) throw new Error('Fixture host creation failed.');
const joined = await server.inject({ method: 'POST', url: '/v1/workspaces/join', payload: { bridgeUrl, invitation: hosted.json().invitation } });
if (joined.statusCode !== 200) throw new Error('Fixture guest pairing failed.');
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  fs.rmSync(artifactDirectory, { recursive: true, force: true });
  await remoteServer.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  bridgeServer.closeAllConnections(); bridgeServer.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
  process.exit(0);
}

process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
await new Promise(() => undefined);
