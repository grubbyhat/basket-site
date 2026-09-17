import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createXLookup } from './x-lookup.js';

function response({ status = 200, type = 'application/json', body = {} } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': type }), json: async () => body };
}
const jack = { code: 200, user: { id: 12, name: 'jack', screen_name: 'Jack', avatar_url: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg', followers: 5 } };

test('handles resolve to numeric IDs with a full-size picture, and results are cached', async () => {
  const calls = [];
  const lookup = createXLookup({ fetchImpl: async url => { calls.push(url); return response({ body: jack }); } });
  const profile = await lookup.lookup('@Jack');
  assert.deepEqual({ ...profile, lookedUpAt: undefined }, { id: '12', handle: 'jack', name: 'jack', avatarUrl: 'https://pbs.twimg.com/profile_images/1/a_400x400.jpg', followers: 5, lookedUpAt: undefined });
  await lookup.lookup('jack');
  assert.deepEqual(calls, ['https://api.fxtwitter.com/jack']);
  assert.equal(await lookup.lookup('not a handle'), null);
  assert.equal(calls.length, 1);
});

test('unknown users come back as HTML or 404 and are remembered briefly', async () => {
  let calls = 0;
  let now = 0;
  const lookup = createXLookup({ now: () => now, fetchImpl: async url => { calls += 1; return url.endsWith('/gone') ? response({ status: 404 }) : response({ type: 'text/html' }); } });
  assert.equal(await lookup.lookup('nobody_here_1'), null);
  assert.equal(await lookup.lookup('nobody_here_1'), null);
  assert.equal(await lookup.lookup('gone'), null);
  assert.equal(calls, 2);
  now = 61_000;
  assert.equal(await lookup.lookup('gone'), null);
  assert.equal(calls, 3);
});

test('an outage throws instead of pretending the user is missing', async () => {
  const lookup = createXLookup({ fetchImpl: async () => response({ status: 503 }) });
  await assert.rejects(lookup.lookup('jack'), /503/);
  const later = createXLookup({ fetchImpl: async () => response({ body: { code: 500 } }) });
  assert.equal(await later.lookup('jack'), null);
});
