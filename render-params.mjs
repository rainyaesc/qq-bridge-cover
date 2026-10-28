import path from 'node:path';
import {ROOT,PARAM_DEFAULTS} from './settings.mjs';
import {songId} from './cover-core.mjs';
export function effectiveConfig(c) {return {...PARAM_DEFAULTS,...c};}
export class CoverParameterError extends Error {constructor(message){super(message);this.name='CoverParameterError';}}
export function coverRequest(input,config) {
  const c=effectiveConfig(structuredClone(config));const seconds=input.seconds??c.defaultSeconds,pitch=input.pitch??c.pitch;
  if(!Number.isFinite(seconds)||seconds<5||seconds>45||seconds>c.maxSeconds)throw new CoverParameterError('片段时长超出后台设置的上限');
  if(!Number.isInteger(pitch)||pitch< -12||pitch>12)throw new CoverParameterError('移调应为-12至12之间的整数');
  c.pitch=pitch;
  return {songId:songId(input.song),seconds,pitch,...(input.start===undefined?{}:{start:input.start}),configSnapshot:c};
}
export function separatorArgs(input,output,c) {return ['-B',path.join(ROOT,'mdx_separate.py'),'--root',c.rvcRoot,'--model',c.uvrModel,'--metadata',c.uvrMetadata,'--input',input,'--output-dir',output,'--device',c.device,'--device-id',String(c.deviceId),'--overlap',String(c.uvrOverlap),...(c.uvrDenoise?['--denoise']:[]),...(c.uvrCompensate===null?[]:['--compensate',String(c.uvrCompensate)])];}
export function rvcArgs(input,output,c) {return ['-B',c.rvcScript||path.join(ROOT,'tools/rvc_infer.py'),'--root',c.rvcRoot,'--model',c.rvcModel,'--input',input,'--output',output,'--pitch',String(c.pitch),'--f0-method',c.rvcF0Method,'--index-rate',c.rvcIndex?String(c.rvcIndexRate):'0','--protect',String(c.rvcProtect),'--rms-mix-rate',String(c.rvcRmsMixRate),'--resample-sr',String(c.rvcResampleSr),...(c.rvcIndex?['--index',c.rvcIndex]:[])];}
