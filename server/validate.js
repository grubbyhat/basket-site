import { PublicKey } from '@solana/web3.js';
import { MAX_RECIPIENTS, normalizeHandle } from '../src/basket.js';
import { HttpError } from './errors.js';
import { decodeImage } from './media.js';
import { HANDLE_PATTERN } from './x-lookup.js';

export function solToLamports(text) {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(String(text ?? '').trim());
  if (!match) return null;
  return BigInt(match[1]) * 1_000_000_000n + BigInt((match[2] || '').padEnd(9, '0'));
}

export function lamportsToSol(lamports) {
  const value = BigInt(lamports);
  const whole = value / 1_000_000_000n;
  const fraction = String(value % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function validateTwitter(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { url = null; }
  if (!url || url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) || url.username || url.password || url.port) {
    throw new HttpError('Use a full https://x.com/ or https://twitter.com/ link.', 400, { field: 'twitter' });
  }
  return text;
}

export function validateRecipients(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_RECIPIENTS) throw new HttpError('Choose between one and five recipients.', 400, { field: 'basket' });
  const seen = new Set();
  let total = 0;
  const recipients = input.map((entry, index) => {
    const handle = normalizeHandle(entry?.handle);
    if (!HANDLE_PATTERN.test(handle)) throw new HttpError('Enter an X handle or profile link.', 400, { field: `handle-${index}` });
    if (seen.has(handle)) throw new HttpError('This person is already in your route.', 400, { field: `handle-${index}` });
    seen.add(handle);
    const basisPoints = Number(entry?.basisPoints);
    if (!Number.isInteger(basisPoints) || basisPoints <= 0 || basisPoints > 10000) throw new HttpError('Use a share above 0%, with up to two decimal places.', 400, { field: `share-${index}` });
    total += basisPoints;
    return { handle, basisPoints };
  });
  if (total !== 10000) throw new HttpError(`Your shares total ${total / 100}%. Adjust them to 100%.`, 400, { field: 'basket' });
  return recipients;
}

export function validateLaunchRequest(body) {
  if (!body || typeof body !== 'object') throw new HttpError('Send a launch request.', 400);
  const name = String(body.name ?? '').trim();
  if (!name || Buffer.byteLength(name) > 32) throw new HttpError('Enter a token name, up to 32 characters.', 400, { field: 'name' });
  const symbol = String(body.symbol ?? '').trim();
  if (!/^[A-Za-z0-9]{1,10}$/.test(symbol)) throw new HttpError('Use 1-10 letters or numbers for the ticker.', 400, { field: 'ticker' });
  const description = String(body.description ?? '');
  if (description.length > 500) throw new HttpError('Keep your description within 500 characters.', 400, { field: 'description' });
  const twitter = validateTwitter(body.twitter);
  const devBuyLamports = solToLamports(body.devBuySol ?? '0');
  if (devBuyLamports === null) throw new HttpError('Enter 0 or a positive SOL amount, with up to 9 decimal places.', 400, { field: 'devBuy' });
  let wallet;
  try { wallet = new PublicKey(String(body.wallet || '')).toBase58(); } catch { throw new HttpError('Connect a Solana wallet first.', 400, { field: 'wallet' }); }
  const recipients = validateRecipients(body.recipients);
  const image = decodeImage(body.image);
  return { name, symbol, description, twitter, devBuyLamports, wallet, recipients, image };
}
