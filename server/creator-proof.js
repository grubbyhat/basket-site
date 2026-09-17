import { PublicKey } from '@solana/web3.js';
import { PUMP_SDK, PUMP_PROGRAM_ID } from '@pump-fun/pump-sdk';
import bs58 from 'bs58';
import { accountKeys } from './settlement.js';

// Fee-sharing admins/curve creators can be changed. Verify the actual create
// instruction and its signer, rather than trusting today's admin or a form field.
export function creationFromTransaction(details, mint) {
  if (!details?.meta || details.meta.err) return null;
  const keys = accountKeys(details);
  const message = details.transaction.message;
  const instructions = [ ...(message.compiledInstructions || message.instructions || []),
    ...(details.meta.innerInstructions || []).flatMap(group => group.instructions) ];
  for (const ix of instructions) {
    if (!keys[ix.programIdIndex]?.equals(PUMP_PROGRAM_ID)) continue;
    const decoded = PUMP_SDK.offlinePumpProgram.coder.instruction.decode(typeof ix.data === 'string' ? bs58.decode(ix.data) : Buffer.from(ix.data));
    if (!decoded || !['create', 'createV2'].includes(decoded.name)) continue;
    const definition = PUMP_SDK.offlinePumpProgram.idl.instructions.find(row => row.name === decoded.name);
    const indexes = ix.accountKeyIndexes || ix.accounts;
    const get = name => keys[indexes[definition.accounts.findIndex(row => row.name === name)]];
    if (get('mint')?.toBase58() !== mint) continue;
    const user = get('user');
    const creator = decoded.data.creator;
    const signers = keys.slice(0, message.header.numRequiredSignatures);
    if (!user || !creator || !user.equals(creator) || !signers.some(key => key.equals(user))) throw new Error('Main token was not created and signed by the same developer wallet.');
    return { mint, creator: creator.toBase58(), slot: details.slot };
  }
  return null;
}

export function createCreatorVerifier({ connection, store }) {
  return async function verify(mint, wallet) {
    const key = `creator-${new PublicKey(mint).toBuffer().toString('hex')}`;
    const cached = store.getMeta(key);
    if (cached?.mint === mint && cached.creator === wallet) return cached;
    if (cached?.mint === mint) throw new Error(`Buyback wallet must be the token's creation wallet ${cached.creator}.`);
    if (!await connection.getAccountInfo(new PublicKey(mint), 'finalized')) throw new Error('Main token has not been created on-chain yet.');
    let before, oldest = [], complete = false;
    for (let page = 0; page < 20; page++) {
      const signatures = await connection.getSignaturesForAddress(new PublicKey(mint), { limit: 1000, ...(before ? { before } : {}) }, 'finalized');
      oldest = [...oldest, ...signatures].slice(-20);
      if (signatures.length < 1000) { complete = true; break; }
      before = signatures.at(-1).signature;
    }
    if (complete) {
      // Fetch transaction bodies only at the creation end of the address history.
      for (const row of [...oldest].reverse()) {
        if (row.err) continue;
        const details = await connection.getTransaction(row.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
        const proof = creationFromTransaction(details, mint);
        if (!proof) continue;
        await store.setMeta(key, { ...proof, signature: row.signature });
        if (proof.creator !== wallet) throw new Error(`Buyback wallet must be the token's creation wallet ${proof.creator}.`);
        return { ...proof, signature: row.signature };
      }
    }
    throw new Error('The main token creation transaction could not be verified; buybacks remain blocked.');
  };
}
