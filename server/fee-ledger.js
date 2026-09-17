// Only finalized, verified receipts enter this ledger. Display history may be
// trimmed; signature identities and lifetime credits must never be trimmed.
export function createFeeLedger({ store }) {
  let writes = Promise.resolve();
  const read = () => structuredClone(store.getMeta('fee-receipts', { version: 1, distributions: {}, withdrawals: {}, socialClaimed: null }));
  function update(fn) {
    const work = writes.catch(() => {}).then(async () => {
      const state = read();
      const result = fn(state);
      await store.setMeta('fee-receipts', state);
      return result;
    });
    writes = work;
    return work;
  }
  return {
    read,
    distribution(receipt) {
      return update(state => {
        if (state.distributions[receipt.signature]) return;
        state.distributions[receipt.signature] = { ...receipt, socialWithdrawn: false };
      });
    },
    baseline(totalClaimed) {
      if (read().socialClaimed === String(totalClaimed)) return Promise.resolve();
      return update(state => {
        if (state.socialClaimed === null) {
          if (BigInt(totalClaimed) > 0n && Object.values(state.distributions).some(row => !row.socialWithdrawn && BigInt(row.socialLamports) > 0n)) throw new Error('GitHub claim baseline must be established before collecting coin fees.');
          state.socialClaimed = String(totalClaimed);
        }
        if (state.socialClaimed !== String(totalClaimed)) throw new Error('An external GitHub withdrawal needs receipt reconciliation before automatic claims can continue.');
      });
    },
    withdrawal(receipt) {
      return update(state => {
        if (state.withdrawals[receipt.signature]) return;
        if (state.socialClaimed !== receipt.claimedBefore) throw new Error('GitHub claim history changed; reconciliation required.');
        const deposits = receipt.depositSignatures.map(signature => state.distributions[signature]);
        if (new Set(receipt.depositSignatures).size !== receipt.depositSignatures.length) throw new Error('Duplicate GitHub withdrawal deposit identities.');
        if (deposits.some((row, index) => !row || row.socialWithdrawn || row.slot > receipt.slot || (row.slot === receipt.slot && !receipt.sameSlotDeposits?.includes(receipt.depositSignatures[index])))) throw new Error('GitHub withdrawal deposit identities do not reconcile.');
        const tracked = deposits.reduce((sum, row) => sum + BigInt(row.socialLamports), 0n);
        if (tracked > BigInt(receipt.lamports)) throw new Error('GitHub withdrawal is smaller than its unsettled deposits; reconciliation required.');
        if (BigInt(receipt.claimedAfter) - BigInt(receipt.claimedBefore) !== BigInt(receipt.lamports)) throw new Error('GitHub lifetime claim amount does not reconcile.');
        const claimed = BigInt(receipt.lamports), received = BigInt(receipt.receivedLamports ?? receipt.lamports);
        if (claimed <= 0n || received < 0n || received > claimed) throw new Error('GitHub withdrawal received amount is invalid.');
        for (const row of deposits) {
          row.socialWithdrawn = true;
          row.socialReceivedLamports = String(BigInt(row.socialLamports) * received / claimed);
        }
        state.withdrawals[receipt.signature] = receipt;
        state.socialClaimed = receipt.claimedAfter;
      });
    },
    totals(mainCoin, treasury = null) {
      let buyback = 0n, socialPending = 0n, received = 0n;
      for (const row of Object.values(read().distributions)) {
        if (treasury && row.treasury !== treasury) continue;
        const direct = BigInt(row.treasuryLamports);
        const social = BigInt(row.socialLamports);
        const socialReceived = BigInt(row.socialReceivedLamports ?? row.socialLamports);
        received += direct + (row.socialWithdrawn ? socialReceived : 0n);
        // Main-coin allocation is fixed at collection time, never reassigned by
        // changing the main mint later. Other coins contribute their direct share.
        buyback += BigInt(row.buybackLamports);
        if (row.socialWithdrawn && row.mainCoin === row.mint && row.mint === mainCoin) buyback += socialReceived;
        if (!row.socialWithdrawn) socialPending += social;
      }
      return { buyback, received, socialPending };
    },
  };
}
