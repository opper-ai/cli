// @ts-nocheck
import {test} from 'vitest';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSessionLogin,expiryWarning} from '../../data/copilot/session-login.mjs';
import {bindSlot,credential} from '../../data/copilot/core.mjs';
import {startBridge} from '../../data/copilot/bridge.mjs';
const slot={apiKey:'synthetic-old',clientId:'test',orgId:1,projectId:2,user:{email:'test@example.invalid'}};
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'session-login-'));t.onTestFinished(()=>rm(root,{recursive:true,force:true}));const file=join(root,'config.json');const save=async s=>{await writeFile(file+'.tmp',JSON.stringify({version:1,keys:{copilot:s}}));await rename(file+'.tmp',file);};await save(slot);return {file,save,binding:bindSlot(slot,file,'copilot')};}
test('expiry warns within a day, never invents expiry, and distinguishes expired',()=>{
 const now=Date.now();assert.equal(expiryWarning(undefined,now),undefined);assert.equal(expiryWarning(null,now),undefined);
 assert.equal(expiryWarning(new Date(now+2*86400000).toISOString(),now),undefined);
 assert.match(expiryWarning(new Date(now+86400000).toISOString(),now),/1 day/);
 assert.match(expiryWarning(new Date(now-1).toISOString(),now),/expired/);
});
test('in-session renewal serializes approval and accepts a replacement without rebinding the conversation',async t=>{
 const {binding,save}=await fixture(t);let finish,calls=0,opened;
 const controller=createSessionLogin(binding,{open:url=>opened=url,login:async opts=>{calls++;assert.equal(opts.renew,true);assert.equal(opts.binding,binding);opts.onPrompt({url:'https://platform.opper.ai/activate',code:'TEST'});await new Promise(r=>finish=r);await save({...slot,apiKey:'synthetic-new',expiresAt:new Date(Date.now()+2*86400000).toISOString()});}});
 t.onTestFinished(()=>controller.close());
 await save({...slot,expiresAt:'2000-01-01T00:00:00Z'});
 assert.match((await controller.status()).warning,/expired/);
 assert.equal((await controller.start()).phase,'approval');await controller.start();assert.equal(calls,1);assert.ok(opened);
 finish();for(let i=0;i<50&&(await controller.status()).phase!=='complete';i++)await new Promise(r=>setTimeout(r,5));
 assert.equal((await controller.status()).phase,'complete');assert.equal(await credential(binding),'synthetic-new');assert.equal((await controller.status()).warning,undefined);
 assert.doesNotMatch(JSON.stringify(await controller.status()),/synthetic|apiKey/);
});
test('changed identity blocks renewal, cancellation leaves old key usable',async t=>{
 const {binding,save}=await fixture(t);let calls=0;
 const controller=createSessionLogin(binding,{open:()=>{},login:async opts=>{calls++;await new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}});
 t.onTestFinished(()=>controller.close());await save({...slot,projectId:9});await assert.rejects(controller.start(),/identity changed/);assert.equal(calls,0);
 await save(slot);await controller.start();controller.cancel();await new Promise(r=>setTimeout(r,5));assert.equal((await controller.status()).phase,'error');assert.equal(await credential(binding),slot.apiKey);
});
test('login control endpoint requires the run token and exposes no credential',async t=>{
 const {binding}=await fixture(t);const bridge=await startBridge(binding,[],'test');t.onTestFinished(()=>bridge.close());
 const url=new URL('/opper/login',bridge.url);
 for(const method of ['GET','POST','DELETE'])assert.equal((await fetch(url,{method})).status,401);
 const response=await fetch(url,{headers:{Authorization:`Bearer ${bridge.token}`}});assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/synthetic|apiKey/);
});
