import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { feeEvents } from './pump-events.js';
import { solDelta } from './settlement.js';

const nativeQuote = key => key.equals(PublicKey.default) || key.equals(NATIVE_MINT);

// Called only with finalized transaction metadata. Ordinary transfers, log text,
// claims for another GitHub identity, and stablecoin claims are not SOL receipts.
export function socialClaimReceipt({ signature, details, github, recipient }) {
  if (!details?.meta || details.meta.err) return null;
  if (details.transaction.signatures?.[0] && details.transaction.signatures[0] !== signature) throw new Error('GitHub claim transaction identity does not match its receipt.');
  const events = feeEvents(details);
  const claims = events.filter(row => row.name === 'socialFeePdaClaimed' && row.data.userId === github.id && row.data.platform === 2 && row.data.socialFeePda.equals(github.pda) && nativeQuote(row.data.quoteMint) && BigInt(row.data.amountClaimed.toString()) > 0n);
  if (!claims.length) return null;
  if (claims.length !== 1) throw new Error('Multiple SOL withdrawals in one transaction need reconciliation.');
  const event = claims[0].data, amount = BigInt(event.amountClaimed.toString());
  const after = BigInt(event.lifetimeClaimed.toString()), before = after - amount;
  const deposited = events.filter(row => row.name === 'distributeCreatorFeesEvent' && nativeQuote(row.data.quoteMint)).reduce((sum, row) => sum + row.data.shareholders.filter(holder => holder.address.equals(github.pda)).reduce((value, holder) => value + BigInt(row.data.distributed.toString()) * BigInt(holder.shareBps) / 10000n, 0n), 0n);
  if (before < 0n || solDelta(details, github.pda) !== deposited - amount || BigInt(event.recipientBalanceAfter.toString()) - BigInt(event.recipientBalanceBefore.toString()) !== amount) throw new Error('GitHub claim event does not match the actual SOL withdrawal.');
  const recipientMatches = event.recipient.equals(recipient);
  const delta = recipientMatches ? solDelta(details, recipient) : 0n;
  // Network fees, rent, and any SOL spent in the same manual transaction are not
  // credited. Extra unrelated incoming SOL cannot increase the claim's credit.
  const received = delta < 0n ? 0n : delta > amount ? amount : delta;
  return { signature, slot: details.slot, lamports: String(amount), receivedLamports: String(received), claimedBefore: String(before), claimedAfter: String(after), recipient: event.recipient.toBase58(), recipientMatches, source: 'manual', at: details.blockTime ? new Date(details.blockTime * 1000).toISOString() : new Date().toISOString() };
}

export async function depositsForClaim({ connection, feeLedger, receipt }) {
  const rows = Object.entries(feeLedger.read().distributions).filter(([, row]) => !row.socialWithdrawn && BigInt(row.socialLamports) > 0n);
  const depositSignatures = [], sameSlotDeposits = [];
  let signatures;
  for (const [id, row] of rows) {
    if (!Number.isSafeInteger(row.slot)) throw new Error('A fee deposit is missing its confirmed slot.');
    if (row.slot > receipt.slot) continue;
    if (row.slot === receipt.slot) {
      signatures ??= (await connection.getBlockSignatures(receipt.slot, 'finalized'))?.signatures;
      const claimIndex = signatures?.indexOf(receipt.signature) ?? -1;
      const depositIndex = signatures?.indexOf(row.signature) ?? -1;
      if (claimIndex < 0 || depositIndex < 0) throw new Error('Same-block GitHub claim ordering is not available yet.');
      if (depositIndex >= claimIndex) continue;
      sameSlotDeposits.push(id);
    }
    depositSignatures.push(id);
  }
  return { depositSignatures, sameSlotDeposits };
}

export function createManualClaimReconciler({ connection, store, feeLedger, github, recipient, pageSize = 40 }) {
  const key = 'github-withdrawal-scan';
  const identity = github && recipient ? `${github.pda}:${recipient}` : null;
  const chain = scan => {
    const receipts = Object.values(scan.receipts).sort((a, b) => BigInt(a.claimedAfter) < BigInt(b.claimedAfter) ? -1 : 1);
    let cursor = scan.base;
    for (const receipt of receipts) {
      if (receipt.claimedBefore !== cursor) return null;
      cursor = receipt.claimedAfter;
    }
    return cursor === scan.target ? receipts : null;
  };

  return async function reconcile(totalClaimed) {
    const total = String(totalClaimed), base = feeLedger.read().socialClaimed;
    if (base === null || base === total) {
      await feeLedger.baseline(total);
      if (store.getMeta(key)) await store.setMeta(key, null);
      return { imported: [] };
    }
    if (BigInt(total) < BigInt(base)) throw new Error('Finalized GitHub claim history is behind the saved receipt ledger.');
    let scan = structuredClone(store.getMeta(key));
    // A completed receipt may have committed immediately before a restart.
    // Starting again from the updated ledger cannot credit that receipt twice.
    if (!scan || scan.base !== base || scan.identity !== identity) scan = { identity, base, target: total, before: null, receipts: {} };
    let receipts = chain(scan);
    if (!receipts) {
      const page = await connection.getSignaturesForAddress(github.pda, { limit: pageSize, ...(scan.before ? { before: scan.before } : {}) }, 'finalized');
      if (!page.length) {
        // Account state can be ahead of an RPC's signature index. Retry from the
        // head next time rather than getting stuck behind a temporarily missing claim.
        await store.setMeta(key, null);
        throw new Error('GitHub withdrawal history is incomplete; no unverified funds were credited.');
      }
      // Keep recovery work bounded per sweep and preserve its cursor on disk.
      for (let start = 0; start < page.length; start += 5) {
        const batch = page.slice(start, start + 5);
        const results = await Promise.allSettled(batch.map(row => row.err ? null : connection.getTransaction(row.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })));
        for (let index = 0; index < batch.length; index++) {
          const row = batch[index], result = results[index];
          if (!row.err && (result.status !== 'fulfilled' || !result.value?.meta)) {
            await store.setMeta(key, scan);
            return { pending: true, imported: [] };
          }
          if (!row.err) {
            const receipt = socialClaimReceipt({ signature: row.signature, details: result.value, github, recipient });
            if (receipt && BigInt(receipt.claimedAfter) > BigInt(base) && BigInt(receipt.claimedAfter) <= BigInt(scan.target)) scan.receipts[receipt.signature] = receipt;
          }
          scan.before = row.signature;
          receipts = chain(scan);
          if (receipts) break;
        }
        await store.setMeta(key, scan);
        if (receipts) break;
      }
    }
    if (!receipts) return { pending: true, imported: [] };
    for (const receipt of receipts) {
      const deposits = await depositsForClaim({ connection, feeLedger, receipt });
      await feeLedger.withdrawal({ ...receipt, ...deposits });
    }
    await store.setMeta(key, null);
    return { imported: receipts, pending: scan.target !== total };
  };
}
