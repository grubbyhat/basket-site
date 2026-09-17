import { ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import BN from 'bn.js';
import nacl from 'tweetnacl';
import { HttpError } from './errors.js';
import { compileRoute } from './fee-share.js';

export const MAX_TRANSACTION_BYTES = 1232;
const CREATE_UNITS = 140_000;
const CREATE_AND_BUY_UNITS = 260_000;
const PRIORITY_MICRO_LAMPORTS = 100_000;
const STATE_TTL = 30_000;
const TABLE_TTL = 5 * 60_000;
const CONFIRM_WINDOW_MS = 120_000;
const CONFIRM_POLL_MS = 2_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const base64 = bytes => Buffer.from(bytes).toString('base64');

export function describeSimulationError(value) {
  const logs = (value?.logs || []).join('\n');
  const error = JSON.stringify(value?.err ?? null);
  if (/insufficient lamports|InsufficientFundsForFee|AccountNotFound|insufficient funds/i.test(`${logs}\n${error}`)) {
    return 'Your wallet needs more SOL to cover this launch.';
  }
  const anchor = /Error Message: ([^.]+)\./.exec(logs);
  return `pump.fun rejected this in simulation (${anchor ? anchor[1] : error}).`;
}

// Builds, checks and sends Route transactions. The connected wallet pays and
// signs; the mint keypair signs the create here and is discarded; the treasury is
// the single shareholder of every coin's fee-sharing config.
export function createLaunchEngine({ connection, treasury, shareholder = null, buybackShareBps = 0, lookupTable = null, now = Date.now }) {
  let current = shareholder;
  const recipient = () => current || treasury;
  // Route's GitHub account takes the recipients' share; the treasury takes the
  // buyback share. Without a GitHub account the treasury takes everything.
  const shareholders = () => (current && !current.equals(treasury) && buybackShareBps > 0
    ? [{ address: current, shareBps: 10000 - buybackShareBps }, { address: treasury, shareBps: buybackShareBps }]
    : [{ address: recipient(), shareBps: 10000 }]);
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
      return PUMP_SDK.createV2AndBuyInstructions({ global, mint: mint.publicKey, name, symbol, uri, creator: user, user, amount, solAmount: lamports, mayhemMode: false });
    }
    return PUMP_SDK.createV2Instruction({ mint: mint.publicKey, name, symbol, uri, creator: user, user, mayhemMode: false }).then(ix => [ix]);
  }

  // The create transaction: the wallet is creator and payer, the mint co-signs.
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

  async function simulate(transaction, what = 'launch') {
    const simulation = await connection.simulateTransaction(transaction, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
    if (simulation.value.err) throw new HttpError(describeSimulationError(simulation.value).replace('this launch', `this ${what}`), 400, { logs: simulation.value.logs });
    return simulation.value.unitsConsumed ?? null;
  }

  const packed = ({ transaction, bytes }) => ({ transaction: base64(bytes), message: base64(transaction.message.serialize()), size: bytes.length });

  // A launch is two transactions with one blockhash: create the coin, then put
  // its fees on Route. The second cannot be simulated before the first lands.
  async function build({ mint, name, symbol, uri, user, devBuyLamports }) {
    if (!treasury) throw new HttpError('Launches are not configured yet: the Route treasury is missing.', 503);
    const userKey = new PublicKey(user);
    const lamports = BigInt(devBuyLamports);
    const tableAccount = await lookupTableAccount();
    if (lamports > 0n && !tableAccount) throw new HttpError('Dev buys are not enabled yet. Launch without a dev buy for now.', 503, { field: 'devBuy' });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const create = await compile({ mint, name, symbol, uri, user: userKey, devBuyLamports: lamports, blockhash, tableAccount });
    if (create.bytes.length > MAX_TRANSACTION_BYTES) throw new HttpError('This launch does not fit in one transaction. Shorten the name or launch without a dev buy.', 400);
    const unitsConsumed = await simulate(create.transaction);
    const route = await compileRoute({ mint: mint.publicKey, creator: userKey, shareholders: shareholders(), graduated: false, blockhash });
    return { mint: mint.publicKey.toBase58(), create: packed(create), route: packed(route), blockhash, lastValidBlockHeight, unitsConsumed };
  }

  // The fee-route transaction alone, for a coin that already exists.
  async function buildRoute({ mint, creator, graduated }) {
    if (!treasury) throw new HttpError('Registration is not configured yet: the Route treasury is missing.', 503);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const route = await compileRoute({ mint: new PublicKey(mint), creator: new PublicKey(creator), shareholders: shareholders(), graduated, blockhash });
    const unitsConsumed = await simulate(route.transaction, 'registration');
    return { ...packed(route), blockhash, lastValidBlockHeight, unitsConsumed };
  }

  // The signed bytes must carry exactly the prepared message, with every required
  // signature present and valid, before anything is broadcast.
  function verifySigned({ signedTransaction, message }) {
    let signed;
    try { signed = VersionedTransaction.deserialize(Buffer.from(String(signedTransaction || ''), 'base64')); }
    catch { throw new HttpError('The signed transaction could not be read.', 400); }
    if (base64(signed.message.serialize()) !== message) throw new HttpError('The signed transaction does not match the prepared one.', 400);
    const required = signed.message.header.numRequiredSignatures;
    const keys = signed.message.staticAccountKeys;
    const messageBytes = signed.message.serialize();
    for (let index = 0; index < required; index += 1) {
      const signature = signed.signatures[index];
      if (!signature || signature.every(byte => byte === 0) || !nacl.sign.detached.verify(messageBytes, signature, keys[index].toBytes())) {
        throw new HttpError(index === 0 ? 'Your wallet did not sign the transaction.' : 'The transaction is missing a required signature.', 400);
      }
    }
    return signed;
  }

  async function send(signed) {
    return connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 2 });
  }

  // One bounded status check per transaction, started by the user's own send.
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
    get shareholder() { return recipient(); },
    get shareholders() { return shareholders(); },
    get allowedShareholders() { return [treasury, current].filter(Boolean); },
    async balance() { return treasury ? String(await connection.getBalance(treasury, 'confirmed')) : null; },
    setShareholder(next) { current = next; },
    newMint: () => Keypair.generate(),
    pumpState, compile, simulate, build, buildRoute, verifySigned, send, confirm,
  };
}
