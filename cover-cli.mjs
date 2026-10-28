import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {clipWindow, mixArgs, probe, run, songId} from './cover-core.mjs';
import {loadConfig,settingsOf} from './settings.mjs';
import {separatorArgs,rvcArgs as buildRvcArgs} from './render-params.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const {values: opts} = parseArgs({options: {input: {type: 'string'}, song: {type: 'string'}, start: {type: 'string'}, seconds: {type: 'string'}, pitch: {type: 'string'}, 'config-snapshot': {type:'string'}, 'separator-device': {type: 'string'}, 'job-id': {type: 'string'}}, strict: true});
if(opts['config-snapshot']){const rel=path.relative(path.join(root,'data','requests'),path.resolve(opts['config-snapshot']));if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('Configuration snapshot must be a managed request file');}
const cfg = loadConfig(opts['config-snapshot']?path.resolve(opts['config-snapshot']):path.join(root,'config.local.json'));
if (Boolean(opts.input) === Boolean(opts.song)) throw Error('Choose exactly one of --input (operator only) or --song (NetEase ID/link)');
const seconds = Number(opts.seconds ?? cfg.defaultSeconds), pitch = Number(opts.pitch ?? cfg.pitch);
if (!Number.isFinite(seconds) || seconds < 5 || seconds > cfg.maxSeconds || !Number.isInteger(pitch) || pitch < -12 || pitch > 12) throw Error('Invalid duration or pitch');
const device = opts['separator-device'] ?? cfg.device;
if (!['directml', 'cpu'].includes(device)) throw Error('Invalid separator device');
cfg.pitch=pitch;cfg.device=device;
const id = opts['job-id'] ?? `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw Error('Invalid job id');
const dir = path.join(root, 'data', 'jobs', id);
if (fs.existsSync(dir)) throw Error('Job ID already exists; refusing overwrite');
const lock = path.join(root, 'data', 'pipeline.lock');
fs.mkdirSync(path.dirname(lock), {recursive: true});
try {fs.mkdirSync(lock);} catch {throw Error('A cover worker is already running (or a stale lock needs operator inspection)');}
process.on('exit', () => {try {fs.rmdirSync(lock);} catch {}});
fs.mkdirSync(dir, {recursive: true});
const cache = path.join(dir, 'cache'); fs.mkdirSync(cache);
const env = {PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', OMP_NUM_THREADS: '8', MKL_NUM_THREADS: '8', TMP: cache, TEMP: cache, NUMBA_CACHE_DIR: cache, LIBROSA_CACHE_DIR: cache};
const ctl = new AbortController(); process.once('SIGINT', () => ctl.abort()); process.once('SIGTERM', () => ctl.abort());
// If the owning MCP server vanishes, stop its work instead of leaving an orphan job.
const parentPid = process.ppid;
const parentWatch = setInterval(() => {try {process.kill(parentPid, 0);} catch(e) {if (e.code === 'ESRCH') ctl.abort();}}, 5000);
parentWatch.unref();
let state = {id, status: 'running', voiceId: cfg.voiceId, pitch, settings:settingsOf(cfg), startedAt: new Date().toISOString(), stages: []};
const save = () => {fs.writeFileSync(path.join(dir, 'status.json.tmp'), JSON.stringify(state, null, 2)); fs.renameSync(path.join(dir, 'status.json.tmp'), path.join(dir, 'status.json'));};
save();
async function stage(name, fn) {state.stage = name; save(); console.error(`[cover] ${name}`); const start = Date.now(); const value = await fn(); state.stages.push({name, elapsedMs: Date.now() - start}); save(); return value;}
const command = (exe, args, name, extra = {}) => run(exe, args, {cwd: dir, env, logFile: path.join(dir, `${name}.log`), timeoutMs: cfg.stageTimeoutMs, signal: ctl.signal, ...extra});
try {
  let input, chosenStart = opts.start === undefined ? null : Number(opts.start);
  if (opts.song) {
    const {downloadSong, chorusStart} = await import('./netease.mjs');
    const sid = songId(opts.song); state.songId = sid; save();
    input = await stage('download', () => downloadSong(sid, path.join(dir, 'source.audio'), ctl.signal,{quality:cfg.downloadQuality}));
    if (chosenStart === null) {const chorus = cfg.preferChorus?await chorusStart(sid):null; chosenStart = chorus?.seconds ?? cfg.fallbackStart; state.selection = chorus ? 'netease-chorus' : 'configured-fallback';}
  } else {input = path.resolve(opts.input); state.selection = chosenStart === null ? 'operator-default-30s' : 'operator-start';}
  const original = await probe(input, cfg);
  chosenStart ??= cfg.fallbackStart;
  // A short source can be used from zero, but a supplied invalid start is rejected.
  if (opts.start === undefined && chosenStart >= original.seconds - 5) {chosenStart = 0; state.selection += '-short-source';}
  const window = clipWindow(original.seconds, {start: chosenStart, seconds, maxSeconds: cfg.maxSeconds});
  state.clip = window; save();
  const clip = path.join(dir, 'clip.wav');
  await stage('clip', () => command(path.join(cfg.rvcRoot, 'ffmpeg.exe'), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-ss', String(window.start), '-i', input, '-t', String(window.seconds), '-vn', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', clip], 'clip'));
  const {stdout: splitOutput} = await stage('separate', () => command(cfg.python, separatorArgs(clip,path.join(dir,'stems'),cfg), 'separate'));
  const split = JSON.parse(splitOutput.trim().split(/\r?\n/).at(-1));
  if (!split.vocals || !split.instrumental || !split.device) throw Error('Separation did not return two stems and its device');
  state.device = split.device; save();
  const vocal = path.join(dir, 'converted.wav');
  const rvcArgs = buildRvcArgs(split.vocals,vocal,cfg);
  const {stdout: converted} = await stage('rvc', () => command(cfg.python, rvcArgs, 'rvc', {cwd: cfg.rvcRoot}));
  if (!JSON.parse(converted.trim().split(/\r?\n/).at(-1)).ok) throw Error('RVC did not report success');
  const vocalInfo = await probe(vocal, cfg);
  if (Math.abs(vocalInfo.seconds - window.seconds) > 1) throw Error('Converted vocal has unexpected duration');
  const out = path.join(dir, 'cover-30s.wav');
  await stage('mix', () => command(path.join(cfg.rvcRoot, 'ffmpeg.exe'), mixArgs(vocal, split.instrumental, out, window.seconds,cfg), 'mix'));
  const info = await probe(out, cfg);
  if (info.seconds > cfg.maxSeconds + 0.1 || Math.abs(info.seconds - window.seconds) > 0.15) throw Error('Final duration validation failed');
  state.status = 'complete'; state.output = out; state.audio = info; state.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ok: true, jobId: id, output: out, seconds: info.seconds, stages: state.stages}));
} catch(e) {state.status = ctl.signal.aborted ? 'cancelled' : 'failed'; state.error = e.message; state.completedAt = new Date().toISOString(); save(); console.error(e.message); process.exitCode = 1;}
