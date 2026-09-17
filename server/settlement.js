import bs58 from 'bs58';

// Persist the signed transaction's identity BEFORE broadcasting. A timeout leaves
// the lane occupied until that same signature is settled or finalized expiry is
// proved. Never rebuild a pending payment with another blockhash.
export function createSettlement({ connection, store, key }) {
  let busy = false;
  const pending = () => store.getMeta(key, null);

  async function reconcile(settle, settleFailure) {
    const attempt = pending();
    if (!attempt) return null;
    const details = await connection.getTransaction(attempt.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (details?.meta) {
      if (!details.meta.err) await settle(attempt, details);
      else if (settleFailure) await settleFailure(attempt, details);
      await store.setMeta(key, null);
      if (details.meta.err) throw new Error(`Transaction failed on-chain: ${attempt.signature}`);
      return { signature: attempt.signature, settled: true };
    }
    const { value } = await connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true });
    const status = value[0];
    // Even a failed transaction needs metadata: it may have charged a fee.
    // A landed transaction with temporarily unavailable metadata is still pending.
    if (!status) {
      const valid = await connection.isBlockhashValid(attempt.blockhash, 'finalized');
      if (valid.value === false) {
        await store.setMeta(key, null);
        return { expired: true, signature: attempt.signature };
      }
    }
    return { pending: true, signature: attempt.signature };
  }

  async function execute({ build, settle, settleFailure }) {
    if (busy) return { skipped: 'busy' };
    busy = true;
    try {
      // Always finish recovery on a separate invocation, including an expired send.
      if (pending()) return await reconcile(settle, settleFailure);
      const prepared = await build();
      if (!prepared?.transaction) return prepared;
      const { transaction, lastValidBlockHeight = null, context = {} } = prepared;
      const signature = bs58.encode(transaction.signatures[0]);
      if (!transaction.signatures[0].some(Boolean)) throw new Error('Transaction is not signed.');
      const attempt = { signature, blockhash: transaction.message.recentBlockhash, lastValidBlockHeight, context, at: new Date().toISOString() };
      await store.setMeta(key, attempt);
      try {
        const returned = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 2 });
        if (returned !== signature) throw new Error('RPC returned a different transaction signature.');
        if (lastValidBlockHeight !== null) {
          await connection.confirmTransaction({ signature, blockhash: attempt.blockhash, lastValidBlockHeight }, 'finalized');
        }
      } catch {
        // Acceptance may have happened even when the RPC returned an error.
        // Reconcile using the original identity; never fall through to a backup.
      }
      return await reconcile(settle, settleFailure);
    } finally { busy = false; }
  }
  return { execute, pending };
}

export function accountKeys(details) {
  const message = details.transaction.message;
  if (message.getAccountKeys) {
    const keys = message.getAccountKeys({ accountKeysFromLookups: details.meta.loadedAddresses });
    return Array.from({ length: keys.length }, (_, index) => keys.get(index));
  }
  return message.accountKeys;
}

export function solDelta(details, address) {
  const index = accountKeys(details).findIndex(key => key.toBase58() === String(address));
  if (index < 0) throw new Error(`Receipt does not contain ${address}.`);
  return BigInt(details.meta.postBalances[index]) - BigInt(details.meta.preBalances[index]);
}

export function solBefore(details, address) {
  const index = accountKeys(details).findIndex(key => key.toBase58() === String(address));
  if (index < 0) throw new Error('Receipt does not contain the expected wallet.');
  return BigInt(details.meta.preBalances[index]);
}

export function tokenDelta(details, owner, mint) {
  const total = entries => (entries || []).filter(entry => entry.owner === String(owner) && entry.mint === String(mint))
    .reduce((sum, entry) => sum + BigInt(entry.uiTokenAmount.amount), 0n);
  return total(details.meta.postTokenBalances) - total(details.meta.preTokenBalances);
}
