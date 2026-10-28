import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {CONFIG_FILE,ROOT,loadConfig,settingsDocument,saveSettings,SettingsError} from './settings.mjs';
import {verifyLogin} from './netease.mjs';

const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);};
export function createUiServer({configFile=CONFIG_FILE,webRoot=path.join(ROOT,'web'),healthCheck}={}) {
  const sessions=new Map();const dataDir=path.join(path.dirname(configFile),'data');let lastHealth;
  async function checkHealth(){if(healthCheck)return healthCheck();const c=loadConfig(configFile),health=settingsDocument(configFile).health;
    try{const bridge=JSON.parse(fs.readFileSync(c.bridgeConfig,'utf8'));const r=await fetch(`${c.bridgeBase}/api/status`,{headers:{'x-console-token':bridge.consoleToken},signal:AbortSignal.timeout(5000)});const s=await r.json();health.bridge={ok:r.ok&&s.dshReady===true&&s.snowluma?.good===true};}catch{health.bridge={ok:false};}
    try{health.netease={configured:health.netease.configured,loggedIn:(await verifyLogin()).loggedIn};}catch{health.netease={configured:health.netease.configured,loggedIn:false};}
    lastHealth=health;return health;
  }
  const server=http.createServer(async(req,res)=>{
    const port=server.address()?.port;const host=req.headers.host;
    const security={'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",'referrer-policy':'no-referrer'};
    const send=(value,status=200)=>{res.writeHead(status,{...security,'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host)){send({error:{code:'host',message:'仅接受本机访问'}},403);return;}
    const origin=`http://${host}`;
    if((req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site'){send({error:{code:'origin',message:'请求来源不被允许'}},403);return;}
    let url;try{url=new URL(req.url,origin);}catch{send({error:{code:'url',message:'请求地址无效'}},400);return;}
    const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css'};
    if(req.method==='GET'&&files[url.pathname]){const file=path.join(webRoot,files[url.pathname]);if(!fs.existsSync(file)){send({error:{code:'not-ready',message:'界面文件未安装'}},503);return;}const type=file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html';res.writeHead(200,{...security,'content-type':`${type}; charset=utf-8`});fs.createReadStream(file).pipe(res);return;}
    if(req.method==='GET'&&url.pathname==='/api/ping'){send({service:'qq-bridge-cover-ui',version:'0.2.0'});return;}
    if(req.method==='GET'&&url.pathname==='/api/docs'){send({name:'QQ Bridge Cover API',version:1,session:'GET /api/session; use cookie and X-Cover-CSRF for subsequent calls',routes:['GET /api/bootstrap','PUT /api/settings {revision,settings}','POST /api/check','GET /api/jobs'],settingsApply:'next-task',pathsAndCredentials:'not exposed as editable API fields'});return;}
    const cookie=String(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('qq_cover_ui='))?.slice(12);
    let session=sessions.get(cookie);
    if(req.method==='GET'&&url.pathname==='/api/session'){
      if(!session||session.expires<Date.now()){const id=crypto.randomBytes(32).toString('hex');session={csrf:crypto.randomBytes(32).toString('hex'),expires:Date.now()+8*3600000};for(const[k,v]of sessions)if(v.expires<Date.now())sessions.delete(k);if(sessions.size>=64)sessions.delete(sessions.keys().next().value);sessions.set(id,session);res.setHeader('set-cookie',`qq_cover_ui=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);}
      send({csrfToken:session.csrf});return;
    }
    if(!session||session.expires<Date.now()||!equal(req.headers['x-cover-csrf'],session.csrf)){send({error:{code:'session',message:'管理会话失效，请重新加载页面'}},401);return;}
    try{
      if(req.method==='GET'&&url.pathname==='/api/bootstrap'){const d=settingsDocument(configFile);if(lastHealth)d.health=lastHealth;send(d);return;}
      if(req.method==='PUT'&&url.pathname==='/api/settings'){
        if(String(req.headers['content-type']).split(';')[0]!=='application/json'){send({error:{code:'content-type',message:'需要JSON请求'}},415);return;}
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>32768){send({error:{code:'size',message:'设置内容过大'}},413);return;}}
        let value;try{value=JSON.parse(body);}catch{send({error:{code:'json',message:'设置不是合法JSON'}},400);return;}
        if(!value||Object.keys(value).some(k=>!['revision','settings'].includes(k)))throw new SettingsError('invalid','请求包含未知字段');
        send(saveSettings(value,configFile));return;
      }
      if(req.method==='POST'&&url.pathname==='/api/check'){send(await checkHealth());return;}
      if(req.method==='GET'&&url.pathname==='/api/jobs'){
        const dir=path.join(dataDir,'jobs');let entries=[];try{entries=fs.readdirSync(dir,{withFileTypes:true}).filter(x=>x.isDirectory()&&/^[a-zA-Z0-9_-]{1,64}$/.test(x.name)).map(x=>({id:x.name,time:fs.statSync(path.join(dir,x.name)).mtimeMs})).sort((a,b)=>b.time-a.time).slice(0,20);}catch{}
        const items=entries.flatMap(x=>{try{const s=JSON.parse(fs.readFileSync(path.join(dir,x.id,'status.json'),'utf8'));return [{id:x.id,status:s.status,stage:s.stage,voiceId:s.voiceId,seconds:s.audio?.seconds??s.clip?.seconds,createdAt:s.startedAt,updatedAt:s.completedAt??s.startedAt,error:s.status==='failed'?'处理失败，请检查模型配置或本机任务日志':undefined}];}catch{return [];}});send({items});return;
      }
      send({error:{code:'not-found',message:'接口不存在'}},404);
    }catch(e){send({error:{code:e.code??'internal',message:e instanceof SettingsError?e.message:'无法读取或保存设置，请检查本机配置',...(e.field?{field:e.field}:{})}},e.code==='conflict'?409:e instanceof SettingsError?400:500);}
  });return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const cfg=loadConfig();const port=Number(cfg.uiPort??3119);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid UI port');
  const server=createUiServer();server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'翻唱设置端口已被占用':'翻唱设置服务启动失败');process.exitCode=1;});server.listen(port,'127.0.0.1',()=>console.log(`Cover settings: http://127.0.0.1:${port}`));
}
