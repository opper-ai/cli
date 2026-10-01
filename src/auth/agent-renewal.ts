import { fork } from "node:child_process";
import { assetPath } from "../util/assets.js";
import type { AuthSlot } from "./config.js";
import type { DevicePrompt } from "./device-flow.js";

/** Run the existing device flow in a cancellable worker, without terminal output. */
export function renewAgentCredential(options: {
  baseUrl: string; previous: AuthSlot; signal: AbortSignal;
  onPrompt: (prompt: {url: string; code: string}) => void;
}): Promise<AuthSlot> {
  options.signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=fork(assetPath("copilot/auth-worker.mjs"),[],{stdio:["ignore","ignore","ignore","ipc"],execArgv:[]});
    let settled=false;
    const finish=(error?: Error,slot?: AuthSlot): void=>{
      if(settled)return;settled=true;
      clearTimeout(timer);options.signal.removeEventListener("abort",abort);
      child.kill();
      if(error)reject(error);else if(slot)resolve(slot);else reject(new Error("Opper sign-in ended without a credential."));
    };
    const abort=(): void=>finish(new Error("Opper sign-in cancelled."));
    const timer=setTimeout(()=>finish(new Error("Opper approval timed out. Run /opper-login to retry.")),11*60*1000);
    options.signal.addEventListener("abort",abort,{once:true});
    child.on("error",error=>finish(error));
    child.on("exit",()=>finish(new Error("Opper sign-in stopped before approval completed.")));
    child.on("message",(message: unknown)=>{
      const value=message as {type?: string; prompt?: DevicePrompt; slot?: AuthSlot; message?: string};
      try{
        if(value.type==="prompt"&&value.prompt){
          const url=value.prompt.verificationUriComplete??value.prompt.verificationUri;
          if(new URL(url).origin!=="https://platform.opper.ai")throw new Error("Unexpected Opper approval website.");
          options.onPrompt({url,code:value.prompt.userCode});
        }else if(value.type==="result"){
          if(!value.slot?.apiKey||/[\r\n]/.test(value.slot.apiKey))throw new Error("Invalid credential returned by Opper.");
          finish(undefined,value.slot);
        }else if(value.type==="error")finish(new Error(value.message??"Opper sign-in failed."));
      }catch(error){finish(error instanceof Error?error:new Error("Opper sign-in failed."));}
    });
    if(options.signal.aborted){abort();return;}
    child.send({baseUrl:options.baseUrl,renew:true,...(options.previous.credentialId?{currentCredentialId:options.previous.credentialId}:{})});
  });
}
