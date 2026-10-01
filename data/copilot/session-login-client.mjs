import {readFile} from 'node:fs/promises';
export async function loginRequest(file,method='GET') {
 const config=JSON.parse(await readFile(file,'utf8'));
 const url=new URL(config.url);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/opper/budget'||url.search||url.hash)throw Error('Invalid Opper session bridge.');
 if(typeof config.token!=='string'||!/^[a-f0-9]{64}$/.test(config.token))throw Error('Invalid Opper session token.');
 url.pathname='/opper/login';
 const res=await fetch(url,{method,headers:{Authorization:`Bearer ${config.token}`},redirect:'error',signal:AbortSignal.timeout(15000)});
 const value=await res.json();
 if(!res.ok)throw Error(value.error?.message??'Opper sign-in unavailable.');
 return value;
}

const clean=value=>String(value??'Unavailable').replace(/[\x00-\x1f\x7f-\x9f]/g,' ').slice(0,200);
export function formatSignIn(status){
 const expiry=status.expiresAt;
 const date=typeof expiry==='string'?new Date(expiry):undefined;
 const description=date&&Number.isFinite(date.getTime())?date.toLocaleString('en-GB',{timeZone:'UTC'})+' UTC':expiry===null?'No expiry set':'Not provided by the server';
 return ['Opper sign-in',`Account: ${clean(status.email)}`,`Project: ${clean(status.project)}`,`Key expiry: ${description}`,status.warning, 'Run /opper-login to renew.'].filter(Boolean).join('\n');
}
