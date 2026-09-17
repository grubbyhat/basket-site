import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { PUMP_FEE_PROGRAM_ID } from '@pump-fun/pump-sdk';
import { GITHUB_PLATFORM, createGithubResolver, ensureSocialFeePda, githubFeePda, socialFeeState } from './github.js';

const response = (status, body) => ({ ok: status < 300, status, json: async () => body });

test('a GitHub username resolves to its numeric id and picture, cached', async () => {
  let calls = 0;
  const resolver = createGithubResolver({ fetchImpl: async url => { calls += 1; return url.endsWith('/gone') ? response(404, {}) : response(200, { id: 109759539, login: 'grubbyhat', avatar_url: 'https://avatars.githubusercontent.com/u/109759539?v=4' }); } });
  const profile = await resolver.lookup('@GrubbyHat');
  assert.deepEqual(profile, { id: '109759539', login: 'grubbyhat', avatarUrl: 'https://avatars.githubusercontent.com/u/109759539?v=4', name: '' });
  await resolver.lookup('grubbyhat');
  assert.equal(calls, 1);
  assert.equal(await resolver.lookup('gone'), null);
  assert.equal(await resolver.lookup('not a login!'), null);
  assert.equal(calls, 2);
});

test('the GitHub fee account is a pump fee-program PDA derived from the id', () => {
  const pda = githubFeePda('109759539');
  const [expected] = PublicKey.findProgramAddressSync([Buffer.from('social-fee-pda'), Buffer.from('109759539'), Buffer.from([GITHUB_PLATFORM])], PUMP_FEE_PROGRAM_ID);
  assert.equal(pda.toBase58(), expected.toBase58());
  assert.notEqual(githubFeePda('1').toBase58(), pda.toBase58());
});

test('a missing fee account is reported, and creation needs a payer', async () => {
  const connection = { async getAccountInfo() { return null; } };
  const state = await socialFeeState(connection, githubFeePda('1'));
  assert.deepEqual(state, { exists: false, lamports: 0n, unclaimedLamports: 0n, totalClaimedLamports: 0n });
  await assert.rejects(ensureSocialFeePda({ connection, payer: null, userId: '1' }), /no treasury key/);
  const sends = [];
  const payer = Keypair.generate();
  const created = await ensureSocialFeePda({ log: { info() {} }, payer, userId: '1', connection: { ...connection, async getLatestBlockhash() { return { blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', lastValidBlockHeight: 1 }; }, async sendRawTransaction(bytes) { sends.push(bytes.length); return 'Sig'; }, async confirmTransaction() { return { value: { err: null } }; } } });
  assert.equal(created.created, true);
  assert.equal(created.signature, 'Sig');
  assert.equal(sends.length, 1);
  assert.ok(sends[0] < 600, `create tx ${sends[0]} bytes`);
});
