import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {authorizeConversation} from './bridge-access.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const folder = path.join(root, 'data', 'auth-test'); fs.mkdirSync(folder, {recursive: true});
const file = path.join(folder, 'bridge-config.json');
const serviceToken = 'test-service-credential-not-a-real-token';
fs.writeFileSync(file, JSON.stringify({consoleToken: serviceToken}));
const cfg = {enabled: true, bridgeBase: 'http://127.0.0.1:3100', bridgeConfig: file};
const agent = 'test-conversation-token-not-a-real-token';
test('loopback service credential never substitutes for the conversation token', async () => {
  let calls = 0;
  await authorizeConversation('private:1234', agent, cfg, {fetchImpl: async (url, opts) => {
    calls++; assert.equal(new URL(url).searchParams.get('key'), 'private:1234');
    assert.equal(opts.headers['x-console-token'], serviceToken);
    assert.equal(opts.headers['x-agent-call'], '1'); assert.equal(opts.headers['x-agent-token'], agent);
    return {ok: true, json: async () => ({ok: true, voices: {enabled: true}})};
  }});
  assert.equal(calls, 1);
  await assert.rejects(authorizeConversation('private:1234', '', cfg, {fetchImpl: async () => {throw Error('should not fetch');}}), /token is required/);
});
test('bridge 401/403 and voice disablement fail closed', async () => {
  for (const status of [401, 403]) await assert.rejects(authorizeConversation('private:1234', agent, cfg, {fetchImpl: async () => ({ok: false, status})}));
  await assert.rejects(authorizeConversation('private:1234', agent, cfg, {fetchImpl: async () => ({ok: true, json: async () => ({ok: true, voices: {enabled: false}})})}), /unavailable/);
  await assert.rejects(authorizeConversation('private:1234', agent, {...cfg, enabled: false}));
});
