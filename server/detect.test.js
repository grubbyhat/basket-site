import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { shareholdersOnRoute } from './detect.js';

test('a config counts as Route only when every shareholder is one of Route’s addresses', () => {
  const github = Keypair.generate().publicKey, treasury = Keypair.generate().publicKey, other = Keypair.generate().publicKey;
  const config = list => ({ shareholders: list.map(([address, shareBps]) => ({ address, shareBps })) });
  assert.equal(shareholdersOnRoute(config([[github, 9500], [treasury, 500]]), [treasury, github]), true);
  assert.equal(shareholdersOnRoute(config([[treasury, 10000]]), [treasury, github]), true);
  assert.equal(shareholdersOnRoute(config([[github, 9500], [other, 500]]), [treasury, github]), false);
  assert.equal(shareholdersOnRoute(config([]), [treasury, github]), false);
  assert.equal(shareholdersOnRoute(config([[github, 10000]]), []), false);
  assert.equal(shareholdersOnRoute(null, [treasury]), false);
  assert.ok(new PublicKey(github.toBase58()).equals(github));
});
