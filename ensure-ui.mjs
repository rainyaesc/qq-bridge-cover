import {spawn} from 'node:child_process';
import path from 'node:path';
import {ROOT} from './settings.mjs';
export async function ensureUi(config){
  if(process.env.COVER_UI_AUTOSTART==='0')return;
  const port=Number(config.uiPort??3119);
  try{const r=await fetch(`http://127.0.0.1:${port}/api/ping`,{signal:AbortSignal.timeout(1500)});const v=await r.json();if(v.service!=='qq-bridge-cover-ui')console.error('翻唱设置端口已被其他服务占用');return;}catch{}
  const child=spawn(config.node||process.execPath,[path.join(ROOT,'ui-server.mjs')],{cwd:ROOT,windowsHide:true,stdio:'ignore',env:{...process.env,COVER_UI_AUTOSTART:'0'}});child.on('error',()=>console.error('翻唱设置界面启动失败'));child.unref();
}
