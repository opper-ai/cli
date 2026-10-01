import http from 'node:http';
import {createSessionLogin,expiryWarning} from './session-login.mjs';
import {readSlot} from './core.mjs';
import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {credential} from './core.mjs';
import {budgetSnapshot} from './budget.mjs';
import {createHash} from 'node:crypto';

// Copilot 1.0.88's registry supports static credentials, not apiKeyCommand.
// Give it a run-local token; the actual Opper key stays in the existing slot.
export async function startBridge(binding, models, traceId, inferenceBase) {
  const token=randomBytes(32).toString('hex');
  const allowed=new Set(models.map(m=>m.id));
  let credentialError;
  const login=createSessionLogin(binding);
  let budgetCache;
  let budgetPending;
  const server=http.createServer(async(req,res)=>{
    const fail=(status,message)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message,type:'opper_adapter_error'}}));};
    if(req.headers.authorization!==`Bearer ${token}`) return fail(401,'Invalid local session credential.');
    if(req.url==='/opper/login') {
      try{
        const value=req.method==='POST'?await login.start():req.method==='GET'?await login.status():req.method==='DELETE'?(login.cancel(),await login.status()):undefined;
        if(!value)return fail(405,'Unsupported login method.');
        if(value.phase==='complete')credentialError=undefined;
        else if(credentialError&&!value.warning)value.warning=credentialError;
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));
      }catch(error){fail(409,error.message);}
      return;
    }
    if(req.method==='GET'&&['/opper/budget','/opper/budget?refresh=1'].includes(req.url)) {
      try {
        const key=await credential(binding);
        const hash=createHash('sha256').update(key).digest('hex');
        if(!budgetCache||budgetCache.hash!==hash||Date.now()-budgetCache.time>60000||req.url.endsWith('refresh=1')) {
          if(!budgetPending||budgetPending.hash!==hash) {
            const promise=(async()=>{
              const upstream=await fetch(binding.origin+'/v3/me',{headers:{Authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(15000)});
              if(!upstream.ok)throw Error('budget unavailable');
              const value=budgetSnapshot(await upstream.json());
              // Do not return one identity's financial data after a slot change.
              if(await credential(binding)!==key)throw Error('credential changed');
              budgetCache={hash,time:Date.now(),value};return value;
            })();
            budgetPending={hash,promise};
            promise.finally(()=>{if(budgetPending?.promise===promise)budgetPending=undefined;}).catch(()=>{});
          }
          await budgetPending.promise;
        }
        if(await credential(binding)!==key)throw Error('credential changed');
        const authWarning=expiryWarning((await readSlot(binding.configPath,binding.name))?.expiresAt);
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({...budgetCache.value,authWarning}));
      }catch {budgetCache=undefined;fail(503,'Budget unavailable. Check your sign-in and connection.');}
      return;
    }
    if(req.method!=='POST'||req.url!=='/v3/compat/chat/completions')return fail(404,'Unsupported adapter endpoint.');
    const abort=new AbortController();
    res.on('close',()=>abort.abort());
    try {
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>16*1024*1024)return fail(413,'Request exceeds adapter size limit.');chunks.push(chunk);}
      let body;
      try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return fail(400,'Invalid JSON request.');}
      if(!body||!allowed.has(body.model))return fail(403,'Model is not in this session’s allowed Opper catalog. Restart to refresh models.');
      // Explicit compat workaround for Claude 5 sampling rejection. Do not
      // change prompts, tools, output limits, or sampling on other families.
      if(/(^|\/)claude-(sonnet|opus|fable)-5(?:-|$)/.test(body.model)){
        delete body.temperature;delete body.top_p;delete body.top_k;
      }
      let key;
      try{key=await credential(binding);}catch(error){credentialError=error.message;return fail(401,credentialError);}
      const upstream=await fetch(inferenceBase?inferenceBase+'/chat/completions':binding.origin+'/v3/compat/chat/completions',{
        method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','X-Opper-Trace-Id':traceId},
        body:JSON.stringify(body),redirect:'error',signal:abort.signal,
      });
      if(upstream.status===401){credentialError='Opper rejected this login. Run /opper-login, then retry your message.';await upstream.body?.cancel();return fail(401,credentialError);}
      res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json','cache-control':'no-store'});
      if(upstream.body)await pipeline(Readable.fromWeb(upstream.body),res);else res.end();
    }catch(error){if(!res.headersSent&&!res.destroyed)fail(502,'Opper request failed. Check connectivity and retry.');else res.destroy();}
  });
  server.requestTimeout=120000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:`http://127.0.0.1:${server.address().port}/v3/compat`,token,get credentialError(){return credentialError;},async close(){login.close();server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
