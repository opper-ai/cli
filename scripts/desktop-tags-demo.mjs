// Local prototype: prepare a fresh, isolated desktop profile for a running bridge.
// Run npm run build first. No global app settings or real API keys are copied.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { readDesktopRuntime, resolveDesktopApiContext } from '../dist/commands/desktop.js';
import { fetchCodexModelCatalog } from '../dist/setup/codex-models.js';
import { applyDesktopConfig } from '../dist/setup/codex-desktop-config.js';

const { values } = parseArgs({ options: {
  'state-dir': { type: 'string' }, output: { type: 'string' }, model: { type: 'string', default: 'claude-sonnet-5' },
} });
if (!values['state-dir'] || !values.output) throw Error('Pass --state-dir and a fresh --output directory.');
const stateDir = resolve(values['state-dir']);
const output = resolve(values.output);
try { await access(output); throw Error('The output directory already exists; use a fresh directory.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const runtime = await readDesktopRuntime(stateDir);
const catalog = await fetchCodexModelCatalog(await resolveDesktopApiContext(stateDir), values.model);
const home = join(output, 'codex-home');
const profile = join(output, 'electron-profile');
const workspace = join(output, 'workspace');
for (const directory of [output, home, profile, workspace]) await mkdir(directory, { mode: 0o700 });
const manifest = join(stateDir, 'bridge.json');
const helper = join(home, 'bridge-auth.mjs');
await writeFile(helper, `import {readFileSync} from 'node:fs';\nconst value=JSON.parse(readFileSync(${JSON.stringify(manifest)},'utf8'));\nif(value.url!==${JSON.stringify(runtime.url)}) throw Error('Bridge endpoint changed. Reconfigure the test profile.');\nprocess.stdout.write(value.token);\n`, { mode: 0o600 });
const catalogPath = join(home, 'catalog.json');
await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
const config = applyDesktopConfig('sandbox_mode = "read-only"\napproval_policy = "on-request"\n', {
  model: values.model, model_catalog_json: catalogPath,
  provider: { name: 'Opper local tagging test', base_url: runtime.url + '/v3/compat', wire_api: 'responses',
    requires_openai_auth: false, supports_websockets: false,
    auth: { command: process.execPath, args: [helper], refresh_interval_ms: 300000 },
  },
});
await writeFile(join(home, 'config.toml'), config.text, { mode: 0o600 });
await writeFile(join(workspace, 'README.md'), 'Disposable workspace for the Opper desktop attribution test.\n', { mode: 0o600 });
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const launcher = `#!/bin/zsh\nset -e\nopen -n -a /Applications/ChatGPT.app --env ${quote('CODEX_HOME=' + home)} --env ${quote('CODEX_ELECTRON_USER_DATA_PATH=' + profile)} --args ${quote('--user-data-dir=' + profile)} ${quote(workspace)}\n`;
await writeFile(join(output, 'open.zsh'), launcher, { mode: 0o700 });
console.log(JSON.stringify({ home, profile, workspace, model: values.model, launcher: join(output, 'open.zsh'), endpoint: runtime.url }, null, 2));
