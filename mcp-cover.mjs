import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {CoverQueue} from './cover-queue.mjs';
import {run, songId, probe} from './cover-core.mjs';
import {searchSongs} from './netease.mjs';
import {authorizeConversation} from './bridge-access.mjs';
import {loadConfig} from './settings.mjs';
import {coverRequest} from './render-params.mjs';
import {ensureUi} from './ensure-ui.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const cfg = () => loadConfig(process.env.COVER_CONFIG_FILE||path.join(root,'config.local.json'));
const ledger = path.join(root, 'data', 'requests'); fs.mkdirSync(ledger, {recursive: true});
const keySchema = z.string().regex(/^(group|private):\d{1,20}$/);
const identity = {key: keySchema, token: z.string().min(16).max(256)};

async function authorize(key, token) {
  await authorizeConversation(key, token, cfg());
}
function view(j) {
  return {jobId: j.id, status: j.status, songId: j.request.songId, seconds: j.request.seconds, voiceId: j.result?.voiceId??j.request.configSnapshot?.voiceId,
    ...(j.status === 'complete' ? {voice: j.result.voice, durationSeconds: j.result.seconds, hint: 'Use qq_send_voice with this library name and the current conversation key/token; this task has not sent anything.'} : {}),
    ...(j.status === 'failed' ? {error: 'Local cover processing failed; an administrator can inspect the private task log.'} : {})};
}
const queue = new CoverQueue({
  persist: job => {const {abort, ...data} = job; const file = path.join(ledger, `${job.id}.json`); fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2)); fs.renameSync(`${file}.tmp`, file);},
  execute: async (job, signal) => {
    const c = job.request.configSnapshot;
    const snapshot=path.join(ledger,`${job.id}.config.json`);fs.writeFileSync(snapshot,JSON.stringify(c,null,2),{flag:'wx'});
    const args = [path.join(root, 'cover-cli.mjs'), '--config-snapshot',snapshot,'--song', job.request.songId, '--seconds', String(job.request.seconds), '--pitch', String(job.request.pitch), '--job-id', job.id];
    if (job.request.start !== undefined) args.push('--start', String(job.request.start));
    await run(c.node, args, {cwd: root, signal, timeoutMs: 600000, logFile: path.join(ledger, `${job.id}.log`)});
    const status = JSON.parse(fs.readFileSync(path.join(root, 'data', 'jobs', job.id, 'status.json'), 'utf8'));
    if (status.status !== 'complete' || signal.aborted) throw Error('Cover was not completed');
    const expected = path.join(root, 'data', 'jobs', job.id, 'cover-30s.wav');
    if (status.output !== expected) throw Error('Unexpected output artifact');
    const info = await probe(expected, c);
    if (info.seconds < 5 || info.seconds > 45.1) throw Error('Artifact is outside the clip duration budget');
    if (c.enabled !== true || cfg().enabled !== true) throw Error('Cover plugin was disabled before publication');
    const library = fs.realpathSync(c.voiceLibrary);
    const covers = path.join(library, 'covers'); fs.mkdirSync(covers, {recursive: true});
    if (!fs.realpathSync(covers).startsWith(library + path.sep)) throw Error('Voice library covers folder escapes the configured library');
    const name = `${job.id}.wav`;
    fs.copyFileSync(expected, path.join(covers, name), fs.constants.COPYFILE_EXCL);
    return {voice: `covers/${name}`, seconds: info.seconds,voiceId:status.voiceId};
  }
});
function find(owner, id) {
  if (queue.jobs.has(id)) return queue.get(owner, id);
  const file = path.join(ledger, `${id}.json`);
  if (!fs.existsSync(file)) throw Error('Task not found in this conversation');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (j.owner !== owner) throw Error('Task not found in this conversation');
  // A previous server's process is not assumed alive after a restart.
  if (['running', 'queued'].includes(j.status)) return {...j, status: 'interrupted'};
  return j;
}
const server = new McpServer({name: 'music-cover', version: '0.2.0'});
const result = x => ({content: [{type: 'text', text: JSON.stringify(x)}]});
const guarded = fn => async p => {try {await authorize(p.key, p.token); return result(await fn(p));} catch(e) {return {...result({ok: false, error: e.name==='CoverParameterError'||e.message.includes('Task not found') ? e.message : 'Cover request failed. Check conversation permission, cooldown, queue capacity or backend readiness.'}), isError: true};}};
server.tool('search_song', 'Search NetEase by title and artist. Returns up to five song IDs; resolve ambiguous titles before creating a cover. Does not download or send audio.', {...identity, keywords: z.string().min(1).max(160)}, guarded(async p => ({songs: await searchSongs(p.keywords)})));
server.tool('create_cover', 'Create a short AI cover using the administrator’s current UVR/RVC settings. Omit seconds, pitch and start unless the user explicitly requested overrides; the backend supplies the configured defaults and freezes settings for this task. Always crop BEFORE separation; only 5–45 second clips within the configured maximum. Waits up to 90 seconds, then returns a job ID if still processing. Never sends to QQ automatically. On completion use the returned voice library name with qq_send_voice. Do not claim completion while queued/running.', {...identity, song: z.string().min(1).max(200), seconds: z.number().min(5).max(45).optional(), start: z.number().min(0).max(86400).optional(), pitch: z.number().int().min(-12).max(12).optional()}, guarded(async p => {
  const request = coverRequest(p,cfg());
  const job = queue.submit(p.key, request);
  return view(await queue.wait(p.key, job.id, 90000));
}));
const jobIdentity = {...identity, jobId: z.string().regex(/^cover-[0-9a-f-]{36}$/)};
server.tool('cover_status', 'Check only this conversation’s cover task. Optionally wait up to 25 seconds for completion without repeated polling. A complete result supplies a voice library name; no message has been sent.', {...jobIdentity, waitSeconds: z.number().min(0).max(25).default(0)}, guarded(async p => view(queue.jobs.has(p.jobId) ? await queue.wait(p.key, p.jobId, p.waitSeconds * 1000) : find(p.key, p.jobId))));
server.tool('cancel_cover', 'Cancel this conversation’s pending or running cover task. Does not delete previously completed audio.', jobIdentity, guarded(async p => view(queue.jobs.has(p.jobId) ? queue.cancel(p.key, p.jobId) : find(p.key, p.jobId))));
process.once('SIGINT', () => {queue.close();}); process.once('SIGTERM', () => {queue.close();}); process.stdin.once('close', () => queue.close());
await server.connect(new StdioServerTransport());
void ensureUi(cfg());
