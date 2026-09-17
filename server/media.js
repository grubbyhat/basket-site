import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './errors.js';

// pump.fun's own IPFS uploader refuses server-side requests, so Route hosts each
// coin's image and metadata JSON itself and puts that URL on-chain.
export const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function decodeImage(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!match) throw new HttpError('Add a PNG, JPG or WebP image.', 400, { field: 'image' });
  const mime = match[1];
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) throw new HttpError('Add a PNG, JPG or WebP image.', 400, { field: 'image' });
  if (buffer.length > MAX_IMAGE_BYTES) throw new HttpError('This image is too large. Choose one under 5 MB.', 400, { field: 'image' });
  if (!looksLike(buffer, mime)) throw new HttpError('This image could not be read. Try another file.', 400, { field: 'image' });
  return { buffer, mime, ext: IMAGE_TYPES[mime] };
}

function looksLike(buffer, mime) {
  if (mime === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

async function writeAtomic(target, contents) {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, contents);
  await rename(temp, target);
}

export function mediaDir(dataDir) { return path.join(dataDir, 'media'); }

// The on-chain URI uses a 12-character mint prefix so create + dev buy fits one
// transaction; the same JSON is also served under the full mint.
export const METADATA_ID_LENGTH = 12;
export const metadataId = mint => String(mint).slice(0, METADATA_ID_LENGTH);

export async function saveTokenMedia(dataDir, origin, { mint, image, name, symbol, description, twitter, recipients }) {
  const dir = mediaDir(dataDir);
  await mkdir(dir, { recursive: true });
  const imageName = `${mint}.${image.ext}`;
  const imageUrl = `${origin}/i/${imageName}`;
  const metadataUri = `${origin}/m/${metadataId(mint)}`;
  const metadata = {
    name, symbol, description,
    image: imageUrl,
    showName: true,
    createdOn: 'https://pump.fun',
    twitter: twitter || (recipients[0] ? `https://x.com/${recipients[0].handle}` : undefined),
    website: `${origin}/coin/${mint}`,
    route: { recipients: recipients.map(recipient => ({ x: recipient.handle, xId: recipient.xId, basisPoints: recipient.basisPoints })) },
  };
  if (metadata.twitter === undefined) delete metadata.twitter;
  await writeAtomic(path.join(dir, imageName), image.buffer);
  const json = JSON.stringify(metadata, null, 2);
  await writeAtomic(path.join(dir, `${mint}.json`), json);
  await writeAtomic(path.join(dir, `${metadataId(mint)}.json`), json);
  return { imageUrl, metadataUri, imageName, website: metadata.website };
}
