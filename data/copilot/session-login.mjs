import {readSlot,assertBoundSlot} from './core.mjs';
import {signIn,openBrowser} from './login.mjs';

export function expiryWarning(expiresAt,now=Date.now()) {
 if(expiresAt==null)return undefined;
 const left=Date.parse(expiresAt)-now;
 if(!Number.isFinite(left))return 'Opper sign-in expiry is invalid. Run /opper-login.';
 if(left<=0)return 'Opper sign-in expired. Run /opper-login, then retry your message.';
 if(left>86400000)return undefined;
 const hours=Math.ceil(left/3600000);
 return `Opper sign-in expires in ${hours>=24?'1 day':hours===1?'less than 1 hour':`${hours} hours`}. Run /opper-login to renew.`;
}

/** Auth stays in the launcher; the extension only receives status and approval details. */
export function createSessionLogin(binding,{login=signIn,open=openBrowser}={}) {
 let state={phase:'idle'},controller,operation,closed=false;
 async function status(){
  const slot=await readSlot(binding.configPath,binding.name);
  let warning,identity;
  try{if(!slot)throw Error('Opper sign-in was removed. Restart the launcher to sign in.');assertBoundSlot(binding,slot);identity={email:slot.user?.email,project:slot.projectName,expiresAt:slot.expiresAt};warning=expiryWarning(slot.expiresAt);}
  catch(error){warning=error.message;}
  return {...state,...identity,warning};
 }
 async function start(){
  if(closed)throw Error('The Opper session has ended.');
  if(operation)return status();
  const previous=await readSlot(binding.configPath,binding.name);
  if(!previous||!binding.identity)throw Error('This login has no verified identity. Restart the launcher with --login.');
  assertBoundSlot(binding,previous);
  if(operation)return status();
  controller=new AbortController();state={phase:'starting'};
  // Always renew on this explicit command, including before the expiry warning.
  operation=(async()=>{
   try{
    await login({file:binding.configPath,name:binding.name,previous,renew:true,binding,signal:controller.signal,
     onPrompt:({url,code})=>{state={phase:'approval',url,code};open(url);}});
    state={phase:'complete',message:'Opper sign-in renewed. Continue in this conversation; retry your message if it failed.'};
   }catch(error){state={phase:'error',message:controller.signal.aborted?'Opper sign-in cancelled. Run /opper-login to try again.':error.message};}
   finally{operation=undefined;}
  })();
  return status();
 }
 return {status,start,cancel(){controller?.abort();},close(){closed=true;controller?.abort();}};
}
