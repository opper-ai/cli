// After npm run build: node test/integration/claude-desktop-catalog.mjs
// Isolated adapter configuration with synthetic HTTP. Where Claude Desktop is
// installed on macOS, also executes its bundled discovery/parser composition
// functions in a VM fixture; never starts the app or reads account state.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const app = "/Applications/Claude.app";
if (process.platform !== "darwin" || !existsSync(app)) {
  console.log("Claude Desktop native fixture requires an installed macOS app; skipped.");
  process.exit(0);
}
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "opper-desktop-catalog-"));
const selected = "provider/claude-sonnet-5";
const pools = ["claude-opus-5", "claude-sonnet-5"];
const requests = [];
let oldServer = false;
let denied = false;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  requests.push({path:url.pathname,headers:request.headers});
  if (request.headers.authorization !== "Bearer synthetic" || denied) { response.writeHead(403).end(); return; }
  const all = request.headers["x-opper-catalog-model-kinds"] === "all";
  const ids = all || url.pathname.endsWith("compat/models") ? [...pools, selected] : pools;
  const wanted = request.headers["x-opper-catalog-selected-model"];
  if (wanted && !ids.includes(wanted)) { response.writeHead(404).end(); return; }
  const ordered = wanted ? [wanted,...ids.filter(id=>id!==wanted)] : ids;
  response.writeHead(200, {"Content-Type":"application/json",...(!oldServer ? {"X-Opper-Model-Catalog":"claude-desktop"} : {})});
  response.end(JSON.stringify({data:ordered.map(id=>({id,type:"model",created_at:"2024-01-01T00:00:00Z",display_name:id.includes("sonnet")?"Claude Sonnet 5":id})),has_more:false}));
});

try {
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const baseUrl=`http://127.0.0.1:${server.address().port}`;
  const env={PATH:process.env.PATH,HOME:directory,USERPROFILE:directory};
  const adapterURL=pathToFileURL(join(process.cwd(),"dist","agents","claude-desktop.js")).href;
  const driver=join(directory,"configure.mjs");
  await writeFile(driver,`import {claudeDesktop} from ${JSON.stringify(adapterURL)}; await claudeDesktop.configure(JSON.parse(process.argv[2])); if(!await claudeDesktop.isConfigured()) throw Error("configured profile not recognized");`);
  const configure=(extra={})=>run(process.execPath,[driver,JSON.stringify({apiKey:"synthetic",baseUrl,...extra})],{env,cwd:directory,timeout:20000,maxBuffer:100000});
  const profilePath=join(directory,"Library","Application Support","Claude-3p","configLibrary","727f05c8-a429-43cc-b1c6-36d8883d98b8.json");
  const profile=async()=>JSON.parse(await readFile(profilePath,"utf8"));
  await configure({projectUuid:"synthetic-project"});
  assert.equal((await profile()).inferenceCustomHeaders["X-Opper-Project"],"synthetic-project");
  assert.equal((await profile()).modelDiscoveryEnabled,true);
  assert.ok(!Object.hasOwn(await profile(),"inferenceModels"));
  assert.equal((await profile()).inferenceCustomHeaders["X-Opper-Catalog-Model-Kinds"],"pools,routes");
  await configure({model:selected,modelKinds:"all"});
  assert.equal((await profile()).inferenceCustomHeaders["X-Opper-Catalog-Selected-Model"],selected);
  await configure();
  assert.equal((await profile()).inferenceCustomHeaders["X-Opper-Catalog-Model-Kinds"],"all");
  assert.equal((await profile()).inferenceCustomHeaders["X-Opper-Catalog-Selected-Model"],selected);
  const before=await readFile(profilePath,"utf8");
  denied=true;
  await assert.rejects(configure());
  assert.equal(await readFile(profilePath,"utf8"),before);
  denied=false;
  oldServer=true;
  await assert.rejects(configure());
  assert.equal(await readFile(profilePath,"utf8"),before);
  oldServer=false;

  // Extract only pure/native catalog functions from the installed distribution.
  // Electron, account, Keychain and app lifecycle code are never evaluated.
  const asar=await readFile(join(app,"Contents","Resources","app.asar"));
  const table=JSON.parse(asar.subarray(16,16+asar.readUInt32LE(12)).toString());
  const dataStart=8+asar.readUInt32LE(4);
  const candidates=Object.values(table.files[".vite"].files.build.files).filter(entry=>entry.offset&&entry.size>1_000_000&&entry.size<10_000_000);
  const text=candidates.map(entry=>asar.subarray(dataStart+Number(entry.offset),dataStart+Number(entry.offset)+entry.size).toString()).find(text=>text.includes("inferenceModels obviates discovery"));
  assert.ok(text,"Installed native discovery implementation must be identifiable");
  const source=ts.createSourceFile("desktop-native.js",text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const functions=new Map(); const variables=new Map();
  let wireMethod;
  for(const statement of source.statements) {
    if(ts.isFunctionDeclaration(statement)&&statement.name) functions.set(statement.name.text,statement.getText(source));
    if(ts.isVariableStatement(statement)) for(const declaration of statement.declarationList.declarations) {
      if(ts.isIdentifier(declaration.name)) variables.set(declaration.name.text,`var ${declaration.getText(source)};`);
      if(ts.isIdentifier(declaration.name)&&declaration.name.text==="Ean"&&declaration.initializer&&ts.isClassExpression(declaration.initializer)) {
        wireMethod=declaration.initializer.members.find(member=>member.name?.getText(source)==="anthropicWire")?.getText(source);
      }
    }
  }
  // Symbol names are from installed 2.42304.2; another distribution should fail
  // visibly for inspection instead of pretending it exercised the same code.
  const requiredFunctions=["Mo","gCe","No","k8t","A8t","j8t","N8t","I8t","WC","V8t","H8t","U8t","Gvn","D8t","E8t","w8t","S8t","C8t","x8t","y8t","T8t"];
  const requiredVariables=["Ao","aCe","oCe","sCe","B8t","UC","v8t","jo","h8t","g8t","_8t"];
  for(const name of requiredFunctions) assert.ok(functions.has(name),`Missing native function ${name}`);
  for(const name of requiredVariables) assert.ok(variables.has(name),`Missing native variable ${name}`);
  assert.ok(wireMethod,"Native gateway wire resolution must be identifiable");
  const fixture=runInNewContext([...requiredVariables.map(name=>variables.get(name)),...requiredFunctions.map(name=>functions.get(name)),`({discover:H8t,compose:Gvn,wire:({${wireMethod}}).anthropicWire})`].join("\n"),{
    fetch,Yb:fetch,URL,URLSearchParams,AbortSignal,Map,Set,
    N:{warn(){}},BC:value=>typeof value==="string"&&value.trim()?value.trim():undefined,
    OC:value=>value,Twe:()=>false,$n:value=>value,
    Jb:()=>undefined,mKt:()=>false,zo:value=>value,m8t:value=>value,
  });
  const headers=(await profile()).inferenceCustomHeaders;
  const discovered=await fixture.discover(`${baseUrl}/v3/compat`,"synthetic","bearer",headers);
  assert.equal(discovered.ok,true);
  const dynamic=fixture.compose("gateway",{discovered:discovered.models});
  assert.deepEqual(Array.from(dynamic,model=>model.id),[selected,...pools]);
  const pinned=fixture.compose("gateway",{adminList:[{name:pools[0]}],discovered:discovered.models});
  assert.deepEqual(Array.from(pinned,model=>model.id),[pools[0]],"explicit list suppresses the discovered lineup");
  const configured=await profile();
  const wire=fixture.wire.call({creds:{baseUrl:configured.inferenceGatewayBaseUrl,headers:configured.inferenceCustomHeaders},resolvedAuthScheme:()=>configured.inferenceGatewayAuthScheme,providerLabel:"Gateway"});
  assert.equal(wire.adminHeaders["X-Opper-Project"],"synthetic-project");
  await fetch(`${wire.baseUrl}/v1/messages`,{method:"POST",headers:{Authorization:"Bearer synthetic",...wire.adminHeaders,"Content-Type":"application/json"},body:JSON.stringify({model:selected,messages:[{role:"user",content:"synthetic request"}]})});
  assert.equal(requests.at(-1).path,"/v3/compat/v1/messages");
  assert.equal(requests.at(-1).headers["x-opper-project"],"synthetic-project");
  assert.ok(requests.every(request=>request.headers.authorization==="Bearer synthetic"&&request.headers["x-opper-project"]==="synthetic-project"));
  console.log("Claude Desktop: real installed version gate and isolated native config passed; native bundled discovery/parser/composition fixture fetched synthetic catalog, retained provider selection, and proved explicit lists pin the picker. Native gateway wire resolution kept the same project on the synthetic message request. Auth failure/downgrade preserved configuration. App UI and real inference were not launched.");
} finally {
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  await rm(directory,{recursive:true,force:true});
}
