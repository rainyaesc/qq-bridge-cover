import test from 'node:test';
import assert from 'node:assert/strict';
import {clipWindow, songId} from './cover-core.mjs';
test('clips before separation and never expands the 45 second budget', () => {
  assert.deepEqual(clipWindow(200, {start: 60, seconds: 30}), {start: 60, seconds: 30});
  assert.deepEqual(clipWindow(75, {start: 60, seconds: 30}), {start: 60, seconds: 15});
  for (const values of [{seconds: 300}, {seconds: NaN}, {seconds: 4}, {start: -1}, {start: 200}, {maxSeconds: 100}]) assert.throws(() => clipWindow(200, values));
  assert.throws(() => clipWindow(62, {start: 60}));
});
test('song inputs cannot become arbitrary URL or shell input', () => {
  assert.equal(songId('123456'), '123456');
  assert.equal(songId('https://music.163.com/#/song?id=123456'), '123456');
  assert.equal(songId('https://music.163.com/song?id=123456'), '123456');
  for (const s of ['https://evil.example/song?id=1', 'http://127.0.0.1/?id=1', 'https://music.163.com@evil.example/?id=1', '1 & calc', '../file', 'https://music.163.com/song?id=-1']) assert.throws(() => songId(s));
});
