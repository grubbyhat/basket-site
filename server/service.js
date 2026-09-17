import { HttpError } from './errors.js';
import { saveTokenMedia } from './media.js';
import { lamportsToSol, validateLaunchRequest } from './validate.js';

export function publicLaunch(record) {
  if (!record) return null;
  const { message, blockhash, ...rest } = record;
  return { ...rest, pumpUrl: `https://pump.fun/coin/${record.mint}` };
}

// Orchestrates a launch: validate, verify every recipient on X, host the
// metadata, build the transaction, then broadcast the wallet's signature and
// track the outcome. Records never hold keys or signed packets.
export function createLaunchService({ store, engine, xLookup, dataDir, origin, treasury, log = console }) {
  const tracking = new Map();

  async function prepare(body) {
    const request = validateLaunchRequest(body);
    let profiles;
    try { profiles = await Promise.all(request.recipients.map(recipient => xLookup.lookup(recipient.handle))); }
    catch (error) { throw new HttpError(`We could not verify your recipients on X right now (${error.message}). Try again in a moment.`, 502); }
    const missingIndex = profiles.findIndex(profile => !profile);
    if (missingIndex !== -1) throw new HttpError(`We couldn't find @${request.recipients[missingIndex].handle} on X.`, 400, { field: `handle-${missingIndex}` });
    const recipients = request.recipients.map((recipient, index) => ({ handle: profiles[index].handle, basisPoints: recipient.basisPoints, xId: profiles[index].id, name: profiles[index].name, avatarUrl: profiles[index].avatarUrl }));
    const mint = engine.newMint();
    const mintAddress = mint.publicKey.toBase58();
    const media = await saveTokenMedia(dataDir, origin, { mint: mintAddress, image: request.image, name: request.name, symbol: request.symbol, description: request.description, twitter: request.twitter, recipients });
    const built = await engine.build({ mint, name: request.name, symbol: request.symbol, uri: media.metadataUri, user: request.wallet, devBuyLamports: request.devBuyLamports });
    const record = await store.create({
      mint: mintAddress,
      status: 'prepared',
      name: request.name, symbol: request.symbol, description: request.description, twitter: request.twitter,
      website: `${origin}/`, imageUrl: media.imageUrl, metadataUri: media.metadataUri,
      devBuySol: lamportsToSol(request.devBuyLamports),
      wallet: request.wallet,
      creator: treasury.toBase58(),
      recipients,
      message: built.message, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight,
      transactionBytes: built.size, unitsConsumed: built.unitsConsumed,
    });
    log.info(`[launch] prepared ${mintAddress} for ${request.wallet} (${built.size} bytes, ${recipients.length} recipients)`);
    return { mint: record.mint, transaction: built.transaction, lastValidBlockHeight: built.lastValidBlockHeight };
  }

  async function send(body) {
    const mint = String(body?.mint || '');
    const record = store.get(mint);
    if (!record) throw new HttpError('This launch was not prepared here.', 404);
    if (record.status !== 'prepared') throw new HttpError(`This launch was already ${record.status}.`, 409);
    const signed = engine.verifySigned({ signedTransaction: body?.signedTransaction, message: record.message });
    await store.update(mint, { status: 'sending', signingWallet: signed.message.staticAccountKeys[0].toBase58() });
    let signature;
    try { signature = await engine.send(signed); }
    catch (error) {
      const detail = error?.transactionMessage || error?.message || String(error);
      const logs = Array.isArray(error?.transactionLogs) ? error.transactionLogs : [];
      await store.update(mint, { status: 'failed', error: `send: ${detail}`, logs: logs.slice(-12) });
      log.warn(`[launch] send failed for ${mint}: ${detail}`);
      throw new HttpError(/insufficient|AccountNotFound|no record of a prior credit/i.test(`${detail}\n${logs.join('\n')}`) ? 'Your wallet needs more SOL to cover this launch.' : 'The network did not accept the launch. Nothing was charged.', 502);
    }
    const sent = await store.update(mint, { status: 'sent', signature, sentAt: new Date().toISOString() });
    log.info(`[launch] sent ${mint} ${signature}`);
    track(sent);
    return { mint, signature };
  }

  function track(record) {
    if (tracking.has(record.mint)) return tracking.get(record.mint);
    const job = engine.confirm({ signature: record.signature, lastValidBlockHeight: record.lastValidBlockHeight })
      .then(async outcome => {
        const patch = { status: outcome.status, slot: outcome.slot ?? null };
        if (outcome.status === 'confirmed') patch.confirmedAt = new Date().toISOString();
        if (outcome.status === 'failed') patch.error = outcome.error;
        await store.update(record.mint, patch);
        log.info(`[launch] ${record.mint} ${outcome.status}${outcome.error ? ` (${outcome.error})` : ''}`);
      })
      .catch(error => log.error(`[launch] tracking ${record.mint} failed: ${error.message}`))
      .finally(() => tracking.delete(record.mint));
    tracking.set(record.mint, job);
    return job;
  }

  function recover() {
    for (const record of [...store.list({ status: 'sent', limit: 200 }), ...store.list({ status: 'unknown', limit: 200 })]) {
      if (record.signature) track(record);
    }
  }

  return { prepare, send, track, recover };
}
