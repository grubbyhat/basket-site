import { ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import BN from 'bn.js';
import nacl from 'tweetnacl';
import { HttpError } from './errors.js';

export const MAX_TRANSACTION_BYTES = 1232;
const CREATE_UNITS = 140_000;
const CREATE_AND_BUY_UNITS = 260_000;
const PRIORITY_MICRO_LAMPORTS = 100_000;
const STATE_TTL = 30_000;
const TABLE_TTL = 5 * 60_000;
const CONFIRM_WINDOW_MS = 120_000;
const CONFIRM_POLL_MS = 2_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function describeSimulationError(value) {
  const logs = (value?.logs || []).join('\n');
  const error = JSON.stringify(value?.err ?? null);
  if (/insufficient lamports|InsufficientFundsForFee|AccountNotFound|insufficient funds/i.test(`${logs}\n${error}`)) {
    return 'Your wallet needs more SOL to cover this launch.';
  }
  return `pump.fun rejected this launch in simulation (${error}).`;
}

// Builds, checks and sends Route launches. The connected wallet pays and signs;
// the mint keypair signs here and is discarded; the treasury is the coin creator.
export function createLaunchEngine({ connection, treasury, lookupTable = null, now = Date.now }) {
  let state = null;
  let table = null;

  async function pumpState() {
    if (state && now() - state.at < STATE_TTL) return state;
    const online = new OnlinePumpSdk(connection);
    const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
    state = { global, feeConfig, at: now() };
    return state;
  }

  async function lookupTableAccount() {
    if (!lookupTable) return null;
    if (table && now() - table.at < TABLE_TTL) return table.account;
    const { value } = await connection.getAddressLookupTable(lookupTable);
    if (!value) throw new HttpError('The Route lookup table is missing on-chain.', 503);
    table = { account: value, at: now() };
    return value;
  }

  function instructionsFor({ global, feeConfig, mint, name, symbol, uri, user, lamports }) {
    if (lamports.gtn(0)) {
      const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: lamports, quoteMint: PublicKey.default });
      if (amount.lten(0)) throw new HttpError('This dev buy is too small to buy any tokens.', 400, { field: 'devBuy' });
      return PUMP_SDK.createV2AndBuyInstructions({ global, mint: mint.publicKey, name, symbol, uri, creator: treasury, user, amount, solAmount: lamports, mayhemMode: false });
    }
    return PUMP_SDK.createV2Instruction({ mint: mint.publicKey, name, symbol, uri, creator: treasury, user, mayhemMode: false }).then(ix => [ix]);
  }

  async function compile({ mint, name, symbol, uri, user, devBuyLamports, blockhash, tableAccount = null }) {
    const { global, feeConfig } = await pumpState();
    if (!global.createV2Enabled) throw new HttpError('pump.fun is not accepting new coins right now.', 503);
    const lamports = new BN(String(devBuyLamports));
    const instructions = await instructionsFor({ global, feeConfig, mint, name, symbol, uri, user, lamports });
    const message = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: lamports.gtn(0) ? CREATE_AND_BUY_UNITS : CREATE_UNITS }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO_LAMPORTS }),
        ...instructions,
      ],
    }).compileToV0Message(tableAccount ? [tableAccount] : []);
    const transaction = new VersionedTransaction(message);
    transaction.sign([mint]);
    return { transaction, bytes: transaction.serialize() };
  }

  async function build({ mint, name, symbol, uri, user, devBuyLamports }) {
    if (!treasury) throw new HttpError('Launches are not configured yet: the Route treasury is missing.', 503);
    const userKey = new PublicKey(user);
    const lamports = BigInt(devBuyLamports);
    const tableAccount = await lookupTableAccount();
    if (lamports > 0n && !tableAccount) throw new HttpError('Dev buys are not enabled yet. Launch without a dev buy for now.', 503, { field: 'devBuy' });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const { transaction, bytes } = await compile({ mint, name, symbol, uri, user: userKey, devBuyLamports: lamports, blockhash, tableAccount });
    if (bytes.length > MAX_TRANSACTION_BYTES) throw new HttpError('This launch does not fit in one transaction. Shorten the name or launch without a dev buy.', 400);
    const simulation = await connection.simulateTransaction(transaction, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
    if (simulation.value.err) throw new HttpError(describeSimulationError(simulation.value), 400, { logs: simulation.value.logs });
    return {
      mint: mint.publicKey.toBase58(),
      transaction: Buffer.from(bytes).toString('base64'),
      message: Buffer.from(transaction.message.serialize()).toString('base64'),
      blockhash,
      lastValidBlockHeight,
      size: bytes.length,
      unitsConsumed: simulation.value.unitsConsumed ?? null,
    };
  }

  // The signed bytes must carry exactly the prepared message, with every required
  // signature present and valid, before anything is broadcast.
  function verifySigned({ signedTransaction, message }) {
    let signed;
    try { signed = VersionedTransaction.deserialize(Buffer.from(String(signedTransaction || ''), 'base64')); }
    catch { throw new HttpError('The signed transaction could not be read.', 400); }
    if (Buffer.from(signed.message.serialize()).toString('base64') !== message) throw new HttpError('The signed transaction does not match the prepared launch.', 400);
    const required = signed.message.header.numRequiredSignatures;
    const keys = signed.message.staticAccountKeys;
    const messageBytes = signed.message.serialize();
    for (let index = 0; index < required; index += 1) {
      const signature = signed.signatures[index];
      if (!signature || signature.every(byte => byte === 0) || !nacl.sign.detached.verify(messageBytes, signature, keys[index].toBytes())) {
        throw new HttpError(index === 0 ? 'Your wallet did not sign the launch.' : 'The launch is missing a required signature.', 400);
      }
    }
    return signed;
  }

  async function send(signed) {
    return connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 2 });
  }

  // One bounded status check per launch, started by the user's own send.
  async function confirm({ signature, lastValidBlockHeight }) {
    const deadline = now() + CONFIRM_WINDOW_MS;
    while (now() < deadline) {
      const { value: [status] } = await connection.getSignatureStatuses([signature]);
      if (status?.err) return { status: 'failed', error: JSON.stringify(status.err), slot: status.slot };
      if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus)) return { status: 'confirmed', slot: status.slot };
      if (!status && (await connection.getBlockHeight('confirmed')) > lastValidBlockHeight) return { status: 'failed', error: 'expired' };
      await sleep(CONFIRM_POLL_MS);
    }
    return { status: 'unknown' };
  }

  return {
    get devBuysEnabled() { return Boolean(treasury && lookupTable); },
    newMint: () => Keypair.generate(),
    pumpState, compile, build, verifySigned, send, confirm,
  };
}
