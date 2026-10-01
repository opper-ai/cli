import {test,expect,onTestFinished} from 'vitest';
import http from 'node:http';
import {renewAgentCredential} from '../../src/auth/agent-renewal.js';
import {getSlot,setSlot,replaceSlotIfUnchanged} from '../../src/auth/config.js';
import {useTempOpperHome} from '../helpers/temp-home.js';
import {pathToFileURL} from 'node:url';
import {assetPath} from '../../src/util/assets.js';
useTempOpperHome();
const previous={apiKey:'synthetic-old',source:'device-flow' as const,credentialId:'1',orgId:1,projectId:2,user:{email:'test@example.invalid',name:'Test'}};
test.each([
 {projectId:2,previousProjectId:2,label:'project-bound'},
 {projectId:undefined,previousProjectId:undefined,label:'organization personal'},
 {projectId:undefined,previousProjectId:2,previousProjectUuid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',label:'legacy bound to organization personal'},
])('shared device-flow worker renews the $label slot with verified metadata',async ({projectId,previousProjectId,previousProjectUuid})=>{
 let posted:Record<string,string>={};
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;
  res.setHeader('content-type','application/json');
  if(req.url==='/oauth/device'){posted=Object.fromEntries(new URLSearchParams(body));res.end(JSON.stringify({device_code:'synthetic',user_code:'TEST',verification_uri:'https://platform.opper.ai/activate',expires_in:30,interval:0}));}
  else res.end(JSON.stringify({api_key:'synthetic-new',credential_id:'2',org_id:1,...(projectId!==undefined?{project_id:projectId}:{}),user:previous.user,expires_at:'2030-01-01T00:00:00Z'}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));onTestFinished(()=>{server.closeAllConnections();server.close();});
 const host=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const {projectId:ignored,...personal}=previous;
 const old={...personal,...(previousProjectId!==undefined?{projectId:previousProjectId}:{}),...(previousProjectUuid?{projectUuid:previousProjectUuid}:{}),baseUrl:host};await setSlot('work',old);
 const module=await import(pathToFileURL(assetPath('copilot/login.mjs')).href);
 module.configureLoginRuntime({renew:({signal,onPrompt}:any)=>renewAgentCredential({baseUrl:host,previous:old,signal,onPrompt}),replaceSlot:replaceSlotIfUnchanged});
 const core=await import(pathToFileURL(assetPath('copilot/core.mjs')).href);
 const binding=core.bindSlot(old,'unused','work','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
 const slot=await module.signIn({name:'work',previous:old,signal:AbortSignal.timeout(5000),onPrompt:()=>{},binding});
 expect(slot.apiKey).toBe('synthetic-new');expect(slot.orgId).toBe(1);expect(slot.projectId).toBe(projectId);expect(slot.projectUuid).toBeUndefined();expect(binding.identity.projectId).toBe(projectId??null);expect(binding.identity.projectUuid).toBeNull();expect(binding.projectUuid).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');expect((await getSlot('work'))?.credentialId).toBe('2');expect(posted.renew).toBe('true');expect(posted.current_credential_id).toBe('1');
 expect(()=>core.assertBoundSlot({origin:host,identity:{orgId:1,projectId:99,email:previous.user.email}},slot)).toThrow(/identity changed/);
});
test('closing the session cancels shared polling before any key is issued',async t=>{
 let polls=0;const controller=new AbortController();
 const server=http.createServer((req,res)=>{
  if(req.url?.endsWith('/token'))polls++;
  res.end(JSON.stringify({device_code:'synthetic',user_code:'TEST',verification_uri:'https://platform.opper.ai/activate',expires_in:600,interval:5}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));onTestFinished(()=>{server.closeAllConnections();server.close();});
 const host=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 await expect(renewAgentCredential({baseUrl:host,previous,signal:controller.signal,onPrompt:()=>controller.abort()})).rejects.toThrow(/cancelled/);
 expect(polls).toBe(0);
});
