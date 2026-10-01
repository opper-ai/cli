// @ts-nocheck
import {test,expect,vi} from 'vitest';
import {getSlot,setSlot,replaceSlotIfUnchanged} from '../../src/auth/config.js';
import {configPath} from '../../src/auth/paths.js';
import {useTempOpperHome} from '../helpers/temp-home.js';
import {bindSlot,credential} from '../../data/copilot/core.mjs';
import {configureLoginRuntime,signIn} from '../../data/copilot/login.mjs';
useTempOpperHome();
const oldProject='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const target='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const previous={apiKey:'synthetic-old',source:'device-flow',credentialId:'1',orgId:1,projectId:2,projectUuid:oldProject,user:{email:'test@example.invalid'}};
const replacement={apiKey:'synthetic-personal',source:'device-flow',credentialId:'2',orgId:1,user:previous.user};
const approve=(binding)=>signIn({name:'work',previous,signal:AbortSignal.timeout(5000),onPrompt:()=>{},binding});

test.each([{}, {projectId:null,projectUuid:null}])('explicit renewal migrates a legacy project binding to personal scope (%j)',async projectFields=>{
 await setSlot('work',previous);
 const binding=bindSlot(previous,configPath(),'work',target);
 const next={...replacement,...projectFields};
 configureLoginRuntime({renew:async()=>next,replaceSlot:replaceSlotIfUnchanged});
 expect(await approve(binding)).toBe(next);
 expect((await getSlot('work')).apiKey).toBe('synthetic-personal');
 expect(binding.identity).toEqual({orgId:1,email:previous.user.email,projectId:null,projectUuid:null});
 expect(binding.projectUuid).toBe(target);
 expect(await credential(binding)).toBe('synthetic-personal');
 // An external slot edit cannot reverse the approved migration.
 await setSlot('work',{...previous,apiKey:'synthetic-external'});
 await expect(credential(binding)).rejects.toThrow(/identity changed/);
});

test('a concurrent saved credential prevents CAS replacement and leaves the live binding unchanged',async()=>{
 await setSlot('work',previous);
 const binding=bindSlot(previous,configPath(),'work',target),identity=binding.identity;
 configureLoginRuntime({renew:async()=>{
  await setSlot('work',{...previous,apiKey:'synthetic-concurrent'});
  return replacement;
 },replaceSlot:replaceSlotIfUnchanged});
 await expect(approve(binding)).rejects.toThrow(/stored login changed/);
 expect(binding.identity).toBe(identity);expect(binding.projectUuid).toBe(target);
 expect((await getSlot('work')).apiKey).toBe('synthetic-concurrent');
 expect(await credential(binding)).toBe('synthetic-concurrent');
});

test.each([
 {orgId:9},
 {orgId:undefined},
 {user:{email:'other@example.invalid'}},
 {user:undefined},
 {projectId:9,projectUuid:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'},
 {projectId:null,projectUuid:oldProject},
 {baseUrl:'https://other.example.invalid'},
])('renewal rejects a changed or incomplete approved identity (%j)',async patch=>{
 await setSlot('work',previous);
 const binding=bindSlot(previous,configPath(),'work',target),identity=binding.identity;
 const replaceSlot=vi.fn(replaceSlotIfUnchanged);
 configureLoginRuntime({renew:async()=>({...replacement,...patch}),replaceSlot});
 await expect(approve(binding)).rejects.toThrow(/user, organization or project changed/);
 expect(replaceSlot).not.toHaveBeenCalled();
 expect(binding.identity).toBe(identity);expect(binding.projectUuid).toBe(target);
 expect((await getSlot('work')).apiKey).toBe('synthetic-old');
});

test('external legacy-to-personal slot changes remain forbidden without explicit renewal',async()=>{
 await setSlot('work',previous);
 const binding=bindSlot(previous,configPath(),'work',target);
 await setSlot('work',replacement);
 await expect(credential(binding)).rejects.toThrow(/identity changed/);
 expect(binding.identity.projectId).toBe(2);expect(binding.projectUuid).toBe(target);
});

test('explicit renewal cannot change a personal session back to a bound project',async()=>{
 await setSlot('work',replacement);
 const binding=bindSlot(replacement,configPath(),'work',target),identity=binding.identity;
 const replaceSlot=vi.fn(replaceSlotIfUnchanged);
 configureLoginRuntime({renew:async()=>({...previous,apiKey:'synthetic-bound-again'}),replaceSlot});
 await expect(signIn({name:'work',previous:replacement,signal:AbortSignal.timeout(5000),onPrompt:()=>{},binding})).rejects.toThrow(/user, organization or project changed/);
 expect(replaceSlot).not.toHaveBeenCalled();expect(binding.identity).toBe(identity);
 expect(binding.projectUuid).toBe(target);expect((await getSlot('work')).apiKey).toBe('synthetic-personal');
});
