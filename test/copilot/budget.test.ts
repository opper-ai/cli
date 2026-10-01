// @ts-nocheck
import {test} from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {budgetSnapshot,formatBudget,readBudget} from '../../data/copilot/budget.mjs';
import {startBridge} from '../../data/copilot/bridge.mjs';
import {bindSlot,allowedModels,parseKinds} from '../../data/copilot/core.mjs';
const me={project:{name:'Work\x1b\n'},project_spend:{spent_cents:250,limit_cents:1000,remaining_cents:750,limit_scope:'project',currency:'USD',period_end:'2026-10-01T00:00:00Z'},balance:{balance_cents:98765},spend:{spent_cents:76543},visibility:{organization_finance:false}};
test('project budget math and finance visibility do not leak organization amounts',()=>{
 const snap=budgetSnapshot(me);const text=formatBudget(snap);
 assert.match(text,/25% used/);assert.match(text,/USD 7.50 remaining/);assert.match(text,/1 Oct 2026 UTC/);
 assert.doesNotMatch(text,/987|765|\x1b/);assert.equal(snap.organization,undefined);
 const visible=budgetSnapshot({...me,visibility:{organization_finance:true}});
 assert.match(formatBudget(visible),/Organization billing/);assert.doesNotMatch(formatBudget(visible,true),/987|Organization/);
});
test('no cap, missing, zero and exceeded budgets stay distinct',()=>{
 assert.match(formatBudget(budgetSnapshot({})),/unavailable/);
 assert.match(formatBudget(budgetSnapshot({...me,project_spend:{spent_cents:0,limit_cents:null}})),/no project limit/);
 assert.doesNotMatch(formatBudget(budgetSnapshot({...me,project_spend:{...me.project_spend,limit_cents:0}})),/Infinity|NaN/);
 assert.match(formatBudget(budgetSnapshot({...me,project_spend:{...me.project_spend,spent_cents:1200,remaining_cents:0}})),/120% used/);
 assert.match(formatBudget(budgetSnapshot({...me,project_spend:{...me.project_spend,limit_scope:'organization'}})),/no project limit/);
});
test('budget bridge authenticates, caches, invalidates on rotation and fails closed on identity change',async t=>{
 let calls=0;let keySeen;
 const server=http.createServer((req,res)=>{calls++;keySeen=req.headers.authorization;res.end(JSON.stringify(me));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.onTestFinished(()=>{server.closeAllConnections();server.close();});
 const dir=await mkdtemp(join(tmpdir(),'budget-test-'));const file=join(dir,'config.json');
 const slot={apiKey:'synthetic-first',baseUrl:`http://127.0.0.1:${server.address().port}`,orgId:1,projectId:2,user:{email:'test@example.invalid'}};
 const save=async s=>writeFile(file,JSON.stringify({version:1,keys:{copilot:s}}));await save(slot);
 const bridge=await startBridge(bindSlot(slot,file,'copilot'),[],'synthetic');t.onTestFinished(()=>bridge.close());
 const url=new URL('/opper/budget',bridge.url).href;
 assert.equal((await fetch(url)).status,401);
 const config=join(dir,'budget.json');await writeFile(config,JSON.stringify({url,token:bridge.token}));
 assert.equal((await readBudget(config)).project.used,250);await readBudget(config);assert.equal(calls,1);
 await readBudget(config,true);assert.equal(calls,2);
 await save({...slot,apiKey:'synthetic-second'});await readBudget(config);assert.equal(calls,3);assert.equal(keySeen,'Bearer synthetic-second');
 await save({...slot,orgId:9});await assert.rejects(readBudget(config),/unavailable/);assert.equal(calls,3);
});
test('catalog kind filtering preserves server eligibility and orders routes then pools then models',()=>{
 const entry=(id,kind)=>({id,context_length:100,opper:{kind,type:'llm',capabilities:['tools'],max_output_tokens:10}});
 const list=[entry('z/model','model'),entry('a/pool','pool'),entry('dynamic/route','dynamic_route')];
 assert.deepEqual(allowedModels(list).map(m=>m.kind),['routes','pools','models']);
 assert.deepEqual(allowedModels(list,parseKinds('pools,routes')).map(m=>m.id),['dynamic/route','a/pool']);
 assert.throws(()=>parseKinds('nope'));assert.throws(()=>parseKinds(''));assert.equal(parseKinds('all').length,3);
});
test('personal and role budgets lead the footer and keep shared project usage separate',()=>{
 for(const limit_scope of ['member','role']){
  const snap=budgetSnapshot({...me,organization:{name:'Opper'},member_spend:{...me.project_spend,currency:'usd',limit_scope,spent_cents:140,limit_cents:2500,remaining_cents:2360}});
  const footer=formatBudget(snap,true);assert.match(footer,/USD 1.40 \/ USD 25.00/);assert.doesNotMatch(footer,/2.50|10.00/);
  const full=formatBudget(snap);assert.match(full,/Your allowance/);assert.match(full,/USD 23.60 remaining/);assert.match(full,/Shared project usage/);assert.match(full,/USD 2.50/);assert.doesNotMatch(full,/Organization billing/);
  assert.equal(full.includes('Allowance set by your role.'),limit_scope==='role');
 }
});
test('personal no cap and zero cap are not replaced with a project cap',()=>{
 for(const limit_cents of [null,0]){
  const snap=budgetSnapshot({...me,member_spend:{...me.project_spend,limit_scope:limit_cents===null?null:'member',limit_cents,remaining_cents:0}});
  const footer=formatBudget(snap,true);assert.doesNotMatch(footer,/10.00|NaN|Infinity/);
  assert.match(footer,limit_cents===null?/no personal limit/:/USD 0.00/);
 }
});
