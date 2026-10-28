import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root = path.dirname(fileURLToPath(import.meta.url));
const client = new Client({name: 'cover-readiness-check', version: '1.0'});
const transport = new StdioClientTransport({command: process.execPath, args: [path.join(root, 'mcp-cover.mjs')], cwd: root, stderr: 'pipe', env: {...process.env,COVER_UI_AUTOSTART:'0'}});
transport.stderr?.resume();
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map(t => t.name).sort();
  assert.deepEqual(names, ['cancel_cover', 'cover_status', 'create_cover', 'search_song']);
  for (const t of tools.tools) {
    assert.ok(t.inputSchema.required.includes('key'));
    assert.ok(t.inputSchema.required.includes('token'));
    assert.ok(!t.inputSchema.properties.input && !t.inputSchema.properties.command && !t.inputSchema.properties.model);
  }
  const denied = await client.callTool({name: 'create_cover', arguments: {key: 'private:10000', token: 'invalid-token-for-security-check', song: '452986458', seconds: 30, pitch: 0}});
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).ok, false);
  console.log(JSON.stringify({ok: true, tools: names, invalidTokenDenied: true, noSongDownloaded: true}));
  fs.mkdirSync(path.join(root, 'data'), {recursive: true});
  fs.writeFileSync(path.join(root, 'data', 'mcp-verification.json'), JSON.stringify({tools: names, invalidTokenDenied: true, checkedAt: new Date().toISOString()}, null, 2));
} finally {await client.close();}
