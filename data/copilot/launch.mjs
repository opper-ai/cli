import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {selectedModel} from './preferences.mjs';
import {configureLoginRuntime} from './login.mjs';
import {startBridge} from './bridge.mjs';
import { mkdir, mkdtemp, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { origin, bindSlot, credential, allowedModels, parseKinds, MODEL_KINDS, getJson, childEnvironment } from './core.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const quote=s=>"'"+s.replace(/'/g,"'\"'\"'")+"'";

function run(command,args,env=process.env) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:'inherit',env});
    child.on('error',reject);child.on('exit',(code,signal)=>resolve(code ?? (signal ? 130 : 1)));
  });
}
export async function launchCopilot(args,routing,runtime) {
  if(process.platform==='win32')throw Error('Copilot through Opper currently supports macOS/Linux.');
  if(Number(process.versions.node.split('.')[0])<22)throw Error('Copilot through Opper requires Node.js 22 or newer.');
  configureLoginRuntime(runtime);
  const forwarded=[];let kinds,budgetExtension=true,noBudget=true,list=false;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--'){forwarded.push(...args.slice(i+1));break;}
    if(args[i]==='--kinds')kinds=parseKinds(args[++i]);
    else if(args[i].startsWith('--kinds='))kinds=parseKinds(args[i].slice(8));
    else if(args[i]==='--no-extension')budgetExtension=false;
    else if(args[i]==='--budget-extension')budgetExtension=true;
    else if(args[i]==='--no-budget')noBudget=true;
    else if(args[i]==='--budget-footer')noBudget=false;
    else if(args[i]==='--list')list=true;
    else forwarded.push(args[i]);
  }
  if(forwarded.some(a=>/^--(model|config-dir|resume|session-id|continue|connect|context|agent)(=|$)/.test(a)||a==='-r'))throw Error('Session/profile overrides are not supported yet. Use opper launch copilot --model to choose a model.');
  const name=routing.keyName;
  const opperHome=runtime.home,configPath=runtime.configPath;
  let modelId=routing.modelOverride;
  const slot=await runtime.getSlot(name);
  if(!slot)throw Error('Opper sign-in was removed. Run opper login.');
  if(origin(routing.apiBaseUrl)!==origin(slot.baseUrl))throw Error('The selected slot and OPPER_BASE_URL differ. Sign in to that endpoint in a separate slot.');
  const binding=bindSlot(slot,configPath,name,routing.projectUuid);
  const key=await credential(binding);
  const preferenceKey=createHash('sha256').update(JSON.stringify([binding.origin,name,binding.identity??'manual'])).digest('hex');
  const prefs=join(opperHome,'copilot-preferences');await mkdir(prefs,{recursive:true,mode:0o700});
  const preferenceFile=join(prefs,preferenceKey+'.json');
  let preference={};try{preference=JSON.parse(await readFile(preferenceFile,'utf8'));}catch{}
  kinds ??= Array.isArray(preference.kinds)&&preference.kinds.length&&preference.kinds.every(k=>MODEL_KINDS.includes(k))?preference.kinds:MODEL_KINDS;
  const catalog=allowedModels((await getJson(binding.origin,'/v3/compat/models',key,binding.projectUuid)).data,kinds);
  if(!catalog.length) throw Error('No allowed tool-capable models with valid context limits for these types. Try --kinds all.');
  if(list) {for(const m of catalog)console.log(m.id);return 0;}
  if(!modelId&&catalog.some(m=>m.id===preference.model))modelId=preference.model;
  modelId ??= catalog.find(m=>m.id==='sference/zai-org/GLM-5.3-Flash')?.id ?? catalog[0].id;
  const model=catalog.find(m=>m.id===modelId);
  if(!model)throw Error('The selected model is not in this key’s allowed tool-capable catalog.');
  // Account verification uses the same slot and origin as inference.
  const me=await getJson(binding.origin,'/v3/me',await credential(binding),binding.projectUuid);
  if(me.blocked)throw Error('Opper spending is blocked. Check your budget or contact your administrator.');
  console.error(`Opper: ${me.organization?.name ?? 'signed in'} · ${me.project?.name ?? 'project not reported'} · ${model.id}`);
  const runs=join(opperHome,'copilot-runs');await mkdir(runs,{recursive:true,mode:0o700});
  const root=await mkdtemp(join(runs,'run-'));
  let bridge;
  try {
    const env=childEnvironment(process.env,binding,model,'',join(root,'copilot'));
    const traceId=randomUUID();
    for(const key of Object.keys(env)) if(key.startsWith('COPILOT_PROVIDER')) delete env[key];
    env.COPILOT_MODEL='opper/'+model.id;
    bridge=await startBridge(binding,catalog,traceId,routing.baseUrl);
    const registry={providers:[{name:'opper',type:'openai',wireApi:'completions',baseUrl:bridge.url,apiKey:bridge.token}],models:catalog.map(m=>({id:m.id,provider:'opper',wireModel:m.id,name:m.id,maxPromptTokens:m.input,maxContextWindowTokens:m.input+m.output,maxOutputTokens:m.output}))};
    env.COPILOT_PROVIDERS_CONFIG=join(root,'providers.json');
    const budgetFile=join(root,'budget.json');
    await writeFile(budgetFile,JSON.stringify({url:new URL('/opper/budget',bridge.url).href,token:bridge.token}),{mode:0o600});
    env.OPPER_COPILOT_BUDGET_FILE=budgetFile;
    await mkdir(env.COPILOT_HOME,{recursive:true,mode:0o700});
    if(!noBudget)await writeFile(join(env.COPILOT_HOME,'settings.json'),JSON.stringify({statusLine:{type:'command',command:[process.execPath,join(here,'budget.mjs'),budgetFile,'--footer'].map(quote).join(' '),refreshInterval:60},footer:{showCustom:true}}),{mode:0o600});
    const pluginArgs=budgetExtension?['--experimental','--plugin-dir',join(here,'plugin')]:[];
    if(budgetExtension)console.error('Opper commands enabled (experimental Copilot extension): /opper-login and /opper-usage.');
    await writeFile(env.COPILOT_PROVIDERS_CONFIG,JSON.stringify(registry),{mode:0o600});
    console.error(`${catalog.length} Opper models available. Use /model to switch.`);
    
    const code=await run('npx',['--yes','--package=@github/copilot@1.0.88','copilot',...pluginArgs,...forwarded],env);
    if(bridge.credentialError)console.error(bridge.credentialError);
    if(code!==0&&!bridge.credentialError) console.error('Copilot stopped. Check the error above before retrying.');
    try {
      const selected=await selectedModel(join(root,'copilot'),catalog);
      if(catalog.some(m=>m.id===(selected??model.id))) {
        const tmp=preferenceFile+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify({model:selected??model.id,kinds}),{mode:0o600});await rename(tmp,preferenceFile);
      }
    }catch{}
    return code;
  } finally {
    await bridge?.close();
    await rm(join(root,'providers.json'),{force:true});
    await rm(join(root,'budget.json'),{force:true});

  }
}
