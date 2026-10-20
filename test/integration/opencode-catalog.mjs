// Build first. Real OpenCode picker + inference; fake credentials and loopback only.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
const home = await mkdtemp("/tmp/opper-oc-catalog-");
const cli = join(process.cwd(), "dist/index.js");
const entries = [
 {id:"vendor/deployment",opper:{kind:"model"}},
 {id:"claude-opus-5",opper:{kind:"pool"}},
 {id:"dynamic/catalog-test",opper:{kind:"dynamic_route",display_name:"Catalog Test"}},
].map(entry => ({...entry,context_length:128000,pricing:{prompt:"0.000001",completion:"0.000002"},opper:{...entry.opper,type:"llm",capabilities:["tools"],max_output_tokens:4096}}));
const requests=[]; let failure=false;
const server=createServer(async(req,res)=>{
 let raw=""; for await(const part of req) raw+=part;
 const body=raw ? JSON.parse(raw) : undefined;
 requests.push({path:req.url,auth:req.headers.authorization,model:body?.model});
 if(req.headers.authorization!=="Bearer synthetic") return res.writeHead(401).end();
 if(req.url==="/v3/compat/models") return res.writeHead(failure?503:200,{"Content-Type":"application/json"}).end(JSON.stringify({data:entries}));
 if(req.url?.endsWith("/chat/completions")) {
  const chunk=(delta,finish_reason=null)=>JSON.stringify({id:"synthetic",object:"chat.completion.chunk",created:1,model:body.model,choices:[{index:0,delta,finish_reason}]});
  return res.writeHead(200,{"Content-Type":"text/event-stream"}).end(`data: ${chunk({role:"assistant"})}\n\ndata: ${chunk({content:"CATALOG_RUNTIME_OK"})}\n\ndata: ${chunk({},"stop")}\n\ndata: [DONE]\n\n`);
 }
 res.writeHead(404).end();
});
function child(args,options,binary=process.execPath) {
 return new Promise((resolve,reject)=>{
  const proc=execFile(binary,args,options,(error,stdout,stderr)=>error?reject(Object.assign(error,{stdout,stderr})):resolve({stdout,stderr})); proc.stdin.end();
 });
}
try {
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const host=`http://127.0.0.1:${server.address().port}`;
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>["PATH","TMPDIR","LANG","NODE_EXTRA_CA_CERTS","HTTPS_PROXY","HTTP_PROXY","NO_PROXY"].includes(key)));
 Object.assign(env,{HOME:home,OPPER_EDITOR_HOME:home,OPPER_HOME:join(home,".opper"),OPPER_API_KEY:"synthetic",OPPER_BASE_URL:host,
 XDG_CONFIG_HOME:join(home,".config"),XDG_STATE_HOME:join(home,".local/state"),XDG_CACHE_HOME:join(home,".cache"),XDG_DATA_HOME:join(home,".local/share"),
 OPENCODE_TEST_HOME:home,OPENCODE_DISABLE_MODELS_FETCH:"true",OPENCODE_DISABLE_AUTOUPDATE:"true",OPENCODE_DISABLE_PROJECT_CONFIG:"true",OTEL_SDK_DISABLED:"true"});
 const options={cwd:home,env,timeout:45000,maxBuffer:8_000_000};
 const path=join(home,".config/opencode/opencode.json"); await mkdir(dirname(path),{recursive:true});
 const original={theme:"opencode",provider:{opper:{npm:"@ai-sdk/openai-compatible",name:"Opper",options:{baseURL:`${host}/v3/compat`,apiKey:"{env:OPPER_API_KEY}"}}}};
 await writeFile(path,JSON.stringify(original));
 const list=async()=> (await run("opencode",["models","opper"],options)).stdout.trim().split(/\r?\n/).filter(Boolean);
 const native=await list(); assert.ok(!native.includes("opper/dynamic/catalog-test"));
 assert.equal(requests.filter(request=>request.path.endsWith("/models")).length,0,"custom provider did not discover the gateway endpoint natively");
 await writeFile(path,JSON.stringify({theme:"opencode"}));
 const setup=(...args)=>run(process.execPath,[cli,"--no-telemetry","editors","opencode","--overwrite",...args],options);
 await setup(); assert.deepEqual(await list(),["opper/claude-opus-5","opper/dynamic/catalog-test"]);
 assert.equal(JSON.parse(await readFile(path,"utf8")).theme,"opencode");
 // A selected deployment absent from the narrow default must remain selectable.
 const configured=JSON.parse(await readFile(path,"utf8")); configured.model="opper/vendor/deployment";
 configured.agent={plan:{model:"opper/vendor/deployment"}}; await writeFile(path,JSON.stringify(configured));
 await setup(); assert.ok((await list()).includes("opper/vendor/deployment"));
 assert.equal(JSON.parse(await readFile(path,"utf8")).model,"opper/vendor/deployment");
 await writeFile(path,JSON.stringify({theme:"opencode"}));
 await setup("--model-kinds","all"); assert.equal((await list()).length,3);
 await setup("--model-kinds","pools,routes"); assert.equal((await list()).length,3,"refresh retains old catalog IDs that can back saved sessions");
 failure=true; const before=await readFile(path,"utf8"); await assert.rejects(setup()); assert.equal(await readFile(path,"utf8"),before); failure=false;
 for(const model of ["dynamic/catalog-test","vendor/deployment"]) {
  const result=await child([cli,"--no-telemetry","launch","opencode","--model",model,"run","Reply with the fixture text","--format","json"],options);
  assert.ok(result.stdout.includes("CATALOG_RUNTIME_OK"),result.stderr);
  assert.ok(requests.some(request=>request.model===model&&request.path.includes("/v3/session/")),"real inference used exact model and session route");
 }
 assert.deepEqual(JSON.parse(await readFile(path,"utf8")),JSON.parse(before),"launch restores original configuration values");
 // First-use native --model through a fresh login bridge must stay usable.
 await writeFile(path,JSON.stringify({theme:"opencode"}));
 await rm(join(env.XDG_STATE_HOME,"opencode/model.json"),{force:true});
 const version=(await run("opencode",["--version"],options)).stdout.trim();
 await writeFile(join(home,"npmrc"),""); await writeFile(join(home,"npmrc-global"),"");
 await run("npm",["install","--ignore-scripts","--no-audit","--no-fund",`@opencode-ai/plugin@${version}`,"--cache",join(home,"npm-cache")],{...options,cwd:dirname(path),env:{...env,NPM_CONFIG_USERCONFIG:join(home,"npmrc"),NPM_CONFIG_GLOBALCONFIG:join(home,"npmrc-global")}});
 await run(process.execPath,[cli,"--no-telemetry","editors","opencode","--login-bridge"],options);
 assert.ok((await readFile(join(dirname(path),"plugins/opper-login.js"),"utf8")).includes('const DEFAULT_MODEL_KINDS = "pools,routes";'));
 assert.deepEqual(await list(),["opper/claude-opus-5","opper/dynamic/catalog-test"]);
 const nativeResult=await child(["run","--model","opper/vendor/deployment","Reply with fixture text","--format","json"],options,"opencode");
 assert.ok(nativeResult.stdout.includes("CATALOG_RUNTIME_OK"),nativeResult.stderr);
 assert.ok(requests.some(request=>request.path==="/v3/compat/chat/completions"&&request.model==="vendor/deployment"));
 console.log("Fresh plain OpenCode login bridge: narrow default and first-use native provider model inference passed.");
 console.log("OpenCode native-discovery negative probe; actual picker fresh/selected/all/refresh; failure preservation; real route/deployment inference passed.");
} finally { await new Promise(resolve=>server.close(resolve)); await rm(home,{recursive:true,force:true}); }
