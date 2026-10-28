import http from 'node:http';
import {prepareLogin, checkPendingLogin, verifyLogin} from './netease.mjs';
const port = 3118;
let state = {status: 'loading', generation: 0}, busy = false, stopped = false, refreshRequested = false, initialized = false;
const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>网易云后台登录</title><style>body{font:18px system-ui;max-width:640px;margin:45px auto;padding:0 20px;color:#20232b;background:#f6f8fb}main{background:white;padding:28px;border-radius:18px}img{width:280px;height:280px;max-width:100%}button{padding:10px 18px;font:inherit;border-radius:8px;border:1px solid #aaa}#status{font-weight:650;min-height:50px}.ok{color:#15803d}small{color:#64748b}</style><main><h1>网易云后台登录</h1><p>用网易云音乐 App 扫码，然后在手机上确认授权。</p><img id="qr" alt="正在准备二维码"><p id="status">正在准备…</p><button id="refresh">重新生成二维码</button><p><small>后台会自动接收并加密保存授权。以这里显示“登录成功”为准，无需抢时间告诉助手。只在本机运行，不接收账号密码。</small></p></main><script>const s=document.querySelector('#status'),q=document.querySelector('#qr'),b=document.querySelector('#refresh');let generation=-1;async function poll(){try{const r=await fetch('/api/state',{cache:'no-store'}),v=await r.json();if(v.image&&generation!==v.generation){q.src=v.image;generation=v.generation;}const messages={'loading':'正在准备二维码…','waiting':'等待扫码；二维码过期会自动更新','scanned':'已扫码，请在手机上点击确认授权','logged-in':'登录成功 ✓ 已在后台账户下加密保存','error':'连接暂时失败，后台正在重试','stopped':'登录窗口已超时，请让助手重新打开'};s.textContent=messages[v.status]||v.status;s.className=v.status==='logged-in'?'ok':'';b.disabled=['loading','logged-in'].includes(v.status);if(v.status==='logged-in'){q.style.display='none';return;}setTimeout(poll,1500);}catch{s.textContent='正在连接本机登录服务…';setTimeout(poll,2500);}}b.onclick=async()=>{b.disabled=true;await fetch('/api/refresh',{method:'POST',headers:{'content-type':'application/json','x-login-ui':'1'},body:'{}'});};poll();</script>`;
async function renew() {
  state = {...state, status: 'loading'};
  const r = await prepareLogin();
  state = {status: 'waiting', generation: state.generation + 1, image: r.image};
}
async function tick() {
  if (busy || stopped || state.status === 'logged-in') return;
  busy = true;
  try {
    if (!initialized) {
      initialized = true;
      try {if ((await verifyLogin()).loggedIn) {state = {status: 'logged-in', generation: 0}; console.log(JSON.stringify({alreadyLoggedIn: true, protectedCredentialVerified: true})); return;}} catch {}
    }
    if (state.status === 'loading' || !state.image) await renew();
    else {
      const r = await checkPendingLogin();
      if (r.loggedIn) {state = {status: 'logged-in', generation: state.generation}; console.log(JSON.stringify({loggedIn: true, protectedCredentialVerified: true}));}
      else if (r.status === 'expired') await renew();
      else state = {...state, status: r.status};
    }
  } catch {state = {...state, status: 'error'};}
  finally {busy = false; if (refreshRequested && !stopped && state.status !== 'logged-in') {refreshRequested = false; state = {...state, status: 'loading'}; void tick();}}
}
const server = http.createServer((req, res) => {
  const host = req.headers.host;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) {res.writeHead(403); res.end(); return;}
  const headers = {'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'"};
  const pathname = new URL(req.url, `http://${host}`).pathname;
  // Chat autolinks sometimes append Chinese punctuation/text to the URL.
  if (req.method === 'GET' && pathname.startsWith('/login') && pathname !== '/login') {res.writeHead(302, {...headers, location: '/login'}); res.end(); return;}
  if (req.method === 'GET' && ['/', '/login'].includes(pathname)) {res.writeHead(200, {...headers, 'content-type': 'text/html; charset=utf-8'}); res.end(page); return;}
  if (req.method === 'GET' && req.url === '/api/state') {res.writeHead(200, {...headers, 'content-type': 'application/json'}); res.end(JSON.stringify(state)); return;}
  if (req.method === 'POST' && req.url === '/api/refresh') {
    if (req.headers.origin !== `http://${host}` || req.headers['x-login-ui'] !== '1') {res.writeHead(403); res.end(); return;}
    if (state.status === 'logged-in') {res.writeHead(409); res.end(); return;}
    if (busy) refreshRequested = true; else {state = {...state, status: 'loading'}; void tick();}
    res.writeHead(202, headers); res.end(); return;
  }
  res.writeHead(404); res.end();
});
server.listen(port, '127.0.0.1', () => {console.log('Live NetEase login: http://127.0.0.1:3118/login'); void tick();});
const interval = setInterval(tick, 3000);
setTimeout(() => {stopped = true; state = {...state, status: 'stopped'}; clearInterval(interval); server.close(); server.closeAllConnections();}, 1200000).unref();
