import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHandle, previewPayload, splitEvenly, toBasisPoints, validateBasket, validateDraft } from './basket.js';

test('handles normalize without accepting posts or unrelated domains as recipients', () => {
  assert.equal(normalizeHandle('@TheCreator'), 'thecreator');
  assert.equal(normalizeHandle('https://x.com/Creator'), 'creator');
  assert.equal(normalizeHandle('twitter.com/Creator/'), 'creator');
  for (const handle of ['https://x.com/creator/status/123', 'https://evil.example/creator', 'two words', '@', 'https://x.com/creator?x=1']) {
    assert.equal(validateBasket([{ handle, share: '100' }]).valid, false, handle);
  }
});
test('allocation validates integer basis points, unique recipients and the five-recipient limit', () => {
  assert.equal(toBasisPoints('33.33'), 3333);
  for (const value of ['', 'NaN', 'Infinity', '-1', '100.01', '1e2', '33.333']) assert.equal(toBasisPoints(value), null);
  assert.equal(validateBasket([{ handle: 'creator', share: '99.99' }]).valid, false);
  assert.equal(validateBasket([{ handle: 'creator', share: '100' }, { handle: 'builder', share: '0' }]).valid, false);
  assert.equal(validateBasket([{ handle: 'Creator', share: '50' }, { handle: '@creator', share: '50' }]).valid, false);
  assert.equal(validateBasket(Array.from({ length: 6 }, (_, i) => ({ handle: `user${i}`, share: '20' }))).valid, false);
  assert.equal(validateBasket([]).valid, false);
  assert.equal(validateBasket([{ handle: 'a', share: '33.34' }, { handle: 'b', share: '33.33' }, { handle: 'c', share: '33.33' }]).valid, true);
});
test('even splits remain exact for every supported basket size', () => {
  for (let count = 1; count <= 5; count++) {
    const input = Array.from({ length: count }, (_, id) => ({ id, handle: `person${id}`, share: '0' }));
    const output = splitEvenly(input);
    assert.equal(validateBasket(output).valid, true);
    assert.deepEqual(output.map(r => r.handle), input.map(r => r.handle));
    assert.equal(input[0].share, '0');
  }
});
test('draft validation refuses missing artwork, invalid dev buys and unsafe social links', () => {
  const draft = { name: 'Silver Circle', ticker: 'CIRCLE', description: '', twitter: '', devBuy: '0', recipients: [{ handle: 'creator', share: '100' }] };
  assert.equal(validateDraft(draft, {}).valid, true);
  assert.ok(validateDraft(draft, null).errors.image);
  for (const devBuy of ['-1', 'NaN', 'Infinity', '1e3', '0.0000000001', '']) assert.ok(validateDraft({ ...draft, devBuy }, {}).errors.devBuy);
  assert.equal(validateDraft({ ...draft, devBuy: '0.000000001' }, {}).valid, true);
  for (const twitter of ['javascript:alert(1)', 'https://x.com.evil.example/me', 'https://user:pass@x.com/me', 'https://x.com:9999/me']) assert.ok(validateDraft({ ...draft, twitter }, {}).errors.twitter);
  assert.equal(validateDraft({ ...draft, twitter: 'https://x.com/creator/status/123' }, {}).valid, true);
  const payload = previewPayload(draft, 'https://example.test/launch');
  assert.equal(payload.website, 'https://example.test/coin/…');
  assert.equal(payload.bundle, false);
  assert.deepEqual(payload.recipients, [{ handle: 'creator', basisPoints: 10000 }]);
});
