import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_FILE = path.join(ROOT, 'config.local.json');
export const PARAM_DEFAULTS = Object.freeze({node:process.execPath,rvcScript:path.join(ROOT,'tools/rvc_infer.py'),defaultSeconds:30,maxSeconds:45,preferChorus:true,fallbackStart:30,downloadQuality:'exhigh',device:'directml',deviceId:0,uvrOverlap:0.25,uvrDenoise:false,uvrCompensate:null,pitch:0,rvcF0Method:'rmvpe',rvcIndexRate:0.66,rvcProtect:0.33,rvcRmsMixRate:1,rvcResampleSr:0,vocalGain:1,instrumentalGain:0.8,fadeInSeconds:0.08,fadeOutSeconds:0.25,peakLimit:0.95});
export function loadConfig(file=CONFIG_FILE) {return {...PARAM_DEFAULTS,...JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''))};}
export const revisionOf = raw => createHash('sha256').update(raw).digest('hex');
export class SettingsError extends Error {constructor(code,message,field){super(message);this.code=code;this.field=field;}}
function within(root,file) {const rel=path.relative(fs.realpathSync(root),fs.realpathSync(file));return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);}
const hashCache=new Map();
function modelHash(file) {const st=fs.statSync(file),key=`${file}:${st.size}:${st.mtimeMs}`;if(hashCache.has(key))return hashCache.get(key);const fd=fs.openSync(file,'r');try{const n=Math.min(st.size,10000*1024),b=Buffer.alloc(n);fs.readSync(fd,b,0,n,st.size-n);const h=createHash('md5').update(b).digest('hex');hashCache.set(key,h);return h;}finally{fs.closeSync(fd);}}
function scan(dir,extension) {try{return fs.readdirSync(dir,{withFileTypes:true}).filter(x=>x.isFile()&&path.extname(x.name).toLowerCase()===extension&&within(dir,path.join(dir,x.name))).map(x=>({id:x.name,label:x.name,available:true,path:path.join(dir,x.name)})).sort((a,b)=>a.id.localeCompare(b.id));}catch{return [];}}
export function catalogFor(c) {
  let meta={};try{meta=JSON.parse(fs.readFileSync(c.uvrMetadata,'utf8'));}catch{}
  const uvr=scan(path.dirname(c.uvrModel||'.'),'.onnx').map(m=>{const p=meta[modelHash(m.path)];return {...m,available:!!p&&['Vocals','Instrumental'].includes(p.primary_stem),primaryStem:p?.primary_stem,compensate:p?.compensate};});
  return {uvr,rvc:scan(path.dirname(c.rvcModel||'.'),'.pth'),indices:[{id:'',label:'不使用检索索引',available:true,path:''},...scan(c.rvcIndex?path.dirname(c.rvcIndex):path.join(c.rvcRoot,'assets','indices'),'.index')]};
}
export const publicCatalog = cat => Object.fromEntries(Object.entries(cat).map(([k,a])=>[k,a.map(({path:privatePath,...p})=>p)]));
export function settingsOf(c) {return {defaultSeconds:c.defaultSeconds,maxSeconds:c.maxSeconds,preferChorus:c.preferChorus,fallbackStart:c.fallbackStart,downloadQuality:c.downloadQuality,
  uvr:{modelId:path.basename(c.uvrModel||''),device:c.device,deviceId:c.deviceId,overlap:c.uvrOverlap,denoise:c.uvrDenoise,compensate:c.uvrCompensate},
  rvc:{modelId:path.basename(c.rvcModel||''),indexId:c.rvcIndex?path.basename(c.rvcIndex):'',pitch:c.pitch,f0Method:c.rvcF0Method,indexRate:c.rvcIndexRate,protect:c.rvcProtect,rmsMixRate:c.rvcRmsMixRate,resampleSr:c.rvcResampleSr},
  mix:{vocalGain:c.vocalGain,instrumentalGain:c.instrumentalGain,fadeIn:c.fadeInSeconds,fadeOut:c.fadeOutSeconds,limit:c.peakLimit}};}
function object(v,keys,field) {if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(v,k)))throw new SettingsError('invalid',`${field}字段不完整或包含未知设置`,field);}
function number(v,min,max,field,integer=false){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||(integer&&!Number.isInteger(v)))throw new SettingsError('invalid',`${field}应在${min}至${max}之间`,field);return v;}
function choice(v,values,field){if(!values.includes(v))throw new SettingsError('invalid',`${field}不是支持的选项`,field);return v;}
function bool(v,field){if(typeof v!=='boolean')throw new SettingsError('invalid',`${field}必须为开关值`,field);return v;}
function selected(list,id,field) {const m=list.find(x=>x.id===id&&x.available);if(!m)throw new SettingsError('invalid','模型或索引不存在/不受当前适配器支持',field);return m.path;}
export function mergeSettings(current,s,cat=catalogFor(current)) {
  object(s,['defaultSeconds','maxSeconds','preferChorus','fallbackStart','downloadQuality','uvr','rvc','mix'],'settings');
  object(s.uvr,['modelId','device','deviceId','overlap','denoise','compensate'],'uvr');object(s.rvc,['modelId','indexId','pitch','f0Method','indexRate','protect','rmsMixRate','resampleSr'],'rvc');object(s.mix,['vocalGain','instrumentalGain','fadeIn','fadeOut','limit'],'mix');
  const out={...current,defaultSeconds:number(s.defaultSeconds,5,45,'defaultSeconds'),maxSeconds:number(s.maxSeconds,5,45,'maxSeconds'),preferChorus:bool(s.preferChorus,'preferChorus'),fallbackStart:number(s.fallbackStart,0,7200,'fallbackStart'),downloadQuality:choice(s.downloadQuality,['standard','exhigh','lossless'],'downloadQuality'),
    uvrModel:selected(cat.uvr,s.uvr.modelId,'uvr.modelId'),device:choice(s.uvr.device,['directml','cpu'],'uvr.device'),deviceId:number(s.uvr.deviceId,0,7,'uvr.deviceId',true),uvrOverlap:choice(s.uvr.overlap,[0.25,0.5,0.75],'uvr.overlap'),uvrDenoise:bool(s.uvr.denoise,'uvr.denoise'),uvrCompensate:s.uvr.compensate===null?null:number(s.uvr.compensate,0.5,2,'uvr.compensate'),
    rvcModel:selected(cat.rvc,s.rvc.modelId,'rvc.modelId'),rvcIndex:selected(cat.indices,s.rvc.indexId,'rvc.indexId'),pitch:number(s.rvc.pitch,-12,12,'rvc.pitch',true),rvcF0Method:choice(s.rvc.f0Method,['rmvpe','pm'],'rvc.f0Method'),rvcIndexRate:number(s.rvc.indexRate,0,1,'rvc.indexRate'),rvcProtect:number(s.rvc.protect,0,0.5,'rvc.protect'),rvcRmsMixRate:number(s.rvc.rmsMixRate,0,1,'rvc.rmsMixRate'),rvcResampleSr:choice(s.rvc.resampleSr,[0,32000,40000,44100,48000],'rvc.resampleSr'),
    vocalGain:number(s.mix.vocalGain,0,2,'mix.vocalGain'),instrumentalGain:number(s.mix.instrumentalGain,0,2,'mix.instrumentalGain'),fadeInSeconds:number(s.mix.fadeIn,0,2,'mix.fadeIn'),fadeOutSeconds:number(s.mix.fadeOut,0,2,'mix.fadeOut'),peakLimit:number(s.mix.limit,0.5,1,'mix.limit')};
  if(out.defaultSeconds>out.maxSeconds)throw new SettingsError('invalid','默认片段不能超过时长上限','defaultSeconds');
  out.voiceId=path.basename(out.rvcModel,path.extname(out.rvcModel));return out;
}
export function settingsDocument(file=CONFIG_FILE) {
  const raw=fs.readFileSync(file,'utf8'),c={...PARAM_DEFAULTS,...JSON.parse(raw)},cat=catalogFor(c);
  const defaults=settingsOf({...c,...PARAM_DEFAULTS});
  return {revision:revisionOf(raw),settings:settingsOf(c),defaults,catalog:publicCatalog(cat),health:{bridge:{ok:null},netease:{configured:fs.existsSync(path.join(path.dirname(file),'data/auth/netease.dpapi')),loggedIn:null},runtime:{python:fs.existsSync(c.python||''),ffmpeg:fs.existsSync(path.join(c.rvcRoot||'.','ffmpeg.exe'))},settingsApply:'next-task'}};
}
export function saveSettings({revision,settings},file=CONFIG_FILE) {
  const raw=fs.readFileSync(file,'utf8');if(typeof revision!=='string'||revision!==revisionOf(raw))throw new SettingsError('conflict','设置已被其他窗口修改，请重新加载后再保存');
  const current={...PARAM_DEFAULTS,...JSON.parse(raw)},next=mergeSettings(current,settings);
  const backups=path.join(path.dirname(file),'data','config-backups');fs.mkdirSync(backups,{recursive:true});fs.writeFileSync(path.join(backups,`${Date.now()}-${revision.slice(0,8)}-${randomUUID().slice(0,8)}.json`),raw,{flag:'wx'});
  const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{flag:'w'});fs.renameSync(tmp,file);return settingsDocument(file);
}
