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
