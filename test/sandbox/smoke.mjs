// Run after npm run build: node test/sandbox/smoke.mjs
// Uses a fake agent/key; SRT additionally makes credential-free network probes.
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { launchSandbox } from "../../dist/sandbox/launch.js";
const root = realpathSync(mkdtempSync(join(tmpdir(), "opper-smoke-")));
const old = process.cwd();
const project = join(root, "project with space");
mkdirSync(project);
mkdirSync(join(root, "bin"));
const sentinel = join(root, "outside");
writeFileSync(sentinel, "unchanged");
writeFileSync(
  join(root, "bin", "claude"),
  `#!${process.execPath}
const fs=require('fs');
const cp=require('child_process');
if(process.env.AWS_SECRET_ACCESS_KEY)process.exit(20);
if(process.env.ANTHROPIC_AUTH_TOKEN!=='fake-key')process.exit(21);
if(process.argv.at(-1)!==\"literal ' $(touch /tmp/nope)\")process.exit(22);
const settingsIndex=process.argv.indexOf('--settings');
if(settingsIndex<0)process.exit(29);
const settings=JSON.parse(fs.readFileSync(process.argv[settingsIndex+1],"utf8"));
if(settings.sandbox.enabled!==false)process.exit(31);
for(const name of ['SessionStart','PreToolUse','PostToolUse']) {
 const hook=cp.spawnSync('/bin/sh',['-c',settings.hooks[name][0].hooks[0].command],{input:JSON.stringify({hook_event_name:name,tool_name:'Bash',tool_use_id:'smoke',tool_input:{command:'must-not-log-this'}})});
 if(hook.status!==0)process.exit(30);
}
fs.writeFileSync('allowed','ok');
fs.writeFileSync(process.env.HOME+'/config','ok');
try{fs.writeFileSync(${JSON.stringify(sentinel)},'bad');process.exit(23)}catch(e){if(!['EPERM','EACCES','EROFS'].includes(e.code))throw e;}
const child=cp.spawnSync(process.execPath,['-e',${JSON.stringify(`try{require('fs').writeFileSync(${JSON.stringify(sentinel)},'bad');process.exit(24)}catch(e){process.exit(['EPERM','EACCES','EROFS'].includes(e.code)?0:25)}`)}]);
if(child.status!==0)process.exit(26);
if(process.env.NODE_USE_ENV_PROXY==='1') {
 const allowed=cp.spawnSync('/usr/bin/curl',['-sS','-o','/dev/null','--max-time','15','https://api.opper.ai/']);
 if(allowed.status!==0) {console.error('Allowed request failed',allowed.stderr.toString());process.exit(27);}
 const denied=cp.spawnSync('/usr/bin/curl',['-sS','-o','/dev/null','--max-time','15','https://example.com/']);
 if(denied.status===0)process.exit(28);
 console.log('SRT allowed Opper and blocked example.com');
}
if(process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.setRawMode(false); console.log('Interactive raw terminal mode passed'); }
fs.writeFileSync('home-path',process.env.HOME);
console.log('Agent launch, literal arguments, clean environment, project/home writes, outside-write denial and child isolation passed');
`,
  { mode: 0o755 },
);
process.env.PATH = join(root, "bin") + ":" + process.env.PATH;
process.env.AWS_SECRET_ACCESS_KEY = "must-not-forward";
try {
  process.chdir(project);
  const code = await launchSandbox("srt", {
    agent: "claude",
    args: ["-p", "literal ' $(touch /tmp/nope)"],
    routing: {
      apiBaseUrl: "https://api.opper.ai",
      baseUrl: "https://api.opper.ai/v3/session/test",
      apiKey: "fake-key",
      model: "test",
      compatShape: "openai",
    },
    spawnOptions: {},
  });
  assert.equal(code, 0);
  assert.equal(readFileSync(sentinel, "utf8"), "unchanged");
  assert.equal(existsSync(readFileSync("home-path", "utf8")), false);
  console.log("Cleanup passed");
} finally {
  process.chdir(old);
  rmSync(root, { recursive: true, force: true });
}
