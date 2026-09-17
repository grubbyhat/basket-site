// PumpPortal's local trade API as a backup buy path: it returns an unsigned
// transaction for our key to sign and send. Build-only probes from this machine
// answered 400 Bad Request on 2026-09-17, so this path is unverified until it
// is exercised with the live treasury.
import { VersionedTransaction } from '@solana/web3.js';

export async function buildPumpPortalBuy({ publicKey, mint, sol, slippagePercent = 10, priorityFeeSol = 0.0005, pool = 'auto', fetchImpl = fetch }) {
  const response = await fetchImpl('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'route-site' },
    body: JSON.stringify({ publicKey, action: 'buy', mint, amount: sol, denominatedInSol: 'true', slippage: slippagePercent, priorityFee: priorityFeeSol, pool }),
    signal: AbortSignal.timeout(15000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`PumpPortal ${response.status}: ${bytes.toString('utf8').slice(0, 160)}`);
  const transaction = VersionedTransaction.deserialize(bytes);
  const payer = transaction.message.staticAccountKeys[0].toBase58();
  if (payer !== publicKey) throw new Error(`PumpPortal built a transaction for ${payer}, not the treasury.`);
  return transaction;
}
