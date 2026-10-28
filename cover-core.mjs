import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

export function clipWindow(total, {start = 0, seconds = 30, maxSeconds = 45} = {}) {
  if (![total, start, seconds, maxSeconds].every(Number.isFinite) || total <= 0 || start < 0 || seconds < 5 || seconds > maxSeconds || maxSeconds > 45 || start >= total) throw Error('Invalid clip: require 5–45 seconds and an in-range start');
  const duration = Math.min(seconds, total - start);
  if (duration < 5) throw Error('Less than five seconds remain at this start');
  return {start, seconds: duration};
}

export function songId(value) {
  const s = String(value ?? '').trim();
  if (/^\d{1,16}$/.test(s)) return s;
  let u; try {u = new URL(s);} catch {throw Error('Use a numeric song ID or a music.163.com song link');}
  if (u.hostname !== 'music.163.com' || !['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('Use a music.163.com song link');
  const p = new URLSearchParams((u.hash.includes('?') ? u.hash.split('?')[1] : u.search).replace(/^\?/, ''));
  const id = p.get('id'); if (!/^\d{1,16}$/.test(id ?? '')) throw Error('Song link has no valid ID');
  return id;
}

export function run(exe, args, {cwd, timeoutMs = 300000, env = {}, logFile, signal} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error('Task cancelled'));
    const log = logFile ? fs.openSync(logFile, 'a') : null;
    let child, settled = false, timedOut = false, cancelled = false, stdout = '', stderr = '';
    let timer;
    const finish = (error, result) => {if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); if (log !== null) fs.closeSync(log); error ? reject(error) : resolve(result);};
    const stop = () => {
      if (!child?.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const cancel = () => {cancelled = true; stop();};
    try {child = spawn(exe, args, {cwd, env: {...process.env, ...env}, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']});} catch(e) {finish(e); return;}
    for (const [stream, kind] of [[child.stdout, 'out'], [child.stderr, 'err']]) stream.on('data', b => {if (log !== null) fs.writeSync(log, b); if (kind === 'out') stdout = (stdout + b.toString()).slice(-262144); else stderr = (stderr + b.toString()).slice(-8192);});
    timer = setTimeout(() => {timedOut = true; stop();}, timeoutMs);
    signal?.addEventListener('abort', cancel, {once: true});
    child.on('error', e => finish(e));
    child.on('close', code => finish(timedOut ? Error(`Stage timeout after ${timeoutMs}ms`) : cancelled ? Error('Task cancelled') : code !== 0 ? Error(`Stage exit ${code}: ${(stderr || stdout).slice(-1200)}`) : null, {stdout, stderr, code}));
  });
}

export async function probe(file, cfg) {
  const {stdout} = await run(path.join(cfg.rvcRoot, 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,sample_rate,channels', '-of', 'json', file], {timeoutMs: 15000});
  const p = JSON.parse(stdout); const stream = p.streams?.find(s => s.codec_type === 'audio');
  const seconds = Number(p.format?.duration);
  if (!stream || !Number.isFinite(seconds) || seconds <= 0) throw Error('No valid audio stream');
  return {seconds, channels: stream.channels, sampleRate: Number(stream.sample_rate)};
}

export function mixArgs(vocal, instrumental, output, seconds, {vocalGain=1,instrumentalGain=0.8,fadeInSeconds=0.08,fadeOutSeconds=0.25,peakLimit=0.95}={}) {
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 45) throw Error('Invalid mix duration');
  for(const [v,min,max]of [[vocalGain,0,2],[instrumentalGain,0,2],[fadeInSeconds,0,2],[fadeOutSeconds,0,2],[peakLimit,0.5,1]])if(!Number.isFinite(v)||v<min||v>max)throw Error('Invalid mix settings');
  const fade = Math.max(0, seconds - fadeOutSeconds);
  // FFmpeg 4.3 has no amix normalize option. Merge explicit stereo inputs,
  // then sum their channels without changing the instrumental stereo image.
  const graph = `[0:a]aresample=44100,aformat=channel_layouts=stereo,apad[v];[1:a]aresample=44100,aformat=channel_layouts=stereo[b];[v][b]amerge=inputs=2,pan=stereo|c0=${vocalGain}*c0+${instrumentalGain}*c2|c1=${vocalGain}*c1+${instrumentalGain}*c3,alimiter=limit=${peakLimit}:level=false,afade=t=in:d=${fadeInSeconds},afade=t=out:st=${fade}:d=${fadeOutSeconds}[a]`;
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-i', vocal, '-i', instrumental, '-filter_complex', graph, '-map', '[a]', '-t', String(seconds), '-ac', '2', '-c:a', 'pcm_s16le', output];
}
