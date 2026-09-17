import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { lamportsToSol, solToLamports, validateLaunchRequest, validateRecipients } from './validate.js';

export const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export function validBody(overrides = {}) {
  return {
    name: 'Route Coin', symbol: 'ROUTE', description: 'A coin with a route.', twitter: '',
    devBuySol: '0', wallet: Keypair.generate().publicKey.toBase58(),
    recipients: [{ handle: 'jack', basisPoints: 6000 }, { handle: 'https://x.com/elonmusk', basisPoints: 4000 }],
    image: PNG_1X1,
    ...overrides,
  };
}

test('SOL amounts convert to lamports exactly and back', () => {
  assert.equal(solToLamports('0.1'), 100_000_000n);
  assert.equal(solToLamports('1.123456789'), 1_123_456_789n);
  assert.equal(solToLamports('0'), 0n);
  assert.equal(solToLamports('1.1234567890'), null);
  assert.equal(solToLamports('abc'), null);
  assert.equal(solToLamports('-1'), null);
  assert.equal(lamportsToSol(1_500_000_000n), '1.5');
  assert.equal(lamportsToSol(1n), '0.000000001');
  assert.equal(lamportsToSol(0n), '0');
});

test('a complete launch request is normalized', () => {
  const request = validateLaunchRequest(validBody());
  assert.equal(request.name, 'Route Coin');
  assert.equal(request.symbol, 'ROUTE');
  assert.equal(request.devBuyLamports, 0n);
  assert.deepEqual(request.recipients, [{ handle: 'jack', basisPoints: 6000 }, { handle: 'elonmusk', basisPoints: 4000 }]);
  assert.equal(request.image.ext, 'png');
  assert.equal(request.image.buffer.length, 70);
});

test('each invalid field names itself', () => {
  const field = body => { try { validateLaunchRequest(body); return null; } catch (error) { return error.field || error.message; } };
  assert.equal(field(validBody({ name: 'x'.repeat(33) })), 'name');
  assert.equal(field(validBody({ name: 'ééééééééééééééééé' })), 'name'); // 34 bytes
  assert.equal(field(validBody({ symbol: 'TOO-LONG' })), 'ticker');
  assert.equal(field(validBody({ description: 'd'.repeat(501) })), 'description');
  assert.equal(field(validBody({ twitter: 'http://x.com/a' })), 'twitter');
  assert.equal(field(validBody({ devBuySol: '1.1234567891' })), 'devBuy');
  assert.equal(field(validBody({ wallet: 'not-a-key' })), 'wallet');
  assert.equal(field(validBody({ image: 'data:text/plain;base64,aGk=' })), 'image');
  assert.equal(field(validBody({ image: 'data:image/png;base64,aGk=' })), 'image');
  assert.equal(field(validBody({ recipients: [{ handle: 'jack', basisPoints: 5000 }] })), 'basket');
  assert.equal(field(validBody({ recipients: [{ handle: 'jack', basisPoints: 5000 }, { handle: '@JACK', basisPoints: 5000 }] })), 'handle-1');
  assert.equal(field(validBody({ recipients: [{ handle: 'jack', basisPoints: 10000.5 }] })), 'share-0');
  assert.equal(field(validBody({ recipients: [] })), 'basket');
});

test('recipient validation accepts links and rejects six people', () => {
  assert.deepEqual(validateRecipients([{ handle: 'https://twitter.com/Jack', basisPoints: 10000 }]), [{ handle: 'jack', basisPoints: 10000 }]);
  assert.throws(() => validateRecipients(Array.from({ length: 6 }, (_, i) => ({ handle: `user${i}`, basisPoints: 1666 }))), /one and five/);
});
