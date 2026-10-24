import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const bridge = path.join(root, 'apps/bridge');
const protocol = path.join(root, 'packages/workspace-protocol');
const output = path.join(root, 'packages/cli/dist/bridge-template');
const cloudflare = path.join(root, 'packages/cli/dist/bridge-cloudflare');
const requireBridge = createRequire(path.join(bridge, 'package.json'));
const requireProtocol = createRequire(path.join(protocol, 'package.json'));
const version = JSON.parse(fs.readFileSync(path.join(bridge, 'package.json'), 'utf8')).version;
// Rebuild only this generated directory; no configuration or credentials enter it.
fs.rmSync(output, { recursive: true, force: true });
fs.rmSync(cloudflare, { recursive: true, force: true });
// The Cloudflare Worker is one prebuilt bundle; `bridge deploy cloudflare` uploads it unchanged.
fs.mkdirSync(cloudflare, { recursive: true });
fs.copyFileSync(path.join(bridge, 'dist/cloudflare/worker.js'), path.join(cloudflare, 'worker.js'));
fs.mkdirSync(output, { recursive: true });
fs.cpSync(path.join(bridge, 'dist'), path.join(output, 'dist'), {
  recursive: true,
  filter: (source) => !source.startsWith(path.join(bridge, 'dist/cloudflare')),
});
fs.cpSync(path.join(protocol, 'dist'), path.join(output, 'vendor/workspace-protocol/dist'), { recursive: true });
fs.copyFileSync(path.join(bridge, '.env.example'), path.join(output, '.env.example'));
fs.copyFileSync(path.join(bridge, 'README.md'), path.join(output, 'README.md'));
fs.copyFileSync(path.join(bridge, 'HOSTING.md'), path.join(output, 'HOSTING.md'));
fs.copyFileSync(path.join(bridge, 'setup/setup.sh'), path.join(output, 'setup.sh'));
fs.mkdirSync(path.join(output, 'setup'), { recursive: true });
fs.copyFileSync(path.join(bridge, 'setup/setup.py'), path.join(output, 'setup/setup.py'));
const json = (name, data) => fs.writeFileSync(path.join(output, name), JSON.stringify(data, null, 2) + '\n');
json('package.json', {
  name: 'marifold-personal-bridge',
  version,
  private: true,
  engines: { node: '24.x' },
  scripts: { start: 'node dist/serve.js' },
  dependencies: {
    '@marifold/workspace-protocol': 'file:vendor/workspace-protocol',
    ws: requireBridge('ws/package.json').version,
  },
});
json('vendor/workspace-protocol/package.json', {
  name: '@marifold/workspace-protocol',
  version,
  private: true,
  main: 'dist/index.js',
  dependencies: { '@hpke/core': requireProtocol('@hpke/core/package.json').version },
});
fs.writeFileSync(path.join(output, '.gitignore'), 'node_modules/\n.env\n.env.*\n!.env.example\ndata/\n');
