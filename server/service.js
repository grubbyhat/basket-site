import { HttpError } from './errors.js';
import { inspectCoin, parseMint } from './fee-share.js';
import { saveTokenMedia } from './media.js';
import { lamportsToSol, validateLaunchRequest, validateRecipients } from './validate.js';

export function publicLaunch(record) {
  if (!record) return null;
  const { messages, blockhash, ...rest } = record;
  return { ...rest, pumpUrl: `https://pump.fun/coin/${record.mint}` };
}

// Orchestrates launches and registrations: validate, verify every recipient on
// X, host metadata, build transactions, broadcast the wallet's signatures and
// track outcomes. Records never hold keys or signed packets.
export function createLaunchService({ store, engine, xLookup, dataDir, origin, treasury, watcher = null, log = console, connection = null }) {
  const shareholder = () => engine.shareholder || treasury;
  const sharesOf = list => { const treasuryBps = (list || []).filter(entry => (entry.address.toBase58 ? entry.address.toBase58() : entry.address) === treasury.toBase58()).reduce((sum, entry) => sum + entry.shareBps, 0); return { treasuryBps, othersBps: 10000 - treasuryBps }; };
  const inspectOptions = () => ({ connection, shareholder: shareholder(), allowed: engine.allowedShareholders || [treasury, shareholder()] });
  const tracking = new Map();
  const pendingRoutes = new Map();

  async function verifiedRecipients(input) {
    const recipients = validateRecipients(input);
    let profiles;
    try { profiles = await Promise.all(recipients.map(recipient => xLookup.lookup(recipient.handle))); }
    catch (error) { throw new HttpError(`We could not verify your recipients on X right now (${error.message}). Try again in a moment.`, 502); }
    const missingIndex = profiles.findIndex(profile => !profile);
    if (missingIndex !== -1) throw new HttpError(`We couldn't find @${recipients[missingIndex].handle} on X.`, 400, { field: `handle-${missingIndex}` });
    return recipients.map((recipient, index) => ({ handle: profiles[index].handle, basisPoints: recipient.basisPoints, xId: profiles[index].id, name: profiles[index].name, avatarUrl: profiles[index].avatarUrl }));
  }

  const emptyFees = () => ({ distributedLamports: '0', claims: [] });

  async function prepare(body) {
    const request = validateLaunchRequest(body);
    const recipients = await verifiedRecipients(request.recipients);
    const mint = engine.newMint();
    const mintAddress = mint.publicKey.toBase58();
    const media = await saveTokenMedia(dataDir, origin, { mint: mintAddress, image: request.image, name: request.name, symbol: request.symbol, description: request.description, twitter: request.twitter, recipients });
    const built = await engine.build({ mint, name: request.name, symbol: request.symbol, uri: media.metadataUri, user: request.wallet, devBuyLamports: request.devBuyLamports });
    await store.create({
      mint: mintAddress, kind: 'launch', status: 'prepared',
      name: request.name, symbol: request.symbol, description: request.description, twitter: request.twitter,
      website: `${origin}/`, imageUrl: media.imageUrl, metadataUri: media.metadataUri,
      devBuySol: lamportsToSol(request.devBuyLamports),
      wallet: request.wallet, treasury: treasury.toBase58(), shareholder: shareholder().toBase58(), shares: sharesOf(engine.shareholders), recipients,
      route: { status: 'pending' }, fees: emptyFees(),
      messages: { create: built.create.message, route: built.route.message },
      blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight,
      transactionBytes: built.create.size, unitsConsumed: built.unitsConsumed,
    });
    log.info(`[launch] prepared ${mintAddress} for ${request.wallet} (${built.create.size} + ${built.route.size} bytes, ${recipients.length} recipients)`);
    return { mint: mintAddress, transactions: [built.create.transaction, built.route.transaction], lastValidBlockHeight: built.lastValidBlockHeight };
  }

  function sendFailure(error) {
    const detail = error?.transactionMessage || error?.message || String(error);
    const logs = Array.isArray(error?.transactionLogs) ? error.transactionLogs : [];
    const friendly = /insufficient|AccountNotFound|no record of a prior credit/i.test(`${detail}\n${logs.join('\n')}`) ? 'Your wallet needs more SOL to cover this.' : /Blockhash not found|block height exceeded/i.test(detail) ? 'This transaction expired before it was sent. Prepare it again.' : 'The network did not accept the transaction. Nothing was charged.';
    return { detail, logs: logs.slice(-12), friendly };
  }

  async function send(body) {
    const mint = String(body?.mint || '');
    const record = store.get(mint);
    if (!record) throw new HttpError('This launch was not prepared here.', 404);
    if (record.kind !== 'launch') throw new HttpError('Use the registration flow for this coin.', 400);
    if (record.status !== 'prepared') throw new HttpError(`This launch was already ${record.status}.`, 409);
    const signed = Array.isArray(body?.signedTransactions) ? body.signedTransactions : [];
    if (signed.length !== 2) throw new HttpError('Sign both launch transactions.', 400);
    const create = engine.verifySigned({ signedTransaction: signed[0], message: record.messages.create });
    const route = engine.verifySigned({ signedTransaction: signed[1], message: record.messages.route });
    await store.update(mint, { status: 'sending' });
    let signature;
    try { signature = await engine.send(create); }
    catch (error) {
      const failure = sendFailure(error);
      await store.update(mint, { status: 'failed', error: `send: ${failure.detail}`, logs: failure.logs });
      log.warn(`[launch] send failed for ${mint}: ${failure.detail}`);
      throw new HttpError(failure.friendly, 502);
    }
    pendingRoutes.set(mint, route);
    const sent = await store.update(mint, { status: 'sent', signature, sentAt: new Date().toISOString() });
    log.info(`[launch] sent ${mint} ${signature}`);
    track(sent);
    return { mint, signature };
  }

  async function finishRoute(mint, signed) {
    const record = store.get(mint);
    if (!record) return;
    await store.update(mint, { route: { ...record.route, status: 'sending' } });
    let signature;
    try { signature = await engine.send(signed); }
    catch (error) {
      const failure = sendFailure(error);
      await store.update(mint, { route: { status: 'failed', error: failure.detail, friendly: failure.friendly } });
      log.warn(`[route] send failed for ${mint}: ${failure.detail}`);
      return;
    }
    await store.update(mint, { route: { status: 'sent', signature, sentAt: new Date().toISOString() } });
    log.info(`[route] sent ${mint} ${signature}`);
    const outcome = await engine.confirm({ signature, lastValidBlockHeight: record.lastValidBlockHeight });
    const current = store.get(mint);
    if (outcome.status === 'confirmed') {
      const patch = { route: { status: 'active', signature, activeAt: new Date().toISOString(), slot: outcome.slot } };
      if (current.kind === 'registered') Object.assign(patch, { status: 'confirmed', signature, confirmedAt: patch.route.activeAt, slot: outcome.slot });
      await store.update(mint, patch);
      log.info(`[route] ${mint} active`);
      watcher?.track(mint).catch(error => log.warn(`[watch] ${mint}: ${error.message}`));
    } else {
      const route = { status: outcome.status === 'failed' ? 'failed' : 'unknown', signature, error: outcome.error || null };
      const patch = { route };
      if (current.kind === 'registered') Object.assign(patch, { status: outcome.status === 'failed' ? 'failed' : 'unknown', signature, error: outcome.error || null });
      await store.update(mint, patch);
      log.warn(`[route] ${mint} ${route.status}${route.error ? ` (${route.error})` : ''}`);
    }
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
        if (outcome.status !== 'confirmed') { pendingRoutes.delete(record.mint); return; }
        watcher?.track(record.mint).catch(error => log.warn(`[watch] ${record.mint}: ${error.message}`));
        const signedRoute = pendingRoutes.get(record.mint);
        pendingRoutes.delete(record.mint);
        if (signedRoute) await finishRoute(record.mint, signedRoute);
      })
      .catch(error => log.error(`[launch] tracking ${record.mint} failed: ${error.message}`))
      .finally(() => tracking.delete(record.mint));
    tracking.set(record.mint, job);
    return job;
  }

  // Registration: any pump.fun coin whose creator connects can put its fees on Route.
  async function inspect(mint) {
    const coin = await inspectCoin({ ...inspectOptions(), mint });
    const record = store.get(coin.mint);
    return { ...coin, record: record ? publicLaunch(record) : null };
  }

  async function prepareRoute(body) {
    const mint = parseMint(body?.mint).toBase58();
    const wallet = String(body?.wallet || '');
    const existing = store.get(mint);
    if (existing) {
      if (existing.wallet !== wallet) throw new HttpError('Only the wallet that created this coin can set its fee route.', 403);
      if (existing.route?.status === 'active') throw new HttpError('This coin is already on Route.', 409);
      if (['sending', 'sent'].includes(existing.route?.status)) throw new HttpError('The fee route for this coin is still confirming.', 409);
      if (existing.kind === 'launch' && existing.status !== 'confirmed') throw new HttpError('The coin has not been created yet.', 409);
    }
    const coin = await inspectCoin({ ...inspectOptions(), mint });
    if (coin.sharing && !coin.onRoute) throw new HttpError('This coin already shares its fees elsewhere. pump.fun locks fee sharing after the first change.', 409);
    if (coin.creator !== wallet) throw new HttpError(`Connect the wallet that created this coin (${coin.creator.slice(0, 4)}…${coin.creator.slice(-4)}).`, 403, { field: 'wallet' });
    const recipients = existing?.recipients?.length && !body?.recipients ? existing.recipients : await verifiedRecipients(body?.recipients);
    if (coin.onRoute) {
      // The on-chain route already points at the treasury; only the record was missing.
      const record = existing
        ? await store.update(mint, { route: { status: 'active', signature: existing.route?.signature || null, activeAt: new Date().toISOString() }, status: 'confirmed', recipients, shares: sharesOf(coin.sharing.shareholders) })
        : await store.create({ mint, kind: 'registered', status: 'confirmed', confirmedAt: new Date().toISOString(), name: coin.name, symbol: coin.symbol, imageUrl: coin.imageUrl, metadataUri: coin.uri, wallet, treasury: treasury.toBase58(), shareholder: shareholder().toBase58(), shares: sharesOf(coin.sharing.shareholders), recipients, route: { status: 'active', signature: null, activeAt: new Date().toISOString() }, fees: emptyFees() });
      watcher?.track(mint).catch(error => log.warn(`[watch] ${mint}: ${error.message}`));
      return { mint, transactions: [], already: true, record: publicLaunch(record) };
    }
    const built = await engine.buildRoute({ mint, creator: wallet, graduated: coin.graduated });
    const patch = { route: { status: 'pending' }, messages: { ...(existing?.messages || {}), route: built.message }, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight, recipients, shares: sharesOf(engine.shareholders) };
    if (existing) await store.update(mint, patch);
    else await store.create({ mint, kind: 'registered', status: 'prepared', name: coin.name, symbol: coin.symbol, imageUrl: coin.imageUrl, metadataUri: coin.uri, graduated: coin.graduated, wallet, treasury: treasury.toBase58(), shareholder: shareholder().toBase58(), fees: emptyFees(), ...patch });
    log.info(`[route] prepared ${mint} for ${wallet} (${built.size} bytes${coin.graduated ? ', graduated' : ''})`);
    return { mint, transactions: [built.transaction], lastValidBlockHeight: built.lastValidBlockHeight };
  }

  async function sendRoute(body) {
    const mint = String(body?.mint || '');
    const record = store.get(mint);
    if (!record?.messages?.route) throw new HttpError('This fee route was not prepared here.', 404);
    if (record.route?.status !== 'pending' && record.route?.status !== 'failed') throw new HttpError(`This fee route is already ${record.route?.status}.`, 409);
    const signed = engine.verifySigned({ signedTransaction: body?.signedTransaction, message: record.messages.route });
    if (record.kind === 'registered') await store.update(mint, { status: 'sending' });
    finishRoute(mint, signed).catch(error => log.error(`[route] ${mint}: ${error.message}`));
    return { mint };
  }

  // A coin whose on-chain fee sharing already points at Route: record it at once
  // (no transaction), with whatever recipients are known. Used by the admin API for
  // launches from Route's own launcher and by the fee-sharing detector.
  async function adopt({ mint: mintInput, recipients = null, source = 'adopted', signature = null }) {
    const mint = parseMint(mintInput).toBase58();
    const coin = await inspectCoin({ ...inspectOptions(), mint });
    if (!coin.onRoute) throw new HttpError(coin.sharing ? 'This coin shares its fees elsewhere.' : 'This coin does not share its fees with Route yet.', 409);
    const resolved = Array.isArray(recipients) && recipients.length ? await verifiedRecipients(recipients) : (store.get(mint)?.recipients || []);
    const existing = store.get(mint);
    const shares = sharesOf(coin.sharing.shareholders);
    const now = new Date().toISOString();
    const record = existing
      ? await store.update(mint, { status: 'confirmed', confirmedAt: existing.confirmedAt || now, route: { status: 'active', signature: existing.route?.signature || signature, activeAt: existing.route?.activeAt || now }, recipients: resolved, shares, name: existing.name || coin.name, symbol: existing.symbol || coin.symbol, imageUrl: existing.imageUrl || coin.imageUrl })
      : await store.create({ mint, kind: 'registered', source, status: 'confirmed', confirmedAt: now, name: coin.name, symbol: coin.symbol, imageUrl: coin.imageUrl, metadataUri: coin.uri, graduated: coin.graduated, wallet: coin.creator, treasury: treasury.toBase58(), shareholder: shareholder().toBase58(), shares, recipients: resolved, route: { status: 'active', signature, activeAt: now }, fees: emptyFees() });
    watcher?.track(mint).catch(error => log.warn(`[watch] ${mint}: ${error.message}`));
    log.info(`[route] adopted ${mint} (${source}, ${resolved.length} recipients)`);
    return publicLaunch(record);
  }

  function coin(mint) {
    const record = store.get(mint);
    if (!record) return null;
    return { ...publicLaunch(record), live: watcher?.get(mint) || null };
  }

  function coins() {
    return store.list({ status: 'confirmed', limit: 500 }).map(record => ({ ...publicLaunch(record), live: watcher?.get(record.mint) || null }));
  }

  function recover() {
    for (const record of [...store.list({ status: 'sent', limit: 200 }), ...store.list({ status: 'unknown', limit: 200 })]) {
      if (record.signature && record.kind === 'launch') track(record);
    }
  }

  return { prepare, send, track, inspect, prepareRoute, sendRoute, adopt, coin, coins, recover };
}
