import { readFile } from 'node:fs/promises';

export function origin(value = 'https://api.opper.ai') {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw Error('Use an API origin without a path, credentials, or query.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw Error('An HTTPS Opper endpoint is required.');
  return url.origin;
}
export async function readSlot(configPath, name) {
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return undefined; throw Error('Cannot read Opper login storage.'); }
  if (config.version !== 1 || !config.keys || typeof config.keys !== 'object') throw Error('Unsupported Opper login storage format.');
  const slot = Object.hasOwn(config.keys, name) ? config.keys[name] : undefined;
  if (!slot || typeof slot.apiKey !== 'string' || !slot.apiKey.trim()) return undefined;
  if (/[\r\n]/.test(slot.apiKey)) throw Error('Invalid credential format.');
  return slot;
}
export function checkExpiry(slot) {
  if (slot.expiresAt == null) return;
  const expiry = Date.parse(slot.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw Error('Opper sign-in expired. Run /opper-login, then retry your message.');
}
// Keep legacy-key comparison private to the live binding; never serialize it.
const boundKeys=new WeakMap();
export function bindSlot(slot, configPath, name, projectUuid) {
  checkExpiry(slot);
  const identity = slot.orgId != null && slot.user?.email
    ? { orgId:slot.orgId, projectId:slot.projectId ?? null, projectUuid:slot.projectUuid ?? null, email:slot.user.email } : undefined;
  // Request attribution is separate from the credential's project binding.
  const binding={configPath,name,origin:origin(slot.baseUrl),identity,...(projectUuid ? {projectUuid} : {})};
  if(!identity)boundKeys.set(binding,slot.apiKey);
  return binding;
}
export async function credential(binding) {
  const slot = await readSlot(binding.configPath, binding.name);
  if (!slot) throw Error('Opper login was removed. Sign in again, then restart this launcher.');
  checkExpiry(slot);
  assertBoundSlot(binding,slot);
  return slot.apiKey;
}
export function assertBoundSlot(binding,slot) {
  if (origin(slot.baseUrl) !== binding.origin) throw Error('Opper endpoint changed. Restart this launcher.');
  const expected = binding.identity;
  if (expected ? slot.orgId !== expected.orgId || (slot.projectId ?? null) !== (expected.projectId ?? null) || (slot.projectUuid ?? null) !== (expected.projectUuid ?? null) || slot.user?.email !== expected.email : slot.apiKey !== boundKeys.get(binding)) {
    throw Error('Opper login identity changed or cannot be verified. Restart this launcher.');
  }
}
// Only fresh, explicit browser renewal may drop a legacy project binding.
// Ordinary stored-slot checks remain strict; commit this identity after CAS.
export function renewedIdentity(binding,slot) {
  const expected=binding.identity;
  if(expected && (expected.projectId != null || expected.projectUuid != null) &&
      slot.projectId == null && slot.projectUuid == null) {
    const identity={...expected,projectId:null,projectUuid:null};
    assertBoundSlot({...binding,identity},slot);
    return identity;
  }
  assertBoundSlot(binding,slot);
  return expected;
}
export const MODEL_KINDS=['models','pools','routes'];
export function parseKinds(value) {
 const kinds=value==='all'?[...MODEL_KINDS]:[...new Set(value.split(','))];
 if(!kinds.length||kinds.some(k=>!MODEL_KINDS.includes(k)))throw Error('Use --kinds models,pools,routes (any combination), or all.');
 return kinds;
}
export function allowedModels(data,kinds=MODEL_KINDS) {
  if (!Array.isArray(data)) throw Error('Invalid model catalog response.');
  return data.flatMap(m => {
    const meta=m.opper;
    const kind=meta?.kind==='dynamic_route'?'routes':meta?.kind==='pool'?'pools':'models';
    if(!kinds.includes(kind))return [];
    if (!meta || meta.type === 'embedding' || !meta.capabilities?.includes('tools') || !Number.isSafeInteger(m.context_length) || !Number.isSafeInteger(meta.max_output_tokens) || meta.max_output_tokens <= 0 || meta.max_output_tokens >= m.context_length) return [];
    if (typeof m.id !== 'string' || !m.id || /[\r\n]/.test(m.id)) return [];
    return [{id:m.id,kind,input:m.context_length-meta.max_output_tokens,output:meta.max_output_tokens}];
  }).sort((a,b)=>MODEL_KINDS.indexOf(b.kind)-MODEL_KINDS.indexOf(a.kind));
}
export function apiHeaders(key, projectUuid) {
  return {Authorization:`Bearer ${key}`,...(projectUuid ? {'X-Opper-Project':projectUuid} : {})};
}
export async function getJson(host, path, key, projectUuid) {
  const response = await fetch(host + path, {headers:apiHeaders(key,projectUuid), signal:AbortSignal.timeout(20000),redirect:'error'});
  if (!response.ok) throw Object.assign(Error(response.status === 401 ? 'Opper rejected this login. Run opper login --force, then launch again.' : `Opper request failed (HTTP ${response.status}).`),{status:response.status});
  return response.json();
}
export function childEnvironment(parent, binding, model, helperCommand, profile) {
  const env={...parent};
  for (const key of Object.keys(env)) if (key.startsWith('COPILOT_PROVIDER') || ['COPILOT_MODEL','COPILOT_HOME','COPILOT_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN','OPPER_API_KEY'].includes(key)) delete env[key];
  return {...env,COPILOT_HOME:profile,COPILOT_OFFLINE:'true',COPILOT_PROVIDER_TYPE:'openai',COPILOT_PROVIDER_WIRE_API:'completions',COPILOT_PROVIDER_BASE_URL:binding.origin+'/v3/compat',COPILOT_PROVIDER_API_KEY_COMMAND:helperCommand,COPILOT_MODEL:model.id,COPILOT_PROVIDER_MAX_PROMPT_TOKENS:String(model.input),COPILOT_PROVIDER_MAX_OUTPUT_TOKENS:String(model.output)};
}
