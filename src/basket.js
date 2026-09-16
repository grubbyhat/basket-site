export const MAX_RECIPIENTS = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const EXAMPLE_BASKET = [
  { id: 'example-1', handle: 'the_creator', share: '50' },
  { id: 'example-2', handle: 'the_builder', share: '30' },
  { id: 'example-3', handle: 'the_community', share: '20' },
];

export function normalizeHandle(value) {
  const text = String(value || '').trim();
  if (/^(https?:\/\/)?(www\.)?(x\.com|twitter\.com)\//i.test(text)) {
    try {
      const url = new URL(/^https?:/i.test(text) ? text : `https://${text}`);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length !== 1 || url.search || url.hash) return '';
      return parts[0].replace(/^@/, '').toLowerCase();
    } catch { return ''; }
  }
  return text.replace(/^@/, '').toLowerCase();
}

export function toBasisPoints(value) {
  const text = String(value).trim();
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return bps <= 10000 ? bps : null;
}

export function splitEvenly(recipients) {
  if (!recipients.length || recipients.length > MAX_RECIPIENTS) return recipients;
  const base = Math.floor(10000 / recipients.length);
  const remainder = 10000 % recipients.length;
  return recipients.map((recipient, index) => ({
    ...recipient,
    share: String((base + (index < remainder ? 1 : 0)) / 100),
  }));
}

export function validateBasket(recipients) {
  const errors = {};
  if (!Array.isArray(recipients) || !recipients.length || recipients.length > MAX_RECIPIENTS) {
    return { valid: false, errors: { basket: 'Choose between one and five recipients.' }, totalBps: 0 };
  }
  const seen = new Set();
  let totalBps = 0;
  recipients.forEach((recipient, index) => {
    const handle = normalizeHandle(recipient.handle);
    if (!/^[a-z0-9_]{1,15}$/.test(handle)) errors[`handle-${index}`] = 'Enter an X handle or profile link.';
    else if (seen.has(handle)) errors[`handle-${index}`] = 'This person is already in your basket.';
    seen.add(handle);
    const bps = toBasisPoints(recipient.share);
    if (bps === null || bps <= 0) errors[`share-${index}`] = 'Use a share above 0%, with up to two decimal places.';
    totalBps += bps ?? 0;
  });
  if (totalBps !== 10000) errors.basket = `Your shares total ${totalBps / 100}%. Adjust them to 100%.`;
  return { valid: Object.keys(errors).length === 0, errors, totalBps };
}

export function validateDraft(draft, image) {
  const result = validateBasket(draft.recipients);
  const errors = { ...result.errors };
  if (!draft.name.trim() || draft.name.trim().length > 32) errors.name = 'Enter a token name, up to 32 characters.';
  if (!/^[A-Za-z0-9]{1,10}$/.test(draft.ticker.trim())) errors.ticker = 'Use 1-10 letters or numbers.';
  if (draft.description.length > 500) errors.description = 'Keep your description within 500 characters.';
  if (!image) errors.image = 'Add a PNG, JPG or WebP image.';
  const devBuy = String(draft.devBuy).trim();
  if (!/^\d+(?:\.\d{1,9})?$/.test(devBuy) || !Number.isFinite(Number(devBuy))) errors.devBuy = 'Enter 0 or a positive SOL amount, with up to 9 decimal places.';
  if (draft.twitter.trim()) {
    try {
      const url = new URL(draft.twitter.trim());
      if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error();
    } catch { errors.twitter = 'Use a full https://x.com/ or https://twitter.com/ link.'; }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// Preview data only. This object is never submitted to a launcher or wallet.
export function previewPayload(draft, origin) {
  return {
    name: draft.name.trim(), symbol: draft.ticker.trim(), description: draft.description,
    website: new URL('/', origin).href, twitter: draft.twitter.trim(),
    launchpad: 'pump.fun', quote: 'SOL', devBuySol: draft.devBuy,
    recipients: draft.recipients.map(recipient => ({ handle: normalizeHandle(recipient.handle), basisPoints: toBasisPoints(recipient.share) })),
    bundle: false,
  };
}
