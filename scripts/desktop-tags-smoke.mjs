// Opt-in real inference test with the desktop's bundled app-server.
// Uses only an explicitly prepared isolated home; never the user's normal chats.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readDesktopRuntime } from '../dist/commands/desktop.js';

const { values } = parseArgs({ options: { 'state-dir': { type: 'string' }, demo: { type: 'string' } } });
if (!values['state-dir'] || !values.demo) throw Error('Pass --state-dir and --demo for the prepared isolated test.');
const demo = resolve(values.demo);
const runtime = await readDesktopRuntime(resolve(values['state-dir']));
const config = await readFile(join(demo, 'codex-home', 'config.toml'), 'utf8');
const model = /^model = "([^"]+)"/m.exec(config)?.[1];
if (!model || !config.includes(runtime.url + '/v3/compat')) throw Error('The isolated profile does not target this bridge.');
const proc = spawn('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', ['app-server', '--stdio'], {
  env: { ...process.env, CODEX_HOME: join(demo, 'codex-home') }, stdio: ['pipe', 'pipe', 'pipe'],
});
let sequence = 0;
const pending = new Map();
const completed = new Map();
const turnWaiters = new Map();
const messages = new Map();
let runtimeFailure;
const failRuntime = (error) => {
  runtimeFailure = error;
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
  for (const waiter of turnWaiters.values()) waiter({ status: 'failed', error: { message: error.message } });
  turnWaiters.clear();
};
proc.once('error', (error) => failRuntime(error));
proc.once('exit', (code, signal) => failRuntime(Error('The isolated app-server exited: ' + (signal ?? code))));
const send = (value) => proc.stdin.write(JSON.stringify(value) + '\n');
const rpc = (method, params) => new Promise((resolve, reject) => {
  if (runtimeFailure) { reject(runtimeFailure); return; }
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')); }, 60000);
  pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (value) => { clearTimeout(timer); reject(value); } });
  send({ id, method, params });
});
const lines = createInterface({ input: proc.stdout });
lines.on('line', (line) => {
  let event; try { event = JSON.parse(line); } catch { return; }
  if (event.id !== undefined && !event.method) {
    const waiter = pending.get(event.id); if (!waiter) return;
    pending.delete(event.id);
    if (event.error) waiter.reject(Error(JSON.stringify(event.error))); else waiter.resolve(event.result);
  } else if (event.id !== undefined && event.method) {
    send({ id: event.id, error: { code: -32601, message: 'Interactive tools are outside this smoke test.' } });
  } else if (event.method === 'item/agentMessage/delta') {
    const key = event.params.turnId;
    messages.set(key, (messages.get(key) ?? '') + event.params.delta);
  } else if (event.method === 'turn/completed') {
    const turn = event.params.turn;
    completed.set(turn.id, turn);
    turnWaiters.get(turn.id)?.(turn);
  }
});
// Keep diagnostics local; print only the error on failure, never request payloads.
let diagnostics = '';
proc.stderr.on('data', (bytes) => { diagnostics = (diagnostics + bytes).slice(-16000); });
const waitTurn = (id) => runtimeFailure ? Promise.reject(runtimeFailure) : completed.has(id) ? Promise.resolve(completed.get(id)) : new Promise((resolve, reject) => {
  const timer = setTimeout(() => { turnWaiters.delete(id); reject(Error('Inference turn timed out.')); }, 60000);
  turnWaiters.set(id, (turn) => { clearTimeout(timer); turnWaiters.delete(id); resolve(turn); });
});
const select = async (tags, id) => {
  const response = await fetch(runtime.url + (id ? '/opper/activate' : '/opper/context'), { method: 'POST',
    headers: { authorization: 'Bearer ' + runtime.token, 'content-type': 'application/json' }, body: JSON.stringify(id ? { id } : { tags }),
  });
  if (!response.ok) throw Error('Local session selection failed: ' + response.status);
  return response.json();
};
const evidence = { runtimePid: proc.pid, model, turns: [] };
try {
  const initial = await fetch(runtime.url + '/opper/status', { headers: { authorization: 'Bearer ' + runtime.token } });
  if (!initial.ok) throw Error('The local bridge is not ready.');
  const saved = (await initial.json()).sessions ?? [];
  await rpc('initialize', { clientInfo: { name: 'opper_desktop_tags_smoke', version: '0.1.0' } });
  send({ method: 'initialized', params: {} });
  const started = await rpc('thread/start', { cwd: join(demo, 'workspace'), approvalPolicy: 'on-request', sandbox: 'read-only' });
  const threadId = started.thread.id;
  evidence.threadId = threadId;
  for (const project of ['desktop-demo-acme', 'desktop-demo-beta', 'desktop-demo-acme']) {
    const existing = saved.find((session) => session.project === project);
    const context = await select({ project }, existing?.id ?? (evidence.turns.length === 2 ? evidence.turns[0].sessionId : undefined));
    const expected = 'tag-test-' + (evidence.turns.length + 1);
    const startedTurn = await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with exactly ' + expected + '. Do not use any tools.' }] });
    const turn = await waitTurn(startedTurn.turn.id);
    const answer = messages.get(turn.id) ?? '';
    if (turn.status !== 'completed' || !answer.includes(expected)) throw Error('Inference failed: ' + JSON.stringify({ status: turn.status, error: turn.error, answer }));
    const record = { project, sessionId: context.sessionId, turnId: turn.id, answer };
    evidence.turns.push(record);
    console.log(JSON.stringify(record));
  }
  if (evidence.turns[0].sessionId !== evidence.turns[2].sessionId) throw Error('Resuming a session changed its attribution ID.');
  await writeFile(join(demo, 'inference-evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log('Three tagged turns completed in one conversation and one app-server process.');
} catch (error) {
  await writeFile(join(demo, 'app-server-diagnostics.log'), diagnostics, { mode: 0o600 });
  throw error;
} finally {
  lines.close();
  proc.stdin.end();
  proc.kill('SIGTERM');
  for (const waiter of pending.values()) waiter.reject(Error('App-server stopped.'));
  pending.clear();
}
