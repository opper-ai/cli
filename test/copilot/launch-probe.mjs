import http from 'node:http';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const here=dirname(fileURLToPath(import.meta.url));
const root=await mkdtemp(join(tmpdir(),"copilot launch 'test-"));
const file=join(root,'config.json');
await writeFile(join(root,'fixture.txt'),'OPPER_LAUNCHER_TOOL_OK');
const expired=process.argv.includes('--expired');
let seenTool=false;const auths=[];
const model={id:'opper/probe',context_length:128000,opper:{type:'llm',capabilities:['tools'],max_output_tokens:4096}};
let slot={apiKey:'synthetic-first',orgId:1,projectId:2,user:{email:'probe@example.invalid'}};
const save=async()=>writeFile(file,JSON.stringify({version:1,keys:{default:slot}}),{mode:0o600});
const server=http.createServer(async(req,res)=>{
 if(req.url==='/v3/compat/models'){res.end(JSON.stringify({data:[model]}));return;}
 if(req.url==='/v3/me'){res.end(JSON.stringify({organization:{name:'Probe'},project:{name:'Probe'},blocked:false}));return;}
 if(!/^\/v3\/session\/sess_[^/]+\/chat\/completions$/.test(req.url)){res.writeHead(404);res.end();return;}
 let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);
 auths.push(req.headers.authorization);
 seenTool=body.messages.some(m=>m.role==='tool'&&JSON.stringify(m.content).includes('OPPER_LAUNCHER_TOOL_OK'));
 // Rotate the selected slot after request1, before the next request helper runs.
 slot={...slot,apiKey:'synthetic-second',...(expired?{expiresAt:'2000-01-01T00:00:00Z'}:{})};await save();
 const delta=seenTool?{content:'OPPER_LAUNCHER_DONE'}:{tool_calls:[{index:0,id:'read',type:'function',function:{name:'view',arguments:JSON.stringify({path:join(root,'fixture.txt')})}}]};
 res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'probe',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:seenTool?'stop':'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));slot.baseUrl=`http://127.0.0.1:${server.address().port}`;await save();
const executable=process.env.COPILOT_NPX_PACKAGE?'npx':process.execPath;
const prefix=process.env.COPILOT_NPX_PACKAGE?['--yes','--package='+process.env.COPILOT_NPX_PACKAGE,'opper']:[process.env.COPILOT_CLI_ENTRY??join(here,'../../dist/index.js')];
const child=spawn(executable,[...prefix,'--key','default','launch','copilot','--model',model.id,'--','-p','Read fixture.txt then finish.','--available-tools=view','--allow-tool=view','--disable-builtin-mcps','--no-custom-instructions','--log-level=none','--silent'],{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,OPPER_HOME:root},stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
const timer=setTimeout(()=>child.kill(),120000);const code=await new Promise(r=>child.on('exit',r));clearTimeout(timer);server.close();
console.log(JSON.stringify({code,auths,seenTool,output},null,2));
if(expired){assert.equal(code,1);assert.equal(auths.length,1);assert.match(output,/sign-in expired/);}
else{assert.equal(code,0);assert.deepEqual(auths,['Bearer synthetic-first','Bearer synthetic-second']);assert.ok(seenTool);assert.match(output,/OPPER_LAUNCHER_DONE/);}
assert.doesNotMatch(output,/synthetic-first|synthetic-second/);
