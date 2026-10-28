import test from 'node:test';
import assert from 'node:assert/strict';
import {CoverQueue} from './cover-queue.mjs';
const flush = () => new Promise(r => setImmediate(r));
test('single worker, duplicate requests, cooldown and cross-conversation isolation', async () => {
  const work = []; let running = 0, peak = 0;
  const q = new CoverQueue({execute: async j => {running++; peak = Math.max(peak, running); await new Promise(r => work.push(r)); running--; return {voice: j.id};}});
  const a = q.submit('group:1', {songId: '1'});
  assert.equal(q.submit('group:1', {songId: '1'}), a);
  assert.throws(() => q.submit('group:1', {songId: '2'}), /three minutes/);
  assert.throws(() => q.get('group:2', a.id), /not found/);
  assert.throws(() => q.cancel('group:2', a.id), /not found/);
  const b = q.submit('group:2', {songId: '2'});
  assert.equal(b.status, 'queued'); assert.equal(peak, 1);
  const waited = q.wait('group:1', a.id, 1000);
  work.shift()(); assert.equal((await waited).status, 'complete'); await flush();
  assert.equal(b.status, 'running'); assert.equal(peak, 1);
  work.shift()(); await q.wait('group:2', b.id, 1000); q.close();
});
test('bounded queue, cancellation and failures do not stall the next task', async () => {
  const q = new CoverQueue({maxPending: 1, execute: async (j, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancel')), {once: true}))});
  const a = q.submit('private:1', {}), b = q.submit('private:2', {});
  assert.throws(() => q.submit('private:3', {}), /queue is full/);
  q.cancel('private:2', b.id); assert.equal(b.status, 'cancelled');
  q.cancel('private:1', a.id); assert.equal((await q.wait('private:1', a.id, 1000)).status, 'cancelled');
  q.close(); assert.throws(() => q.submit('private:3', {}), /stopping/);
});
