// @ts-nocheck
import {test} from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startBridge} from '../../data/copilot/bridge.mjs';
import {bindSlot} from '../../data/copilot/core.mjs';

test('bridge confines routing, applies Claude workaround, and preserves other model sampling',async()=>{
 const seen=[];
 const upstream=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;seen.push({body:JSON.parse(raw),auth:req.headers.authorization});res.setHeader('content-type','application/json');res.end('{"ok":true}');});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const root=await mkdtemp(join(tmpdir(),'opper-bridge-'));
 const file=join(root,'config.json');const slot={apiKey:'synthetic',baseUrl:`http://127.0.0.1:${upstream.address().port}`,orgId:1,projectId:2,user:{email:'test@example.invalid'}};
 await writeFile(file,JSON.stringify({version:1,keys:{default:slot}}));
 const bridge=await startBridge(bindSlot(slot,file,'default'),[{id:'vertexai/claude-opus-5-5'},{id:'other/model'}],'test');
 const call=(body,token=bridge.token,path='/chat/completions')=>fetch(bridge.url+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
 try{
  assert.equal((await call({},'wrong')).status,401);
  assert.equal((await call({},bridge.token,'/../../admin')).status,404);
  assert.equal((await call({model:'forbidden'})).status,403);
  assert.equal(seen.length,0);
  const claude={model:'vertexai/claude-opus-5-5',messages:[],temperature:0,top_p:0.95,top_k:4,max_tokens:123};
  assert.equal((await call(claude)).status,200);
  assert.deepEqual(seen[0],{body:{model:claude.model,messages:[],max_tokens:123},auth:'Bearer synthetic'});
  assert.equal((await call({...claude,model:'other/model'})).status,200);
  assert.equal(seen[1].body.temperature,0);assert.equal(seen[1].body.top_p,0.95);
  await rm(file);assert.equal((await call(claude)).status,401);assert.equal(seen.length,2);
 }finally{await bridge.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await rm(root,{recursive:true,force:true});}
});

test('bridge preserves explicit project attribution for inference and budget across organization-key renewal',async t=>{
 const target='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',seen=[];
 const upstream=http.createServer(async(req,res)=>{
  for await(const chunk of req){}
  seen.push({path:req.url,auth:req.headers.authorization,project:req.headers['x-opper-project'],trace:req.headers['x-opper-trace-id']});
  res.setHeader('content-type','application/json');res.end(req.url==='/v3/me'?JSON.stringify({member_spend:{spent_cents:0,limit_cents:100,limit_scope:'member'}}):'{"ok":true}');
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.onTestFinished(()=>{upstream.closeAllConnections();upstream.close();});
 const root=await mkdtemp(join(tmpdir(),'opper-org-bridge-'));t.onTestFinished(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'config.json');const slot={apiKey:'synthetic-first',baseUrl:`http://127.0.0.1:${upstream.address().port}`,orgId:1,user:{email:'test@example.invalid'}};
 const save=async s=>writeFile(file,JSON.stringify({version:1,keys:{default:s}}));await save(slot);
 const binding=bindSlot(slot,file,'default',target);
 const bridge=await startBridge(binding,[{id:'other/model'}],'trace-test',binding.origin+'/v3/session/sess_explicit');t.onTestFinished(()=>bridge.close());
 const call=()=>fetch(bridge.url+'/chat/completions',{method:'POST',headers:{authorization:`Bearer ${bridge.token}`,'content-type':'application/json','X-Opper-Project':'cccccccc-cccc-4ccc-8ccc-cccccccccccc'},body:JSON.stringify({model:'other/model',messages:[]})});
 assert.equal((await call()).status,200);
 await save({...slot,apiKey:'synthetic-renewed',projectId:null});
 assert.equal((await call()).status,200);
 const budget=await fetch(new URL('/opper/budget',bridge.url),{headers:{authorization:`Bearer ${bridge.token}`}});assert.equal(budget.status,200);
 assert.deepEqual(seen,[
  {path:'/v3/session/sess_explicit/chat/completions',auth:'Bearer synthetic-first',project:target,trace:'trace-test'},
  {path:'/v3/session/sess_explicit/chat/completions',auth:'Bearer synthetic-renewed',project:target,trace:'trace-test'},
  {path:'/v3/me',auth:'Bearer synthetic-renewed',project:target,trace:undefined},
 ]);
 await save({...slot,apiKey:'synthetic-other',orgId:9});assert.equal((await call()).status,401);assert.equal(seen.length,3);
});
