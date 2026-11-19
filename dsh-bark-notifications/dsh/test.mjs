import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notificationTitle,machineLabel,createHandler,apply,replyPreview,normalizeText,approvalNotification,resolveBarkConfig,barkPushUrl,normalizeBaseUrl,BARK_DEFAULTS,BARK_PUSH_URL,sendViaBarkPush,readKeychainKey,inspectBarkConfig,formatBarkConfig,composeTitle,resolveDeviceName,MAX_DEVICE_NAME_CHARS,goalKeepsSessionRunning,hasQueuedTurn,notificationShouldWait,createStopNotifier } from './index.mjs';
test('dedup, subagent exclusion, failure containment, no content access', async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-bark-test-')); let calls=0;const records=[];
 try {
  const send=async()=>{calls++;return {status:'accepted',http_status:200}};
  const notification=async()=>({session_title:'test title',reply_preview:'done'});
  const make=()=>createHandler({stateDir:root,send,getNotification:notification,diagnostic:async r=>records.push(r)});
  const agent={session:{header:{id:'test'},get events(){throw Error('must not read')}}};
  await Promise.all([make()({agent,turn:1}),make()({agent,turn:1})]);assert.equal(calls,1);
  await make()({agent,turn:1});assert.equal(calls,1);
  await make()({agent:{session:{header:{id:'child',origin:'subagent'}}},turn:1});assert.equal(calls,1);
   await make()({agent:{session:{header:{id:'resident',parentSession:'p1'}}},turn:1});assert.equal(calls,1);
  await make()({agent,turn:2});assert.equal(calls,2);
  await createHandler({stateDir:root,send,getNotification:notification,enabled:false})({agent,turn:3});assert.equal(calls,2);
  await createHandler({stateDir:root,getNotification:notification,send:async()=>{throw Error('secret')}})({agent,turn:4});
  await make()({agent,turn:4});assert.equal(calls,2);
  assert.equal(JSON.stringify(records).includes('test'),false);
 }finally{await rm(root,{recursive:true,force:true})}
});
test('registers turn-stopping and approval/request listeners without calling senders',()=>{
 const events=[];
 apply({on:(e,h)=>{events.push(e);assert.equal(typeof h,'function')},logger:{info(){}},sessionTitle:{get(){}}});
 assert.ok(events.includes('agent/turn-stopping'));
 assert.ok(events.includes('agent/status'));
 assert.ok(events.includes('goal/changed'));
 assert.ok(events.includes('session/event'));
 if (process.platform==='darwin') assert.ok(events.includes('approval/request')); // macOS-only approval listener
});

test('approval notification folding and passthrough',()=>{
 const n=approvalNotification({tool:'bash',reason:'  multi\nline   reason  '},{machine_label:'CZM-Mac'});
 assert.equal(n.title,'等待审批'); // the device name is appended by composeTitle at send time
 assert.equal(n.body,'bash：multi line reason');
 assert.equal(n.group,'dsh-approval');
 assert.equal(n.level,'timeSensitive');
 const minimal=approvalNotification({}, {});
 assert.equal(minimal.body,'工具 tool 正在等待你的批准');
 const long=approvalNotification({tool:'t',reason:'字'.repeat(200)},{});
 assert.equal(Array.from(long.body).length,162); // tool + '：' + 160 chars
});

test('Mac-compatible title and 30-character reply formatting',()=>{
 assert.equal(replyPreview({content:[{type:'thinking',text:'private'},{type:'text',text:'测试完成'}]}),'测试完成');
 assert.equal(replyPreview({content:[{type:'text',text:'你'.repeat(31)}]}),'你'.repeat(30)+'…');
 assert.equal(replyPreview({content:[{type:'text',text:'😀'.repeat(31)}]}),'😀'.repeat(30)+'…');
 assert.equal(normalizeText(' title\n   text ',120),'title text');
});
test('Windows sender input preserves Chinese JSON', {skip:process.platform!=='win32'}, async()=>{
 const {spawnSync}=await import('node:child_process');
 const {readFileSync}=await import('node:fs');
 const script=readFileSync(new URL('./send.ps1',import.meta.url),'utf8');
 const encoding=script.split(/\r?\n/).find(l=>l.startsWith('[Console]::InputEncoding'));
 assert.ok(encoding);
 const ps=`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;${encoding};$n=[Console]::In.ReadToEnd()|ConvertFrom-Json;[Console]::Write($n.session_title)`;
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{input:JSON.stringify({session_title:'中文通知测试'}),encoding:'utf8',timeout:10000});
 assert.equal(r.status,0);assert.equal(r.stdout,'中文通知测试');
});

// --- Configurable base URL / keychain entry (defaults must stay byte-identical) ---
const withFetch = async (fn) => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(typeof url === 'string' ? url : url?.url ?? url), init });
    return { ok: true, status: 200 };
  };
  try { await fn(calls); } finally { globalThis.fetch = original; }
};
test('default config resolves to the historical values',()=>{
  const value=resolveBarkConfig({},{});
  assert.deepEqual({...value},{baseUrl:'https://api.day.app',baseUrlSource:'default',keychainService:'codex-bark-notifications',keychainServiceSource:'default',keychainAccount:'codex',keychainAccountSource:'default'});
  assert.equal(barkPushUrl(),'https://api.day.app/push');
  assert.equal(BARK_PUSH_URL,'https://api.day.app/push');
  assert.deepEqual({...BARK_DEFAULTS},{baseUrl:'https://api.day.app',keychainService:'codex-bark-notifications',keychainAccount:'codex'});
});
test('unconfigured push still goes to https://api.day.app/push with no bark override',async()=>{
  const key=await readKeychainKey();
  if(!key) return; // no local credential: the request path cannot be exercised
  await withFetch(async calls=>{
    const r=await sendViaBarkPush({title:'t',body:'b',sound:'bell'});
    assert.equal(r.status,'accepted');assert.equal(r.http_status,200);
    assert.equal(calls.length,1);
    assert.equal(calls[0].url,'https://api.day.app/push');
    assert.equal(calls[0].init.method,'POST');
    assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body)),['device_key','title','body','group','level','sound']);
  });
});
test('configured base URL joins /push without double slashes',async()=>{
  for(const [input,expected] of [
    ['http://placeholder.example.com:30137','http://placeholder.example.com:30137/push'],
    ['http://placeholder.example.com:30137/','http://placeholder.example.com:30137/push'],
    ['http://placeholder.example.com:30137//','http://placeholder.example.com:30137/push'],
    ['http://placeholder.example.com:30137/push','http://placeholder.example.com:30137/push'],
    ['  http://placeholder.example.com:30137/  ','http://placeholder.example.com:30137/push'],
    ['https://bark.example.com/bark/','https://bark.example.com/bark/push'],
  ]) assert.equal(barkPushUrl(input),expected,input);
  assert.throws(()=>barkPushUrl('nonsense'),TypeError);
});
test('configured base URL is used by the sender',async()=>{
  if(!await readKeychainKey()) return;
  await withFetch(async calls=>{
    await sendViaBarkPush({title:'t',body:'b',bark:{baseUrl:'http://placeholder.example.com:30137'}});
    assert.equal(calls[0].url,'http://placeholder.example.com:30137/push');
  });
});
test('self-hosted 400 "failed to get device token" counts as queued, official 400 stays a failure',async()=>{
  if(!await readKeychainKey()) return;
  const mock=status=>({ok:false,status,text:async()=>'{"code":400,"message":"failed to get device token: device token invalid"}'});
  const orig=globalThis.fetch;
  try{
    globalThis.fetch=async()=>mock(400);
    const selfHosted=await sendViaBarkPush({title:'t',body:'b',bark:{baseUrl:'http://placeholder.example.com:30137'}});
    assert.equal(selfHosted.status,'accepted');assert.equal(selfHosted.http_status,400);
    const official=await sendViaBarkPush({title:'t',body:'b'});
    assert.equal(official.status,'send_failed');assert.equal(official.http_status,400);
    globalThis.fetch=async()=>({ok:false,status:400,text:async()=>'{"code":400,"message":"bad request"}'});
    const other=await sendViaBarkPush({title:'t',body:'b',bark:{baseUrl:'http://placeholder.example.com:30137'}});
    assert.equal(other.status,'send_failed');
  }finally{globalThis.fetch=orig}
});
test('invalid base URLs are rejected and never silently sent elsewhere',()=>{
  for(const bad of ['', '   ', 'ftp://host', 'javascript:alert(1)', 'http://user:pw@host:1', 'http://host:1/push?x=1', 'not a url']) assert.equal(normalizeBaseUrl(bad),null,String(bad));
  assert.throws(()=>barkPushUrl('ftp://host'),TypeError);
  // invalid config falls through to the next source, eventually the default
  assert.equal(resolveBarkConfig({bark:{baseUrl:'ftp://bad'}},{}).baseUrlSource,'default');
  assert.equal(resolveBarkConfig({bark:{baseUrl:'ftp://bad'}},{bark_base_url:'http://placeholder.example.com:30137'}).baseUrl,'http://placeholder.example.com:30137');
});
test('configuration priority: plugin config > settings.json > default',()=>{
  const C={bark:{baseUrl:'http://cfg:1',keychainService:'svc-cfg',keychainAccount:'acct-cfg'}};
  const L={bark_base_url:'http://local:2',bark_keychain_service:'svc-local',bark_keychain_account:'acct-local'};
  const both=resolveBarkConfig(C,L);
  assert.equal(both.baseUrl,'http://cfg:1');assert.equal(both.baseUrlSource,'config');
  assert.equal(both.keychainService,'svc-cfg');assert.equal(both.keychainAccount,'acct-cfg');
  const localOnly=resolveBarkConfig({},L);
  assert.equal(localOnly.baseUrl,'http://local:2');assert.equal(localOnly.baseUrlSource,'settings');
  assert.equal(localOnly.keychainService,'svc-local');assert.equal(localOnly.keychainAccount,'acct-local');
  const partial=resolveBarkConfig({bark:{baseUrl:'http://cfg:1'}},L);
  assert.equal(partial.baseUrl,'http://cfg:1');assert.equal(partial.keychainService,'svc-local');
  // top-level config keys are still accepted, nested bark.* wins
  assert.equal(resolveBarkConfig({baseUrl:'http://top:3'},{}).baseUrl,'http://top:3');
  assert.equal(resolveBarkConfig({baseUrl:'http://top:3',bark:{baseUrl:'http://nested:4'}},{}).baseUrl,'http://nested:4');
});
test('inspect config is redacted and reports the source',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-bark-inspect-'));
  try{
    const d=await inspectBarkConfig({config:{},root});
    assert.equal(d.pushUrl,'https://api.day.app/push');assert.equal(d.baseUrlSource,'default');
    const text=formatBarkConfig(d);
    assert.match(text,/https:\/\/api\.day\.app\/push/);assert.match(text,/\(default\)/);
    const realKey=await readKeychainKey();
    if(realKey) assert.equal(text.includes(realKey),false);
    await import('node:fs/promises').then(fs=>fs.writeFile(join(root,'settings.json'),JSON.stringify({bark_base_url:'http://placeholder.example.com:30137/'})));
    const d2=await inspectBarkConfig({config:{},root});
    assert.equal(d2.pushUrl,'http://placeholder.example.com:30137/push');assert.equal(d2.baseUrlSource,'settings');
    const d3=await inspectBarkConfig({config:{bark:{baseUrl:'http://cfg:1'}},root});
    assert.equal(d3.pushUrl,'http://cfg:1/push');assert.equal(d3.baseUrlSource,'config');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('all machine labels keep title first with the same full-width pipe',()=>{
 for(const label of ['Office PC','开发电脑','工作站 😀','Long machine label']){
  const machine=machineLabel({machine_label:label});
  assert.equal(notificationTitle('任务完成',machine),`任务完成｜${machine}`);
  assert.equal(composeTitle(approvalNotification({tool:'test'},{machine_label:label}).title,machine),`等待审批｜${machine}`);
 }
 assert.equal(notificationTitle('任务完成',machineLabel({})).startsWith('任务完成｜'),true);
});
test('Windows sender uses title then full-width pipe without depending on script encoding',async()=>{
 const {readFileSync}=await import('node:fs');
 const script=readFileSync(new URL('./send.ps1',import.meta.url),'utf8');
 assert.ok(script.includes("[string][char]0xFF5C")); // pipe built from its code point, independent of script encoding
 assert.match(script,/-like \('\*' \+ \$pipe \+ '\*'\)/); // a title that already has the pipe is left alone
});

// --- Device name is configuration, never a caller argument ---
test('device name comes from config, then settings, then the machine-name fallback',()=>{
 assert.deepEqual(resolveDeviceName({bark:{deviceName:'MacBook'}},{bark_device_name:'Other',machine_label:'CZM-Mac'}),{value:'MacBook',source:'config'});
 assert.deepEqual(resolveDeviceName({deviceName:'HOMEPC'},{}),{value:'HOMEPC',source:'config'}); // top-level key accepted too
 assert.deepEqual(resolveDeviceName({}, {bark_device_name:'HOMEPC',machine_label:'CZM-Mac'}),{value:'HOMEPC',source:'settings'});
 assert.deepEqual(resolveDeviceName({}, {machine_label:'CZM-Mac'}),{value:'CZM-Mac',source:'settings'});
 const fallback=resolveDeviceName({},{});
 assert.equal(fallback.source,'default');
 assert.ok(fallback.value.length>0); // hostname: a missing config never blocks sending
 assert.equal(resolveDeviceName({bark:{deviceName:'  \n  '}},{machine_label:'CZM-Mac'}).value,'CZM-Mac'); // blank config falls through
});

test('title is composed once: bare title gets the device, an existing pipe is never doubled',()=>{
 assert.equal(composeTitle('构建完成','MacBook'),'构建完成｜MacBook');
 assert.equal(composeTitle('构建完成｜MacBook','MacBook'),'构建完成｜MacBook');
 assert.equal(composeTitle('构建完成｜旧设备','MacBook'),'构建完成｜旧设备');
 // the phone reads at most 60 characters of title + separator + device name together
 assert.ok(Array.from('构建完成｜MacBook').length<=60);
 assert.equal(MAX_DEVICE_NAME_CHARS,6);
});

test('sender appends the configured device name to the title it posts',async()=>{
 if(!await readKeychainKey()) return;
 // `bark` here is a local placeholder, not a real service URL: the request is mocked, never sent.
 const bark={baseUrl:'https://PLACEHOLDER.example.com'};
 await withFetch(async calls=>{
  await sendViaBarkPush({title:'构建完成',body:'',deviceName:'MacBook',bark});
  await sendViaBarkPush({title:'构建完成｜MacBook',body:'',deviceName:'MacBook',bark});
  await sendViaBarkPush({title:'构建完成',body:''});
  assert.equal(JSON.parse(calls[0].init.body).title,'构建完成｜MacBook');
  assert.equal(JSON.parse(calls[1].init.body).title,'构建完成｜MacBook');
  assert.equal(JSON.parse(calls[2].init.body).title,`构建完成｜${machineLabel({})}`); // no device: hostname fallback
  assert.equal(JSON.parse(calls[0].init.body).body,'任务完成'); // empty body falls back to a short placeholder
 });
});

// --- Goal-mode continuation gating ---
test('only an armed active goal with rounds left keeps the session running',()=>{
 const goal={phase:'active',activation:'armed',roundsStarted:2,maxGoalRounds:5};
 assert.equal(goalKeepsSessionRunning(goal),true);
 assert.equal(goalKeepsSessionRunning({...goal,roundsStarted:5}),false); // round budget exhausted
 assert.equal(goalKeepsSessionRunning({...goal,roundsStarted:6}),false);
 for(const phase of ['paused','blocked','complete']) assert.equal(goalKeepsSessionRunning({...goal,phase}),false,phase);
 assert.equal(goalKeepsSessionRunning({...goal,activation:'disarmed'}),false);
 assert.equal(goalKeepsSessionRunning(undefined),false);
 assert.equal(goalKeepsSessionRunning({phase:'active',activation:'armed'}),false); // unknown counters fail open
});

test('queued turns are a non-stopping point; unknown goal state never silences',()=>{
 const agent={session:{header:{id:'queue-session'}},inbox:{nextTurn:[]}};
 assert.equal(hasQueuedTurn(agent),false);
 assert.equal(notificationShouldWait(agent,undefined),false);
 agent.inbox.nextTurn.push({id:'human'});
 assert.equal(notificationShouldWait(agent,undefined),true);
 agent.inbox.nextTurn.length=0;
 const goals={get:()=>({phase:'active',activation:'armed',roundsStarted:1,maxGoalRounds:2})};
 assert.equal(notificationShouldWait(agent,goals),true);
 goals.get=()=>{throw Error('goal service unavailable')};
 assert.equal(notificationShouldWait(agent,goals),false);
 assert.equal(hasQueuedTurn({}),false);
});

test('goal rounds defer the notification until the session really stops',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-bark-goal-'));
 let calls=0; const sent=[];
 const agent={session:{header:{id:'goal-session'}},status:'idle',inbox:{nextTurn:[]}};
 let goal={phase:'active',activation:'armed',roundsStarted:1,maxGoalRounds:3};
 const goals={get:a=>a===agent?goal:undefined};
 const shouldDefer=a=>notificationShouldWait(a,goals);
 const getNotification=async(agent,turn)=>({session_title:`title-${turn}`,reply_preview:`reply-${turn}`});
 const deliver=createHandler({stateDir:root,send:async n=>{calls++;sent.push(n);return {status:'accepted'}},getNotification,shouldDefer});
 const notifier=createStopNotifier({deliver,shouldDefer});
 try{
  assert.equal(await notifier.turnStopping({agent,turn:1}),'deferred');
  assert.equal(calls,0);
  notifier.turnStarted(agent.session); // the goal driver opened round 2
  assert.equal(await notifier.turnStopping({agent,turn:2}),'deferred');
  assert.equal(await notifier.idle(agent),'skipped'); // still armed: another round is coming
  assert.equal(calls,0);
  goal={...goal,phase:'complete',activation:'disarmed'}; // goal finished between rounds
  assert.equal(await notifier.goalChanged(agent),'delivered');
  assert.equal(calls,1);
  assert.equal(sent[0].reply_preview,'reply-2'); // latest held turn, not an old one
  assert.equal(await notifier.idle(agent),'skipped');
  assert.equal(calls,1);
  assert.equal(await notifier.turnStopping({agent,turn:3}),'delivered'); // final turn notifies immediately
  assert.equal(calls,2);
  goal={phase:'active',activation:'armed',roundsStarted:3,maxGoalRounds:3};
  assert.equal(await notifier.turnStopping({agent,turn:4}),'delivered'); // exhausted budget is terminal
  assert.equal(calls,3);
  goal={phase:'active',activation:'armed',roundsStarted:1,maxGoalRounds:5};
  assert.equal(await notifier.turnStopping({agent,turn:5}),'deferred');
  goal={...goal,activation:'disarmed'}; // max-tokens style disarm
  assert.equal(await notifier.idle(agent),'delivered');
  assert.equal(calls,4);
  goal={phase:'active',activation:'armed',roundsStarted:1,maxGoalRounds:5};
  assert.equal(await notifier.turnStopping({agent,turn:6}),'deferred');
  notifier.turnStarted(agent.session); // a new turn supersedes the held one
  goal={...goal,phase:'complete',activation:'disarmed'};
  assert.equal(await notifier.idle(agent),'skipped');
  assert.equal(calls,4);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('a queued human turn defers until the queue drains',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-bark-queue-'));
 let calls=0;
 const agent={session:{header:{id:'queued-session'}},status:'idle',inbox:{nextTurn:[{id:'human'}]}};
 const goal={phase:'complete',activation:'disarmed',roundsStarted:1,maxGoalRounds:2};
 const goals={get:()=>goal};
 const shouldDefer=a=>notificationShouldWait(a,goals);
 const deliver=createHandler({stateDir:root,send:async()=>{calls++;return {status:'accepted'}},getNotification:async()=>({session_title:'t',reply_preview:'r'}),shouldDefer});
 const notifier=createStopNotifier({deliver,shouldDefer});
 try{
  assert.equal(await notifier.turnStopping({agent,turn:1}),'deferred');
  assert.equal(calls,0);
  agent.inbox.nextTurn.length=0; // the queued turn ran and the queue is empty
  assert.equal(await notifier.idle(agent),'delivered');
  assert.equal(calls,1);
 }finally{await rm(root,{recursive:true,force:true})}
});
