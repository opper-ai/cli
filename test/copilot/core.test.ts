// @ts-nocheck
import {test} from 'vitest';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readSlot,bindSlot,credential,allowedModels,childEnvironment,origin} from '../../data/copilot/core.mjs';
const slot={apiKey:'synthetic-a',baseUrl:'https://api.opper.ai',orgId:1,projectId:2,user:{email:'test@example.invalid'}};
test('binding accepts same-identity rotation but rejects org/project/host changes, logout and expiry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'slot-test-')),path=join(dir,'config.json');
 const save=async value=>writeFile(path,JSON.stringify({version:1,keys:{default:value}}));
 await save(slot);const bound=bindSlot(await readSlot(path,'default'),path,'default');
 await save({...slot,apiKey:'synthetic-b'});assert.equal(await credential(bound),'synthetic-b');
 for(const patch of [{orgId:9},{projectId:9},{user:{email:'other'}},{baseUrl:'https://other.example'},{expiresAt:'bad'},{expiresAt:'2000-01-01T00:00:00Z'}]){
  await save({...slot,...patch});await assert.rejects(credential(bound));
 }
 await save(null);await assert.rejects(credential(bound),/removed/);
});
test('legacy credentials stay usable, but rotation without identity requires restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'legacy-test-')),path=join(dir,'config.json');
 const legacy={apiKey:'synthetic-a'};const bound=bindSlot(legacy,path,'default');
 await writeFile(path,JSON.stringify({version:1,keys:{default:legacy}}));assert.equal(await credential(bound),'synthetic-a');
 await writeFile(path,JSON.stringify({version:1,keys:{default:{apiKey:'synthetic-b'}}}));await assert.rejects(credential(bound),/identity/);
});
test('catalog excludes non-tool, embedding and unknown/invalid limits',()=>{
 const m={id:'test/model',context_length:128000,opper:{type:'llm',capabilities:['tools'],max_output_tokens:4096}};
 assert.deepEqual(allowedModels([m]),[{id:m.id,kind:'models',input:123904,output:4096}]);
 assert.deepEqual(allowedModels([{...m,context_length:undefined},{...m,opper:{...m.opper,type:'embedding'}},{...m,opper:{...m.opper,capabilities:[]}},{...m,opper:{...m.opper,max_output_tokens:128001}}]),[]);
});
test('routing strips conflicting provider secrets/settings and keeps ordinary tool permissions',()=>{
 const e=childEnvironment({COPILOT_PROVIDER_BEARER_TOKEN:'wrong',COPILOT_PROVIDER_HEADERS:'Authorization: wrong',COPILOT_PROVIDERS_CONFIG:'other.json',OPPER_API_KEY:'wrong',COPILOT_MODEL:'wrong',PATH:'/bin'}, {origin:'https://api.opper.ai'},{id:'test/m',input:100,output:20},'helper','profile');
 assert.equal(e.COPILOT_PROVIDER_BEARER_TOKEN,undefined);assert.equal(e.COPILOT_PROVIDER_HEADERS,undefined);assert.equal(e.COPILOT_PROVIDERS_CONFIG,undefined);assert.equal(e.OPPER_API_KEY,undefined);assert.equal(e.COPILOT_MODEL,'test/m');assert.equal(e.PATH,'/bin');assert.equal(e.COPILOT_ALLOW_ALL,undefined);
});
test('endpoint validation refuses remote HTTP, URL credentials and paths',()=>{
 for(const x of ['http://other.example','https://user:secret@example.com','https://api.opper.ai/v3','https://api.opper.ai?key=x'])assert.throws(()=>origin(x));
 assert.equal(origin('http://127.0.0.1:1234'),'http://127.0.0.1:1234');
});
test('organization personal binding accepts null/absent project renewal and rejects identity or scope changes',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'org-slot-test-')),path=join(dir,'config.json');
 const {rm}=await import('node:fs/promises');t.onTestFinished(()=>rm(dir,{recursive:true,force:true}));
 const personal={...slot,projectId:null,defaultProjectUuid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
 const target='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const bound=bindSlot(personal,path,'default',target);
 const save=async value=>writeFile(path,JSON.stringify({version:1,keys:{default:value}}));
 const rotated={...personal,apiKey:'synthetic-org-renewed',projectId:undefined,defaultProjectUuid:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'};
 await save(rotated);assert.equal(await credential(bound),'synthetic-org-renewed');
 assert.equal(bound.projectUuid,target);assert.equal(bound.identity.projectId,null);
 for(const patch of [{orgId:9},{projectId:2},{projectUuid:target},{user:{email:'other@example.invalid'}}]){
  await save({...rotated,...patch});await assert.rejects(credential(bound),/identity/);
 }
});
