import { spawn } from 'node:child_process';
import { mkdir, open, appendFile, stat, rename, readdir, unlink, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
export const name = 'bark-notifications';
export const inject = ['agents', 'sessionTitle'];
const here = dirname(fileURLToPath(import.meta.url));
/** Child sessions (subagent tool children and resident continuable children) never notify; only top-level user sessions do. */
export function isChildSession(header) {
  return !!header && (header.origin === 'subagent' || header.parentSession != null);
}
/**
 * Whether an active, armed goal will start another round by itself. A goal that
 * is complete/paused/blocked, disarmed, or has used up its round budget is a
 * real stopping point, so the notification must go out.
 */
export function goalKeepsSessionRunning(goal) {
  return !!goal && goal.phase === 'active' && goal.activation === 'armed'
    && Number.isInteger(goal.roundsStarted) && Number.isInteger(goal.maxGoalRounds)
    && goal.roundsStarted < goal.maxGoalRounds;
}
/** A queued human turn continues the driver loop without ever reporting idle. */
export function hasQueuedTurn(agent) {
  try { return (agent?.inbox?.nextTurn?.length ?? 0) > 0; } catch { return false; }
}
/** True when this turn is not the session's stopping point and must not notify yet. */
export function notificationShouldWait(agent, goals) {
  try { if (goalKeepsSessionRunning(goals?.get(agent))) return true; } catch { /* unknown goal state must not silence notifications */ }
  return hasQueuedTurn(agent);
}
export function createHandler({ stateDir, send, diagnostic = async () => {}, enabled = true, getNotification = async () => null, shouldDefer = () => false }) {
  return async ({ agent, turn }) => {
    try {
      const h = agent?.session?.header;
      if (!enabled || !h?.id || isChildSession(h) || !Number.isInteger(turn) || turn < 0) return 'skipped';
      const notification = await getNotification(agent, turn);
      if (!notification?.session_title || !notification?.reply_preview) return 'skipped';
      let deferred = false;
      try { deferred = shouldDefer(agent, turn) === true; } catch { /* a broken predicate must not silence notifications */ }
      if (deferred) return 'deferred';
      const hash = createHash('sha256').update(JSON.stringify([h.id, turn])).digest('hex');
      await mkdir(stateDir, { recursive: true });
      try { const f = await open(join(stateDir, hash), 'wx'); await f.close(); }
      catch (e) { if(e.code === 'EEXIST') return 'duplicate'; throw e; }
      let result;
      try { result = await send(notification); } catch { result = { status: 'send_failed' }; }
      await diagnostic({ time: new Date().toISOString(), event: hash, status: result.status, http_status: result.http_status });
      const files = await readdir(stateDir);
      if (files.length > 2000) {
        const entries = await Promise.all(files.map(async name => ({ name, time: (await stat(join(stateDir,name))).mtimeMs })));
        entries.sort((a,b) => b.time-a.time);
        await Promise.all(entries.slice(1500).map(e => unlink(join(stateDir,e.name))));
      }
      return 'delivered';
    } catch { /* Never interfere with the agent or retry a failed notification. */ return 'error'; }
  };
}
/**
 * Bridge turn-stopping hooks to a single "the session really stopped" delivery:
 * a turn that an active goal or a queued turn will continue is held, and the
 * most recent held turn is released once the goal finishes, is paused/blocked,
 * is disarmed, or the agent otherwise becomes idle for good.
 */
export function createStopNotifier({ deliver, shouldDefer }) {
  const pending = new WeakMap();
  const flushing = new WeakSet();
  const defer = agent => {
    try { return shouldDefer(agent) === true; } catch { return false; /* never silence on a broken predicate */ }
  };
  const flush = async agent => {
    const record = pending.get(agent?.session);
    if (!record || record.agent !== agent || agent.status !== 'idle' || flushing.has(agent)) return 'skipped';
    if (defer(agent)) return 'skipped';
    flushing.add(agent);
    try {
      const outcome = await deliver({ agent, turn: record.turn });
      if (outcome !== 'deferred' && pending.get(agent.session) === record) pending.delete(agent.session);
      return outcome;
    } finally { flushing.delete(agent); }
  };
  return {
    async turnStopping(event) {
      // A newer turn supersedes any held earlier turn even if its turn/start
      // notification was missed during plugin (re)load.
      if (event?.agent?.session) pending.delete(event.agent.session);
      const outcome = await deliver(event);
      if (outcome === 'deferred' && event?.agent?.session) pending.set(event.agent.session, { agent: event.agent, turn: event.turn });
      return outcome;
    },
    async idle(agent) { return flush(agent); },
    async goalChanged(agent) { return flush(agent); },
    turnStarted(session) { pending.delete(session); },
  };
}
export function sendViaPowerShell(notification) {
  return new Promise(resolve => {
    const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-File', join(here, 'send.ps1')], { windowsHide: true, stdio: ['pipe','pipe','ignore'], timeout: 12000 });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(notification));
    let output = ''; child.stdout.on('data', b => { if(output.length < 2048) output += b.toString(); });
    child.on('error', () => resolve({status:'sender_unavailable'}));
    child.on('close', () => {
      try { const v=JSON.parse(output.trim()); resolve({status:['accepted','send_failed','credential_unavailable'].includes(v.status)?v.status:'send_failed',http_status:Number.isInteger(v.http_status)?v.http_status:undefined}); }
      catch { resolve({status:'send_failed'}); }
    });
  });
}
export function normalizeText(raw, max) {
  if (typeof raw !== 'string') return '';
  return Array.from(raw.replace(/\p{C}/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0,max).join('');
}
export function replyPreview(message) {
  const text=(Array.isArray(message?.content)?message.content:[])
    .filter(b=>b.type==='text' && typeof b.text==='string').map(b=>b.text).join('');
  const safe=normalizeText(text,31);
  const chars=Array.from(safe);
  return chars.slice(0,30).join('')+(chars.length>30?'…':'');
}
// --- macOS (Bark over HTTPS POST; the device key never leaves this machine's keychain) ---
export const KEYCHAIN_SERVICE = 'codex-bark-notifications';
export const KEYCHAIN_ACCOUNT = 'codex';
export const BARK_BASE_URL = 'https://api.day.app';
export const BARK_PUSH_URL = `${BARK_BASE_URL}/push`;
export const BARK_DEFAULTS = Object.freeze({ baseUrl: BARK_BASE_URL, keychainService: KEYCHAIN_SERVICE, keychainAccount: KEYCHAIN_ACCOUNT });
const SERVICE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const ACCOUNT_PATTERN = /^[^\/\\\p{C}]{1,128}$/u;
/** Accept only a clean http(s) origin (+ optional path prefix); anything else is unusable config. */
export function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '' || /\s/.test(value)) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') return null;
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path.toLowerCase().endsWith('/push')) path = path.slice(0, -5).replace(/\/+$/, '');
  return parsed.origin + path;
}
/** Join /push onto a base URL without ever producing `//push` or `/push/push`. */
export function barkPushUrl(baseUrl = BARK_BASE_URL) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new TypeError('invalid Bark base URL');
  return `${base}/push`;
}
function pickRaw(config, local) {
  const plugin = config?.bark && typeof config.bark === 'object' ? config.bark : {};
  const localCfg = local && typeof local === 'object' ? local : {};
  return {
    baseUrl: [plugin.baseUrl ?? config?.baseUrl, localCfg.bark_base_url ?? localCfg.baseUrl],
    keychainService: [plugin.keychainService ?? config?.keychainService, localCfg.bark_keychain_service ?? localCfg.keychainService],
    keychainAccount: [plugin.keychainAccount ?? config?.keychainAccount, localCfg.bark_keychain_account ?? localCfg.keychainAccount],
  };
}
/** Priority: DSH plugin config > local settings.json > built-in default. Invalid values fall through to the next source. */
export function resolveBarkConfig(config = {}, local = {}) {
  const raw = pickRaw(config, local);
  const baseUrl = (normalizeBaseUrl(raw.baseUrl[0]) && { value: normalizeBaseUrl(raw.baseUrl[0]), source: 'config' })
    || (normalizeBaseUrl(raw.baseUrl[1]) && { value: normalizeBaseUrl(raw.baseUrl[1]), source: 'settings' })
    || { value: BARK_DEFAULTS.baseUrl, source: 'default' };
  const pick = (name, pattern) => {
    const [fromConfig, fromSettings] = raw[name];
    if (typeof fromConfig === 'string' && pattern.test(fromConfig.trim())) return { value: fromConfig.trim(), source: 'config' };
    if (typeof fromSettings === 'string' && pattern.test(fromSettings.trim())) return { value: fromSettings.trim(), source: 'settings' };
    return { value: BARK_DEFAULTS[name], source: 'default' };
  };
  const service = pick('keychainService', SERVICE_PATTERN);
  const account = pick('keychainAccount', ACCOUNT_PATTERN);
  return { baseUrl: baseUrl.value, baseUrlSource: baseUrl.source, keychainService: service.value, keychainServiceSource: service.source, keychainAccount: account.value, keychainAccountSource: account.source };
}
export function macStateRoot() { return join(homedir(), 'Library', 'Application Support', 'DSHBark'); }
export function stateRoot() {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA, 'DSHBark');
  if (process.platform === 'darwin') return macStateRoot();
  return join(homedir(), '.local', 'state', 'DSHBark');
}
/** Read the Bark device key from the login keychain. Resolves null when absent; the value is never logged. */
export function readKeychainKey(service = KEYCHAIN_SERVICE, account = KEYCHAIN_ACCOUNT) {
  return new Promise(resolve => {
    const child = spawn('security', ['find-generic-password', '-s', service, '-a', account, '-w'], { stdio: ['ignore','pipe','ignore'] });
    let out = '';
    child.stdout.on('data', b => { if (out.length < 4096) out += b.toString('utf8'); });
    child.on('error', () => resolve(null));
    child.on('close', code => {
      const key = out.replace(/\r?\n$/, '');
      resolve(code === 0 && key !== '' ? key : null);
    });
  });
}
async function bodyMentionsDeviceToken(res) {
  try { return /device token/i.test(await res.text()); } catch { return false; }
}
/**
 * POST one Bark push. Resolves {status, http_status?}; never rejects, never exposes the key.
 * With no bark overrides the request is byte-for-byte the historical one (BARK_PUSH_URL + default keychain entry).
 * Callers pass only the title; the device name from configuration is appended here.
 */
export async function sendViaBarkPush({ title, body, sound, group = 'dsh', level = 'active', url, bark, deviceName }) {
  let target;
  try {
    target = bark ? resolveBarkConfig({}, bark) : BARK_DEFAULTS;
    const pushUrl = normalizeBaseUrl(target.baseUrl) === BARK_BASE_URL ? BARK_PUSH_URL : barkPushUrl(target.baseUrl);
    const device_key = await readKeychainKey(target.keychainService, target.keychainAccount);
    if (!device_key) return { status: 'credential_unavailable' };
    // The phone only reads the title, but iOS/Bark shows an empty body poorly; keep a flat placeholder.
    const bodyText = typeof body === 'string' && body.trim() !== '' ? body : DEFAULT_BODY;
    const payload = { device_key, title: composeTitle(title, normalizeText(deviceName, MAX_DEVICE_NAME_INPUT_CHARS) || machineLabel({})), body: bodyText, group, level };
    if (sound) payload.sound = sound;
    if (url) payload.url = url;
    const res = await fetch(pushUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    // A self-hosted server answers 400 "failed to get device token" when APNs delivery failed but the
    // message was already queued for offline polling: the request itself succeeded, so it must not
    // poison the dedupe record (the notification would otherwise be lost for that turn).
    const queuedOffline = target?.baseUrl !== BARK_BASE_URL && res.status === 400 && await bodyMentionsDeviceToken(res);
    return { status: res.ok || queuedOffline ? 'accepted' : 'send_failed', http_status: res.status };
  } catch { return { status: 'send_failed' }; }
}
/** Fire-and-forget macOS desktop notification. Failures are swallowed. */
export function notifyDesktop(title, body, sound = 'Glass') {
  try {
    if (process.platform !== 'darwin') return;
    const esc = s => String(s).replaceAll('\\','\\\\').replaceAll('"','\\"');
    spawn('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "${esc(sound)}"`],
      { stdio: 'ignore', detached: true }).unref();
  } catch { /* desktop notification is best-effort */ }
}
export async function readLocalSettings(root) {
  try { const v = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
export const TITLE_SEPARATOR = '｜';
export const DEFAULT_BODY = '任务完成';
/** The phone reads at most 60 characters before replacing the separator, so a long device name is cut off with it. */
export const MAX_DEVICE_NAME_CHARS = 6;
export const MAX_DEVICE_NAME_INPUT_CHARS = 24;
export function notificationTitle(title, machine) {
  return `${title}｜${machine}`;
}
/**
 * Device name comes from configuration only (`deviceName` in the plugin config or settings.json),
 * never from a caller argument. The plugin config is explicit and local to this computer, so a
 * normalized settings.json value is preferred over it; anything missing or invalid falls back to hostname.
 */
export function resolveDeviceName(config = {}, local = {}) {
  const plugin = config?.bark && typeof config.bark === 'object' ? config.bark : {};
  const configured = normalizeText(plugin.deviceName ?? config?.deviceName, MAX_DEVICE_NAME_INPUT_CHARS);
  if (configured !== '') return { value: configured, source: 'config' };
  const localDevice = normalizeText(local.bark_device_name, MAX_DEVICE_NAME_INPUT_CHARS);
  if (localDevice !== '') return { value: localDevice, source: 'settings' };
  return { value: machineLabel(local), source: local.machine_label ? 'settings' : 'default' };
}
/**
 * Final title as the phone sees it: `title｜device`. A title that already contains the separator is
 * sent as-is, so the device name is never appended twice; callers pass the bare title.
 */
export function composeTitle(title, deviceName) {
  const text = typeof title === 'string' ? title : '';
  if (text.includes(TITLE_SEPARATOR)) return text;
  return notificationTitle(text, deviceName);
}
export function machineLabel(local) {
  return normalizeText(local.machine_label || hostname(), 24).replace(/\[/g,'(').replace(/\]/g,')') || 'Mac';
}
export function validSound(local, fallback) {
  return typeof local.sound === 'string' && /^[^/\\\p{C}]{1,120}$/u.test(local.sound) ? local.sound.trim() : fallback;
}
/** Fold one approval/request into a notification payload (pure; unit-tested). */
export function approvalNotification(req, local = {}) {
  const tool = typeof req?.tool === 'string' && req.tool !== '' ? req.tool : 'tool';
  const raw = typeof req?.displayReason === 'string' && req.displayReason !== '' ? req.displayReason
    : typeof req?.reason === 'string' ? req.reason : '';
  const reason = normalizeText(raw, 160);
  return {
    title: '等待审批',
    body: reason === '' ? `工具 ${tool} 正在等待你的批准` : `${tool}：${reason}`,
    sound: validSound(local, 'bell'),
    group: 'dsh-approval',
    level: 'timeSensitive',
  };
}
/** Redacted view of the effective config: URL and source only, never the device key. */
export async function inspectBarkConfig({ config = {}, root = stateRoot() } = {}) {
  const local = await readLocalSettings(root);
  const resolved = resolveBarkConfig(config, local);
  const keychainKeyPresent = (await readKeychainKey(resolved.keychainService, resolved.keychainAccount)) !== null;
  const device = resolveDeviceName(config, local);
  return { ...resolved, pushUrl: barkPushUrl(resolved.baseUrl), keychainKeyPresent, deviceName: device.value, deviceNameSource: device.source, settingsFile: join(root, 'settings.json') };
}
export function formatBarkConfig(report) {
  return [
    `push url  : ${report.pushUrl}`,
    `base url  : ${report.baseUrl} (${report.baseUrlSource})`,
    `keychain  : service=${report.keychainService} (${report.keychainServiceSource}) account=${report.keychainAccount} (${report.keychainAccountSource})`,
    `device name: ${report.deviceName} (${report.deviceNameSource})`,
    `device key: ${report.keychainKeyPresent ? 'present in keychain' : 'missing'}`,
    `settings  : ${report.settingsFile}`,
  ].join('\n');
}
export function apply(ctx, config = {}) {
  const root = stateRoot();
  // Read the optional goal service per notification: plugin composition order
  // must not decide whether goal rounds can be detected.
  const shouldDefer = agent => {
    let goals;
    try { goals = typeof ctx.get === 'function' ? ctx.get('goals') : undefined; } catch { goals = undefined; }
    return notificationShouldWait(agent, goals);
  };
  /** Hold turn stopping until the goal/queued work stops continuing this session. */
  const registerStopNotifier = ({ send, getNotification, diagnostic }) => {
    const deliver = createHandler({stateDir:join(root,'dedup'),send,diagnostic,enabled:config.enabled!==false,getNotification,shouldDefer});
    const notifier = createStopNotifier({deliver,shouldDefer});
    ctx.on('agent/turn-stopping', event => { notifier.turnStopping(event).catch(() => {}); });
    ctx.on('agent/status', event => { if (event?.status === 'idle') notifier.idle(event.agent).catch(() => {}); });
    ctx.on('goal/changed', event => { notifier.goalChanged(event.agent).catch(() => {}); });
    ctx.on('session/event', (session,event) => { if (event.type === 'turn/start') notifier.turnStarted(session); });
    return notifier;
  };
  if (process.platform === 'win32') {
    const replies = new WeakMap();
    ctx.on('session/event', (session,event) => {
      if(isChildSession(session.header)) return;
      if(event.type==='turn/start') replies.delete(session);
      if(event.type==='assistant/message') {
        replies.set(session,{turn:event.data.turn,preview:replyPreview(event.data.message)});
      }
    });
    const getNotification = async (agent,turn) => {
      const reply = replies.get(agent.session);
      if(reply?.turn!==turn || !reply.preview) return null;
      const title=normalizeText(ctx.sessionTitle.get(agent.session)?.title,120);
      if(!title || ['本轮回复已结束','本轮会话已结束'].includes(title)) return null;
      let local={};
      try { local=JSON.parse(await readFile(join(root,'settings.json'),'utf8')); } catch {}
      const label=normalizeText(local.machine_label || process.env.COMPUTERNAME || 'Windows',24).replace(/\[/g,'(').replace(/\]/g,')');
      const sound=validSound(local,'bell_quiet');
      return {session_title:title,reply_preview:reply.preview,machine_label:label,sound};
    };
    const diagnostic = async record => {
      const path = join(root,'diagnostics.jsonl');
      try { if ((await stat(path)).size > 262144) await rename(path,path+'.previous'); } catch {}
      await appendFile(path,JSON.stringify(record)+'\n');
    };
    registerStopNotifier({send:sendViaPowerShell,getNotification,diagnostic});
    ctx.logger.info('Bark notification hook loaded (Windows)');
    return;
  }
  if (process.platform !== 'darwin') return;
  // --- macOS: turn-finished push + approval-waiting push & desktop notification ---
  const replies = new WeakMap();
  ctx.on('session/event', (session,event) => {
      if(isChildSession(session.header)) return;
    if(event.type==='turn/start') replies.delete(session);
    if(event.type==='assistant/message') replies.set(session,{turn:event.data.turn,preview:replyPreview(event.data.message)});
  });
  const diagnostic = async record => {
    const path = join(root,'diagnostics.jsonl');
    try { if ((await stat(path)).size > 262144) await rename(path,path+'.previous'); } catch {}
    await appendFile(path,JSON.stringify(record)+'\n');
  };
  const getNotification = async (agent,turn) => {
    const reply = replies.get(agent.session);
    if(reply?.turn!==turn || !reply.preview) return null;
    const title=normalizeText(ctx.sessionTitle.get(agent.session)?.title,120);
    if(!title || ['本轮回复已结束','本轮会话已结束'].includes(title)) return null;
    const local = await readLocalSettings(root);
    return {session_title:title,reply_preview:reply.preview,machine_label:machineLabel(local),sound:validSound(local,'bell_quiet')};
  };
  // Settings are re-read per push so a base URL / keychain / device-name change applies without restarting DSH.
  const push = async notification => {
    const local = await readLocalSettings(root);
    const device = resolveDeviceName(config, local);
    return sendViaBarkPush({
      title: notification.session_title,
      body: notification.reply_preview,
      sound: notification.sound,
      group: 'dsh',
      bark: resolveBarkConfig(config, local),
      deviceName: device.value,
    });
  };
  registerStopNotifier({send:push,getNotification,diagnostic});
  // Approval waiting: listen-only on the approval/request waterfall — notify, then pass through untouched.
  ctx.on('approval/request', (req, next) => {
    try {
      readLocalSettings(root).then(local => {
        if (local.desktop === false) return;
        const n = approvalNotification(req, local);
        const device = resolveDeviceName(config, local);
        notifyDesktop(composeTitle(n.title, device.value), n.body, 'Glass');
        return sendViaBarkPush({ ...n, bark: resolveBarkConfig(config, local), deviceName: device.value });
      }).catch(() => {});
      const result = next();
      if (result && typeof result.then === 'function') {
        result.then(outcome => ({ outcome }), () => ({ outcome: 'unavailable' })).then(({ outcome }) => readLocalSettings(root)).then(local => {
          if (local.notify_answered === false) return;
          const tool = typeof req?.tool === 'string' && req.tool !== '' ? req.tool : 'tool';
          const device = resolveDeviceName(config, local);
          notifyDesktop(composeTitle('审批已处理', device.value), `${tool} → ${String(outcome)}`, 'Pop');
        }).catch(() => {});
      }
    } catch { /* listening must never affect the approval flow */ }
    return next();
  });
  ctx.logger.info('Bark notification hook loaded (macOS)');
}
