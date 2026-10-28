import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ROOT,PARAM_DEFAULTS,settingsDocument,saveSettings,loadConfig} from './settings.mjs';
import {createUiServer} from './ui-server.mjs';
import {coverRequest,separatorArgs,rvcArgs} from './render-params.mjs';
function fixture(){fs.mkdirSync(path.join(ROOT,'data'),{recursive:true});const root=fs.mkdtempSync(path.join(ROOT,'data','settings-test-'));for(const d of ['uvr','weights','indices'])fs.mkdirSync(path.join(root,d));const onnx=Buffer.from('test-only-onnx-metadata-no-model');fs.writeFileSync(path.join(root,'uvr','HQ3.onnx'),onnx);const hash=createHash('md5').update(onnx).digest('hex');const meta=path.join(root,'uvr','metadata.json');fs.writeFileSync(meta,JSON.stringify({[hash]:{primary_stem:'Instrumental',compensate:1.022}}));fs.writeFileSync(path.join(root,'weights','voice.pth'),'test only');const config={...PARAM_DEFAULTS,uvrModel:path.join(root,'uvr','HQ3.onnx'),uvrMetadata:meta,rvcModel:path.join(root,'weights','voice.pth'),rvcRoot:root,rvcIndex:'',node:process.execPath,python:'not-installed',privatePreserve:'test-private-sentinel'};const file=path.join(root,'config.local.json');fs.writeFileSync(file,JSON.stringify(config));return{root,file,config};}
test('settings save preserves deployment fields, rejects stale writes and model/path injection',()=>{
 const{file}=fixture();const d=settingsDocument(file);assert.ok(!JSON.stringify(d).includes('test-private-sentinel'));assert.deepEqual(d.catalog.uvr.map(x=>x.id),['HQ3.onnx']);
 const s=structuredClone(d.settings);s.defaultSeconds=8;s.uvr.overlap=.5;s.rvc.protect=.2;s.mix.instrumentalGain=.7;
 const n=saveSettings({revision:d.revision,settings:s},file);assert.equal(n.settings.defaultSeconds,8);assert.equal(loadConfig(file).privatePreserve,'test-private-sentinel');
 assert.throws(()=>saveSettings({revision:d.revision,settings:s},file),e=>e.code==='conflict');
 for(const mutate of [v=>v.uvr.modelId='../outside.onnx',v=>v.maxSeconds=6,v=>v.rvc.f0Method='harvest',v=>v.rvc.command='calc']){const bad=structuredClone(n.settings);mutate(bad);assert.throws(()=>saveSettings({revision:n.revision,settings:bad},file),e=>e.code==='invalid');}
});
test('generation uses frozen settings and all selected inference options',()=>{
 const{config}=fixture();Object.assign(config,{defaultSeconds:8,pitch:2,uvrOverlap:.5,uvrDenoise:true,uvrCompensate:1.1,rvcProtect:.2,rvcRmsMixRate:.7,rvcResampleSr:44100});
 const req=coverRequest({song:'1234'},config);config.pitch=-3;config.uvrOverlap=.75;assert.equal(req.seconds,8);assert.equal(req.pitch,2);assert.equal(req.configSnapshot.uvrOverlap,.5);
 const sep=separatorArgs('in.wav','stems',req.configSnapshot);assert.ok(sep.includes('--denoise'));assert.equal(sep[sep.indexOf('--overlap')+1],'0.5');assert.equal(sep[sep.indexOf('--compensate')+1],'1.1');
 const r=rvcArgs('v.wav','o.wav',req.configSnapshot);assert.equal(r[r.indexOf('--protect')+1],'0.2');assert.equal(r[r.indexOf('--index-rate')+1],'0');assert.equal(r[r.indexOf('--resample-sr')+1],'44100');assert.equal(r[r.indexOf('--rms-mix-rate')+1],'0.7');
 assert.throws(()=>coverRequest({song:'1234',seconds:46},config));assert.throws(()=>coverRequest({song:'1234',seconds:30},{...config,maxSeconds:20}));
});
test('own UI API enforces local origin, session and CSRF; saves and conflicts are real',async()=>{
 const{file}=fixture();const server=createUiServer({configFile:file,healthCheck:async()=>({bridge:{ok:true},netease:{loggedIn:true}})});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{assert.equal((await fetch(base+'/api/bootstrap')).status,401);assert.equal((await fetch(base+'/api/session',{headers:{origin:'https://evil.example'}})).status,403);
 const session=await fetch(base+'/api/session');const cookie=session.headers.get('set-cookie').split(';')[0];const {csrfToken}=await session.json();const headers={cookie,'x-cover-csrf':csrfToken};const doc=await(await fetch(base+'/api/bootstrap',{headers})).json();assert.equal(doc.settings.defaultSeconds,30);
 assert.equal((await fetch(base+'/api/bootstrap',{headers:{cookie,'x-cover-csrf':'é'.repeat(64)}})).status,401);
 const changed=structuredClone(doc.settings);changed.defaultSeconds=9;const request={method:'PUT',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({revision:doc.revision,settings:changed})};
 const saved=await fetch(base+'/api/settings',request);assert.equal(saved.status,200);assert.equal((await saved.json()).settings.defaultSeconds,9);assert.equal((await fetch(base+'/api/settings',request)).status,409);
 const check=await fetch(base+'/api/check',{method:'POST',headers});assert.equal((await check.json()).bridge.ok,true);
 }finally{await new Promise(r=>server.close(r));server.closeAllConnections();}
});
