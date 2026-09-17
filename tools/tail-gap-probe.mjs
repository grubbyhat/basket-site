// Measures the pixel gap between a trunk coin and the end of its tail on the horizontal desktop rail.
import { chromium } from 'playwright';
import { inflateSync } from 'node:zlib';

const origin = process.env.BASKET_URL || 'http://127.0.0.1:5274';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'no-preference', deviceScaleFactor: 1 });

function decodePng(buffer) {
  let offset = 8, width = 0, height = 0, data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); if (body[8] !== 8 || (body[9] !== 6 && body[9] !== 2)) throw new Error(`unsupported png depth ${body[8]} colour ${body[9]}`); data.channels = body[9] === 6 ? 4 : 3; }
    if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  const channels = data.channels, raw = inflateSync(Buffer.concat(data)), stride = width * channels, pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), previous = y ? pixels.subarray((y - 1) * stride, y * stride) : null, out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0, b = previous ? previous[x] : 0, c = previous && x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a; else if (filter === 2) value += b; else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[x] = value & 255;
    }
  }
  return { width, height, channels, pixel: (x, y) => { const i = (y * width + x) * channels; return [pixels[i], pixels[i + 1], pixels[i + 2]]; } };
}

try {
  await page.goto(`${origin}/capital-flow`);
  await page.locator('.capital-scene[data-running="true"]').waitFor();
  const samples = [];
  for (let attempt = 0; attempt < 12 && samples.length < 4; attempt += 1) {
    await page.waitForTimeout(350);
    const coin = await page.evaluate(() => {
      const scene = document.querySelector('.capital-scene');
      const candidates = [...scene.querySelectorAll('[data-flow-particle]:not([data-branch])')].filter(node => node.className.includes('state-cash') || node.className.includes('state-collected'));
      const pick = candidates.find(node => { const box = node.getBoundingClientRect(); const rail = scene.getBoundingClientRect(); return box.left > rail.left + rail.width * .12 && box.left < rail.left + rail.width * .66; });
      if (!pick) return null;
      const box = pick.getBoundingClientRect();
      return { left: box.left, cx: box.left + box.width / 2, cy: box.top + box.height / 2, state: pick.className, progress: pick.dataset.coin };
    });
    if (!coin) continue;
    const buffer = await page.screenshot({ clip: { x: coin.left - 160, y: coin.cy - 6, width: 160, height: 12 } });
    const png = decodePng(buffer);
    let rightmost = -1;
    for (let x = png.width - 1; x >= 0 && rightmost < 0; x -= 1) {
      for (let y = 0; y < png.height; y += 1) {
        const [r, g, b] = png.pixel(x, y);
        if (g > 70 && g >= r + 12 && g >= b + 6) { rightmost = x; break; }
      }
    }
    samples.push({ state: coin.state.replace('flow-coin ', ''), coinLeft: Math.round(coin.left), tailEndGapPx: rightmost < 0 ? null : png.width - 1 - rightmost });
  }
  console.log(JSON.stringify(samples, null, 1));
} finally { await browser.close(); }
