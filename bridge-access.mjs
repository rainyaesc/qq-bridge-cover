import fs from 'node:fs';
import path from 'node:path';

export async function authorizeConversation(key, token, config, {fetchImpl = fetch} = {}) {
  if (config.enabled !== true) throw Error('Cover plugin is disabled by the administrator');
  if (!/^(group|private):\d{1,20}$/.test(String(key)) || !/^[A-Za-z0-9_-]{16,256}$/.test(String(token))) throw Error('Conversation token is required');
  const base = new URL(config.bridgeBase);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw Error('Invalid local bridge configuration');
  // The service credential opens the loopback gateway; it does not replace
  // per-conversation authorization. Always declare this as an agent call.
  const bridgeConfigFile = path.resolve(config.bridgeConfig);
  const bridgeConfig = JSON.parse(fs.readFileSync(bridgeConfigFile, 'utf8').replace(/^\uFEFF/, ''));
  let serviceToken = String(bridgeConfig.consoleToken ?? '').trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(serviceToken)) serviceToken = fs.readFileSync(path.join(path.dirname(bridgeConfigFile), 'state', 'console-token'), 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(serviceToken)) throw Error('Bridge service credential is unavailable');
  const r = await fetchImpl(`${base.origin}/api/socialV2/prompt?key=${encodeURIComponent(key)}`, {
    headers: {'x-console-token': serviceToken, 'x-agent-call': '1', 'x-agent-token': token},
    signal: AbortSignal.timeout(5000)
  });
  if (!r.ok) throw Error(r.status === 401 ? 'Bridge service credential was rejected' : 'Conversation permission or token is invalid');
  const b = await r.json();
  if (b.ok === false || b.voices?.enabled !== true) throw Error('Voice/cover use is unavailable in this conversation');
}
