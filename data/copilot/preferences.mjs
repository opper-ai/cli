import {readdir,readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
/** Copilot 1.0.88 records /model choices in the primary session event log. */
export async function selectedModel(profile,allowed) {
 let selected;
 try{
  const state=join(profile,'session-state');const dirs=await readdir(state,{withFileTypes:true});
  for(const dir of dirs.filter(d=>d.isDirectory())) {
   const input=createReadStream(join(state,dir.name,'events.jsonl'));input.on('error',()=>{});
   const lines=createInterface({input,crlfDelay:Infinity});
   try{for await(const line of lines){try{const e=JSON.parse(line);if(e.type==='session.model_change'&&typeof e.data?.newModel==='string'){const model=e.data.newModel.replace(/^opper\//,'');if(allowed.some(m=>m.id===model))selected=model;}}catch{}}}catch{}finally{lines.close();input.destroy();}
  }
 }catch{}
 if(selected)return selected;
 try{const settings=JSON.parse(await readFile(join(profile,'settings.json'),'utf8'));const model=settings.model?.replace(/^opper\//,'');if(allowed.some(m=>m.id===model))return model;}catch{}
}
