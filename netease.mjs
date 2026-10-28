import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {songId} from './cover-core.mjs';
import {createHash} from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const auth = path.join(root, 'data', 'auth');
const cookieFile = path.join(auth, 'netease.dpapi');
let sdkPromise;
process.env.DOTENV_CONFIG_QUIET = 'true';
async function quietSdk(fn) {
  // Some upstream errors include response cookies. Do not let SDK diagnostics reach chat/logs.
  const methods = ['log', 'error', 'warn', 'info', 'debug'];
  const saved = methods.map(k => console[k]);
  methods.forEach(k => {console[k] = () => {};});
  try {return await fn();} finally {methods.forEach((k, i) => {console[k] = saved[i];});}
}
async function sdk() {
  fs.mkdirSync(path.join(root, 'data', 'runtime'), {recursive: true});
  // The SDK stores an anonymous token in os.tmpdir(); keep it separate from other apps.
  process.env.TEMP = process.env.TMP = path.join(root, 'data', 'runtime');
  sdkPromise ??= quietSdk(() => createRequire(import.meta.url)('@neteasecloudmusicapienhanced/api'));
  return sdkPromise;
}
function dpapi(action, input) {
  return new Promise((resolve, reject) => {
    // Use fixed PowerShell commands; no execution-policy change and no credential in argv.
    const prefix = "$ErrorActionPreference='Stop'; [Reflection.Assembly]::LoadWithPartialName('System.Security') > $null; $raw=[Console]::In.ReadToEnd(); ";
    const command = action === 'identity' ? "[Console]::Out.Write([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)" : prefix + (action === 'protect'
      ? "$b=[Text.Encoding]::UTF8.GetBytes($raw); $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p))"
      : "$b=[Convert]::FromBase64String($raw); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))");
    const child = spawn(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '', diagnostic = ''; const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.on('data', b => {out += b.toString();});
    child.stderr.on('data', b => {if (input === 'cover-worker-preflight') diagnostic = (diagnostic + b.toString()).slice(-2500);});
    child.on('error', e => {clearTimeout(timer); reject(e);});
    child.on('close', code => {clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(Error(`Windows credential protection failed${diagnostic ? ': ' + diagnostic : ''}`));});
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
async function credentialContext() {
  const sid = await dpapi('identity', '');
  const hash = createHash('sha256').update(sid).digest('hex');
  const configFile = path.join(root, 'config.local.json');
  const expected = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')).credentialOwnerSidHash : null;
  if (expected && expected !== hash) throw Error('Run NetEase login under the same Windows account as the DSH backend');
  return hash;
}
async function cookie() {
  if (!fs.existsSync(cookieFile)) throw Error('NetEase backend needs QR login first: node netease.mjs prepare-login');
  const hash = await credentialContext();
  const meta = path.join(auth, 'credential-context.json');
  if (fs.existsSync(meta) && JSON.parse(fs.readFileSync(meta, 'utf8')).sidHash !== hash) throw Error('Windows credential protection failed: account-context mismatch');
  return dpapi('unprotect', fs.readFileSync(cookieFile, 'utf8'));
}
async function call(method, args = {}, authenticated = true) {
  const api = await sdk();
  if (typeof api[method] !== 'function') throw Error(`NetEase SDK method is missing: ${method}`);
  let result;
  try {const argsWithAuth = {...args, timeout: 15000, ...(authenticated ? {cookie: await cookie()} : {})}; result = await quietSdk(() => api[method](argsWithAuth));}
  catch(e) {
    const status = Number(e?.status ?? e?.response?.status) || null;
    const code = Number(e?.body?.code) || (/^(ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNABORTED)$/.test(String(e?.code)) ? e.code : null);
    const detail = String(e?.body?.msg ?? e?.message ?? '');
    const category = detail.includes('credential protection failed') ? 'credential-storage' : /timeout|timed out/i.test(detail) ? 'timeout' : 'request';
    throw Error(`NetEase ${method} failed (category=${category}, http=${status ?? 'unknown'}, code=${code ?? 'unknown'}; credentials omitted)`);
  }
  const body = result?.body;
  if (result?.status >= 400 || !body || (body.code !== undefined && ![200, 800, 801, 802, 803].includes(body.code))) throw Error(`NetEase ${method} returned ${body?.code ?? result?.status ?? 'unknown status'}`);
  return body;
}
export async function searchSongs(keywords) {
  if (typeof keywords !== 'string' || !keywords.trim() || keywords.length > 160) throw Error('Use a short song title and artist');
  const b = await call('cloudsearch', {keywords, type: 1, limit: 5}, false);
  return (b.result?.songs ?? []).map(s => ({id: String(s.id), title: s.name, artists: (s.ar ?? []).map(a => a.name), seconds: Math.round(Number(s.dt) / 1000)}));
}
export async function verifyLogin() {
  const b = await call('login_status');
  return {ok: true, loggedIn: Boolean(b.data?.account?.id && b.data?.profile)};
}
export async function chorusStart(id) {
  try {
    const b = await call('song_chorus', {id: songId(id)}, false);
    const item = b.chorus?.[0];
    const milliseconds = Number(item?.startTime);
    return Number.isFinite(milliseconds) && milliseconds >= 0 ? {seconds: milliseconds / 1000} : null;
  } catch {return null;}
}
function trustedAudioUrl(raw) {
  const u = new URL(raw);
  if (u.username || u.password || !['http:', 'https:'].includes(u.protocol) || (u.port && !['80', '443'].includes(u.port)) || !(/(^|\.)music\.126\.net$/.test(u.hostname) || /(^|\.)music\.163\.com$/.test(u.hostname))) throw Error('Download API returned an unexpected audio host');
  // NetEase sometimes returns an http CDN link; use encrypted transport.
  u.protocol = 'https:'; u.port = ''; return u;
}
export async function downloadSong(id, output, signal, {quality='exhigh'}={}) {
  if(!['standard','exhigh','lossless'].includes(quality))throw Error('Unsupported download quality');
  const b = await call('song_download_url_v1', {id: songId(id), level: quality});
  const data = Array.isArray(b.data) ? b.data[0] : b.data;
  if (!data?.url || (Number(data.code) && Number(data.code) !== 200) || data.freeTrialInfo) throw Error('Song is unavailable for download with this account; no substitute source was used');
  if (fs.existsSync(output)) throw Error('Download output already exists');
  const abort = AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
  let url = trustedAudioUrl(data.url), response;
  for (let i = 0; i < 4; i++) {
    response = await fetch(url, {signal: abort, redirect: 'manual'});
    if (response.status >= 300 && response.status < 400) {const loc = response.headers.get('location'); await response.body?.cancel(); if (!loc) throw Error('Missing audio redirect'); url = trustedAudioUrl(new URL(loc, url).href); continue;}
    break;
  }
  if (!response?.ok || !response.body) {await response?.body?.cancel(); throw Error('Song audio download failed');}
  const limit = 150 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) {await response.body.cancel(); throw Error('Song exceeds download size limit');}
  let bytes = 0;
  const meter = new Transform({transform(chunk, encoding, cb) {bytes += chunk.length; cb(bytes > limit ? Error('Song exceeds download size limit') : null, chunk);}});
  await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(output, {flags: 'wx'}), {signal: abort});
  if (bytes < 128) throw Error('Downloaded song is empty');
  return output;
}

export async function prepareLogin() {
  await credentialContext();
  const protectedProbe = await dpapi('protect', 'cover-worker-preflight');
  if (await dpapi('unprotect', protectedProbe) !== 'cover-worker-preflight') throw Error('Credential storage preflight failed');
  fs.mkdirSync(auth, {recursive: true});
  const keyResult = await call('login_qr_key', {}, false);
  const key = keyResult.data?.unikey;
  if (!key) throw Error('NetEase did not provide a QR login key');
  const qr = await call('login_qr_create', {key, qrimg: true}, false);
  const image = qr.data?.qrimg;
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image ?? '')) throw Error('Invalid QR image');
  fs.writeFileSync(path.join(auth, 'pending.json'), JSON.stringify({key, createdAt: Date.now()}));
  fs.writeFileSync(path.join(auth, 'login.html'), `<!doctype html><meta charset="utf-8"><title>网易云后台下载登录</title><style>body{font:18px system-ui;max-width:650px;margin:45px auto;color:#222}img{width:280px;height:280px}</style><h1>网易云后台下载登录</h1><p>请使用你的网易云音乐 App 扫码并确认。此页面只显示二维码，不接收密码。</p><img src="${image}" alt="网易云登录二维码"><p>完成后告诉助手；过期时可重新生成。</p>`);
  return {ok: true, page: path.join(auth, 'login.html'), image};
}
export async function checkPendingLogin() {
  const sidHash = await credentialContext();
  // QR confirmation is one-shot: check protected storage before consuming the grant.
  await dpapi('protect', 'cover-worker-preflight');
  const pending = JSON.parse(fs.readFileSync(path.join(auth, 'pending.json'), 'utf8'));
  // A user may have confirmed shortly before the displayed QR expired.
  // Ask NetEase for the authoritative outcome instead of discarding that grant.
  if (Date.now() - pending.createdAt > 600000) throw Error('QR request is too old; generate another QR');
  const b = await call('login_qr_check', {key: pending.key}, false);
  if (b.code !== 803) return {ok: false, status: b.code === 800 ? 'expired' : b.code === 802 ? 'scanned' : 'waiting', code: b.code};
  if (typeof b.cookie !== 'string' || !b.cookie.includes('MUSIC_U=')) throw Error('Authorized QR did not include a login session');
  const protectedCookie = await dpapi('protect', b.cookie);
  fs.writeFileSync(cookieFile, protectedCookie, {mode: 0o600});
  fs.writeFileSync(path.join(auth, 'credential-context.json'), JSON.stringify({scope: 'CurrentUser', sidHash, savedAt: new Date().toISOString()}));
  // Confirm the saved value can actually be decrypted before reporting success.
  if (await cookie() !== b.cookie.trim()) throw Error('Saved credential verification failed');
  return {ok: true, loggedIn: true, status: 'logged-in'};
}
async function completeLogin() {
  const result = await checkPendingLogin();
  if (!result.loggedIn) throw Error(`QR is not confirmed yet (status ${result.code})`);
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'prepare-login') {const {image, ...value} = await prepareLogin(); console.log(JSON.stringify(value));}
    else if (process.argv[2] === 'complete-login') console.log(JSON.stringify(await completeLogin()));
    else if (process.argv[2] === 'auth-status') console.log(JSON.stringify(await verifyLogin()));
    else if (process.argv[2] === 'credential-selftest') {const p = await dpapi('protect', 'cover-worker-preflight'); if (await dpapi('unprotect', p) !== 'cover-worker-preflight') throw Error('Credential roundtrip failed'); console.log(JSON.stringify({ok: true, dpapiRoundtrip: true}));}
    else if (process.argv[2] === 'search') console.log(JSON.stringify(await searchSongs(process.argv.slice(3).join(' '))));
    else throw Error('Use prepare-login | complete-login | search <title artist>');
  } catch(e) {console.error(e.message); process.exitCode = 1;}
}
