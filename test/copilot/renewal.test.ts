import {test,expect} from 'vitest';
import http from 'node:http';
import {renewAgentCredential} from '../../src/auth/agent-renewal.js';
import {getSlot,setSlot,replaceSlotIfUnchanged} from '../../src/auth/config.js';
import {useTempOpperHome} from '../helpers/temp-home.js';
import {pathToFileURL} from 'node:url';
import {assetPath} from '../../src/util/assets.js';
useTempOpperHome();
const previous={apiKey:'synthetic-old',source:'device-flow' as const,credentialId:'1',orgId:1,projectId:2,user:{email:'test@example.invalid',name:'Test'}};
test('shared device-flow worker and shared locked writer renew the bound slot',async t=>{
 let posted:Record<string,string>={};
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;
  res.setHeader('content-type','application/json');
  if(req.url==='/oauth/device'){posted=Object.fromEntries(new URLSearchParams(body));res.end(JSON.stringify({device_code:'synthetic',user_code:'TEST',verification_uri:'https://platform.opper.ai/activate',expires_in:30,interval:0}));}
  else res.end(JSON.stringify({api_key:'synthetic-new',credential_id:'2',org_id:1,project_id:2,user:previous.user,expires_at:'2030-01-01T00:00:00Z'}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.onTestFinished(()=>{server.closeAllConnections();server.close();});
 const host=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const old={...previous,baseUrl:host};await setSlot('work',old);
 const module=await import(pathToFileURL(assetPath('copilot/login.mjs')).href);
 module.configureLoginRuntime({renew:({signal,onPrompt}:any)=>renewAgentCredential({baseUrl:host,previous:old,signal,onPrompt}),replaceSlot:replaceSlotIfUnchanged});
 const core=await import(pathToFileURL(assetPath('copilot/core.mjs')).href);
 const slot=await module.signIn({name:'work',previous:old,signal:AbortSignal.timeout(5000),onPrompt:()=>{},binding:{origin:host,identity:{orgId:1,projectId:2,email:previous.user.email}}});
 expect(slot.apiKey).toBe('synthetic-new');expect((await getSlot('work'))?.credentialId).toBe('2');expect(posted.renew).toBe('true');expect(posted.current_credential_id).toBe('1');
 expect(()=>core.assertBoundSlot({origin:host,identity:{orgId:1,projectId:99,email:previous.user.email}},slot)).toThrow(/identity changed/);
});
test('closing the session cancels shared polling before any key is issued',async t=>{
 let polls=0;const controller=new AbortController();
 const server=http.createServer((req,res)=>{
  if(req.url?.endsWith('/token'))polls++;
  res.end(JSON.stringify({device_code:'synthetic',user_code:'TEST',verification_uri:'https://platform.opper.ai/activate',expires_in:600,interval:5}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.onTestFinished(()=>{server.closeAllConnections();server.close();});
 const host=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 await expect(renewAgentCredential({baseUrl:host,previous,signal:controller.signal,onPrompt:()=>controller.abort()})).rejects.toThrow(/cancelled/);
 expect(polls).toBe(0);
});
