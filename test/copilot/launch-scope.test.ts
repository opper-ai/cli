// @ts-nocheck
import {test,vi} from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {launchCopilot} from '../../data/copilot/launch.mjs';
import {copilot} from '../../src/agents/copilot.js';

test('Copilot discovery sends only the explicit request target, independently of saved resource defaults',async t=>{
 const seen=[];
 const server=http.createServer((req,res)=>{
  seen.push({path:req.url,auth:req.headers.authorization,project:req.headers['x-opper-project']});
  res.end(JSON.stringify({data:[{id:'test/model',context_length:128000,opper:{type:'llm',capabilities:['tools'],max_output_tokens:4096}}]}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.onTestFinished(()=>{server.closeAllConnections();server.close();});
 const home=await mkdtemp(join(tmpdir(),'copilot-scope-'));t.onTestFinished(()=>rm(home,{recursive:true,force:true}));
 const configPath=join(home,'config.json'),baseUrl=`http://127.0.0.1:${server.address().port}`;
 const slot={apiKey:'synthetic-org',baseUrl,orgId:1,user:{email:'test@example.invalid'},defaultProjectUuid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
 await writeFile(configPath,JSON.stringify({version:1,keys:{test:slot}}));
 const runtime={home,configPath,getSlot:async()=>slot};
 const routing={keyName:'test',apiBaseUrl:baseUrl,baseUrl:baseUrl+'/v3/session/sess_test',apiKey:slot.apiKey};
 const target='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 assert.equal(await launchCopilot(['--list'],{...routing,projectUuid:target},runtime),0);
 assert.equal(await launchCopilot(['--list'],routing,runtime),0);
 assert.deepEqual(seen,[
  {path:'/v3/compat/models',auth:'Bearer synthetic-org',project:target},
  {path:'/v3/compat/models',auth:'Bearer synthetic-org',project:undefined},
 ]);
});

test('Copilot refuses environment credentials instead of using a different saved slot for renewal',async()=>{
 vi.stubEnv('OPPER_API_KEY','synthetic-env');
 try {
  await assert.rejects(copilot.spawn([],{keyName:'saved',apiBaseUrl:'https://api.opper.ai',baseUrl:'https://api.opper.ai/v3/session/sess_test',apiKey:'synthetic-env',model:'test/model',compatShape:'openai'}),/requires a saved credential/);
 } finally {vi.unstubAllEnvs();}
});
