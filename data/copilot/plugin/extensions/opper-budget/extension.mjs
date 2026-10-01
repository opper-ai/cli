import {joinSession} from '@github/copilot-sdk/extension';
import {readBudget,formatBudget} from '../../../budget.mjs';
import {loginRequest,formatSignIn} from '../../../session-login-client.mjs';

const file=process.env.OPPER_COPILOT_BUDGET_FILE;
let busy=false;
const session=await joinSession({commands:[{
 name:'opper-usage',
 description:'Show your Opper usage, allowance and sign-in expiry',
 handler:async()=>{
  const sections=[];
  try{sections.push(formatSignIn(await loginRequest(file)));}
  catch{sections.push('Opper sign-in\nKey expiry: unavailable. Restart the launcher to refresh sign-in details.');}
  try{sections.push(formatBudget(await readBudget(file,true)));}
  catch{sections.push('Opper usage unavailable. Run /opper-login if your sign-in has expired.');}
  await session.log(sections.join('\n\n'),{level:'info'});
 }
},{
 name:'opper-login',
 description:'Renew your Opper sign-in and continue this conversation',
 handler:async()=>{
  if(busy){await session.log('Opper sign-in is already waiting for browser approval.',{level:'info'});return;}
  busy=true;
  try{
   let state=await loginRequest(file,'POST'),shownCode;
   const deadline=Date.now()+11*60*1000;
   while(!['complete','error'].includes(state.phase)){
    if(state.code&&state.code!==shownCode){shownCode=state.code;await session.log(`Approve Opper sign-in in your browser. Code: ${state.code}\n${state.url}`,{level:'info'});}
    if(Date.now()>deadline){await loginRequest(file,'DELETE');throw Error('Approval timed out. Run /opper-login to try again.');}
    await new Promise(resolve=>setTimeout(resolve,1000));state=await loginRequest(file);
   }
   await session.log(state.message,{level:state.phase==='error'?'warning':'info'});
  }catch(error){await session.log(error.message??'Opper sign-in failed. Run /opper-login to retry.',{level:'warning'});}
  finally{busy=false;}
 }
}]});
const seen=new Set();
async function warn(){
 try{
  const state=await loginRequest(file);
  if(state.warning&&!busy){const key=`${state.expiresAt}:${state.warning.includes('expired')?'expired':'soon'}`;
   if(!seen.has(key)){seen.add(key);await session.log(state.warning,{level:'warning'});}}
 }catch{} // A closing launcher should not generate repeated warnings.
}
await warn();
setInterval(()=>void warn(),60000).unref();
