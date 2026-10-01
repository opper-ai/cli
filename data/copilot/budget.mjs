import {readFile} from 'node:fs/promises';
import {loginRequest} from './session-login-client.mjs';
import {pathToFileURL} from 'node:url';

const amount=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0?n:undefined;
const clean=s=>typeof s==='string'?s.replace(/[\x00-\x1f\x7f-\x9f]/g,' ').slice(0,160):undefined;
function scope(s) {
 if(!s||typeof s!=='object')return undefined;
 const date=typeof s.period_end==='string'?new Date(s.period_end):undefined;
 return {currency:/^[A-Z]{3}$/.test(s.currency??'')?s.currency:'USD',used:amount(s.spent_cents),limit:['project','organization','member','role'].includes(s.limit_scope)?amount(s.limit_cents):undefined,remaining:amount(s.remaining_cents),reset:date&&Number.isFinite(date.getTime())?date.toISOString():undefined};
}
/** Only the fields needed for the display cross the local bridge. */
export function budgetSnapshot(me,now=new Date()) {
 const project=scope(me.project_spend);
 if(project&&me.project_spend?.limit_scope!=='project'){project.limit=undefined;project.remaining=undefined;}
 const personal=scope(me.member_spend);
 if(personal&&!['member','role'].includes(me.member_spend?.limit_scope)){personal.limit=undefined;personal.remaining=undefined;}
 const result={personal,organizationName:clean(me.organization?.name),allowanceSource:personal?me.member_spend.limit_scope:undefined,projectName:clean(me.project?.name),project,blocked:me.blocked===true,updated:now.toISOString()};
 if(me.visibility?.organization_finance===true)result.organization={spend:scope(me.spend),credits:amount(me.balance?.balance_cents),currency:/^[A-Z]{3}$/.test(me.balance?.currency??'')?me.balance.currency:'USD'};
 return result;
}
const money=(n,c='USD')=>n===undefined?'unavailable':`${c} ${(n/100).toFixed(2)}`;
const date=s=>new Date(s).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
export function formatBudget(snapshot,footer=false) {
 const personal=!!snapshot.personal;
 const p=snapshot.personal??snapshot.project;
 if(!p||p.used===undefined)return 'Opper · budget unavailable';
 const reset=p.reset?`${p.limit===undefined?'period ends':'resets'} ${date(p.reset)} UTC`:'';
 const usage=p.limit===undefined?`${money(p.used,p.currency)} used · no ${personal?'personal':'project'} limit`:`${money(p.used,p.currency)} / ${money(p.limit,p.currency)} used`;
 if(footer)return ['Opper',snapshot.authWarning,snapshot.blocked?'spending blocked':undefined,usage,reset].filter(Boolean).join(' · ');
 const lines=[personal?'Opper · Your allowance':'Opper project budget',personal?snapshot.organizationName:snapshot.projectName,usage];
 if(personal)lines.push('Your usage across personal keys in this organization.');
 if(personal&&snapshot.allowanceSource==='role')lines.push('Allowance set by your role.');
 if(p.limit!==undefined) {
  if(p.limit>0&&p.remaining!==undefined){const percent=Math.round(p.used/p.limit*100);const filled=Math.min(20,Math.round(p.used/p.limit*20));lines.push(`[${'#'.repeat(filled)}${'-'.repeat(20-filled)}] ${percent}% used`);}
  if(p.remaining!==undefined)lines.push(`${money(p.remaining,p.currency)} remaining`);
 }else lines.push(personal?'Project and organization limits still apply.':'Organization funding and limits still apply.');
 if(reset)lines.push(reset);
 if(snapshot.blocked)lines.push('Spending blocked. Contact your administrator.');
 if(personal&&snapshot.project){const shared=snapshot.project;lines.push('', 'Shared project usage',snapshot.projectName,`Spend: ${money(shared.used,shared.currency)}`);if(shared.limit!==undefined)lines.push(`Limit: ${money(shared.limit,shared.currency)}`,`Remaining: ${money(shared.remaining,shared.currency)}`);else lines.push('No project limit.');}
 if(snapshot.organization){const o=snapshot.organization;lines.push('', 'Organization billing');if(o.credits!==undefined)lines.push(`Credits: ${money(o.credits,o.currency)}`);if(o.spend?.used!==undefined)lines.push(`Spend: ${money(o.spend.used,o.spend.currency)}`);if(o.spend?.limit!==undefined)lines.push(`Limit: ${money(o.spend.limit,o.spend.currency)}`);if(o.spend?.remaining!==undefined)lines.push(`Remaining: ${money(o.spend.remaining,o.spend.currency)}`);}
 lines.push('Latest reported usage; recent requests may take time to appear.');
 return lines.filter(x=>x!==undefined).join('\n');
}
export async function readBudget(file,refresh=false) {
 const config=JSON.parse(await readFile(file,'utf8'));
 const url=new URL(config.url);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/opper/budget'||url.search||url.hash)throw Error('Invalid budget bridge.');
 if(typeof config.token!=='string'||!/^[a-f0-9]{64}$/.test(config.token))throw Error('Invalid budget session.');
 if(refresh)url.searchParams.set('refresh','1');
 const res=await fetch(url,{headers:{Authorization:`Bearer ${config.token}`},redirect:'error',signal:AbortSignal.timeout(16000)});
 if(!res.ok)throw Error(res.status===401?'Opper sign-in needs attention. Sign in or renew, then restart.':'Opper budget unavailable. Try again shortly.');
 return res.json();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const footer=process.argv.includes('--footer');
 try{console.log(formatBudget(await readBudget(process.argv[2],!footer),footer));}
 catch{let warning;try{warning=(await loginRequest(process.argv[2])).warning;}catch{}
 console.log(warning??(footer?'Opper · budget unavailable':'Opper budget unavailable. Check your sign-in and connection.'));}
}
