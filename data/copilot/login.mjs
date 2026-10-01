import {assertBoundSlot,checkExpiry} from './core.mjs';
let runtime;
export function configureLoginRuntime(value){runtime=value;}
export function openBrowser(url){runtime.openBrowser(url);}
export async function signIn({name,previous,signal,onPrompt,binding}){
 if(previous.source!=='device-flow')throw Error('This key was supplied manually. Run opper login --force before using browser renewal.');
 const slot=await runtime.renew({previous,signal,onPrompt});
 signal.throwIfAborted();checkExpiry(slot);
 if(slot.apiKey===previous.apiKey)throw Error('Renewal did not replace the credential.');
 try{assertBoundSlot(binding,slot);}catch{
  throw Error('Browser approval completed, but the user, organization or project changed. Restart with opper login --force to recover the active key.');
 }
 if(!await runtime.replaceSlot(name,previous,slot))throw Error('Your stored login changed during approval. The newer credential was preserved.');
 return slot;
}
