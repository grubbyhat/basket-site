import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const origin = process.env.BASKET_URL || 'http://127.0.0.1:5274';
const executablePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const errors = [], external = [], accessibility = [], overflow = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin)) external.push(request.url()); });
// X lookups are answered locally so the check is deterministic and stays offline in the browser.
const AVATAR = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#b5dcc7"/></svg>').toString('base64');
await page.route('**/api/x/*', route => {
  const handle = decodeURIComponent(route.request().url().split('/api/x/')[1]).toLowerCase();
  if (handle.startsWith('recipient')) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `We couldn't find @${handle} on X.` }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: String(handle.length), handle, name: `${handle[0].toUpperCase()}${handle.slice(1)} Person`, avatarUrl: AVATAR }) });
});
try {
  for (const width of [1440, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const path of ['/', '/launch', '/payments', '/capital-flow', '/docs']) {
      await page.goto(`${origin}${path}`);
      await page.locator('main h1').waitFor();
      await page.evaluate(() => document.fonts.ready);
      const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      if (dimensions.scroll > dimensions.client) overflow.push({ width, path, ...dimensions });
      if (width === 1440 || width === 390) {
        await page.screenshot({ path: `artifacts/${path.slice(1) || 'home'}-${width}.png`, fullPage: true });
        const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        accessibility.push(...result.violations.map(v => ({ width, path, id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })));
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/launch`);
  await page.getByRole('button', { name: 'Review launch' }).click();
  await page.getByText('Enter an X handle or profile link.').waitFor();
  assert.equal(await page.locator('#handle-0').evaluate(e => document.activeElement === e), true, 'invalid handle takes focus');
  await page.locator('#handle-0').fill('https://x.com/Creator');
  await page.getByRole('button', { name: 'Add recipient' }).click();
  await page.locator('#handle-1').fill('@creator');
  await page.getByRole('button', { name: 'Split evenly' }).click();
  await page.getByRole('button', { name: 'Review launch' }).click();
  await page.getByText('This person is already in your basket.').waitFor();
  await page.locator('#handle-1').fill('builder');
  await page.getByText('Builder Person').waitFor();
  assert.equal(await page.locator('.recipient-row .avatar img').count(), 2, 'looked-up recipients show their X picture');
  assert.equal(await page.locator('.launch-preview .avatar img').count() >= 2, true, 'the preview uses the same pictures');
  for (let i = 2; i < 5; i++) { await page.getByRole('button', { name: 'Add recipient' }).click(); await page.locator(`#handle-${i}`).fill(`recipient${i}`); }
  await page.getByText('We couldn’t find @recipient2 on X.').first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Add recipient' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Split evenly' }).click();
  assert.equal(await page.locator('#share-0').inputValue(), '20');
  await page.getByRole('button', { name: 'Remove recipient 5' }).click();
  await page.getByRole('button', { name: 'Remove recipient 4' }).click();
  await page.locator('#handle-2').fill('artist');
  await page.getByRole('button', { name: 'Split evenly' }).click();
  assert.equal(await page.locator('#share-0').inputValue(), '33.34');
  assert.equal(await page.locator('#share-1').inputValue(), '33.33');
  const shareFits = await page.locator('#share-0').evaluate(input => {
    const style = getComputedStyle(input);
    const canvas = document.createElement('canvas').getContext('2d');
    canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return canvas.measureText(input.value).width <= input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
  assert.ok(shareFits, 'decimal allocations stay fully readable');
  await page.locator('#name').fill('Silver Circle');
  await page.locator('#ticker').fill('circle');
  await page.locator('#description').fill('A coin for the people who make things happen.');
  await page.locator('.social-fields > summary').click();
  await page.locator('#twitter').fill('https://x.com/silvercircle');
  await page.getByRole('button', { name: '0.5 SOL', exact: true }).click();
  assert.equal(await page.locator('#website').inputValue(), `${origin}/`);
  assert.equal(await page.locator('#website').getAttribute('readonly'), '');
  await page.locator('#token-image').setInputFiles({ name: 'too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
  await page.getByText('This image is too large. Choose one under 5 MB.').waitFor();
  await page.locator('#token-image').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await page.getByText('This image could not be opened. Try another file.').waitFor();
  await page.locator('#token-image').setInputFiles({ name: 'route-mark.png', mimeType: 'image/png', buffer: await page.screenshot({ clip: { x: 0, y: 0, width: 96, height: 96 } }) });
  await page.getByAltText('Selected token artwork').waitFor();
  await page.getByRole('button', { name: 'Review launch' }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Connect wallet to launch' }).waitFor();
  assert.equal(await page.locator('dialog[open] .distribution .avatar img').count(), 3, 'the review shows every recipient picture');
  await page.screenshot({ path: 'artifacts/launch-review.png', fullPage: false });
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog')), true, 'dialog traps focus'); }
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').isVisible(), false);
  await page.screenshot({ path: 'artifacts/launch-filled-1440.png', fullPage: true });
  await page.reload();
  assert.equal(await page.locator('#name').inputValue(), 'Silver Circle');
  assert.equal(await page.locator('#share-0').inputValue(), '33.34');
  await page.getByRole('button', { name: 'Review launch' }).click();
  await page.getByText('Add a PNG, JPG or WebP image.', { exact: true }).waitFor();
  await page.goto(`${origin}/capital-flow`);
  await page.getByRole('button', { name: 'Equal split', exact: true }).click();
  const total = await page.locator('.calculator-person > strong').allTextContents();
  assert.equal(total.reduce((sum, text) => sum + Math.round(Number(text.replace('$', '')) * 100), 0), 10000);
  await page.locator('#pool').fill('1000');
  assert.equal(await page.locator('.calculator-total > strong').textContent(), '$1000.00');
  await page.goto(`${origin}/payments`);
  await page.getByRole('button', { name: 'Pending', exact: true }).click();
  await page.getByRole('heading', { name: 'Nothing waiting in the wings.' }).waitFor();
  await page.getByRole('heading', { name: 'Coins launched', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'No coins launched yet' }).waitFor();
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('heading', { name: 'Connect a Solana wallet.' }).waitFor();
  await page.getByText('No Solana wallet was detected in this browser.').waitFor();
  await page.keyboard.press('Escape');
  await page.goto(`${origin}/`);
  await page.getByRole('link', { name: 'Launch a token' }).first().click();
  await page.goBack();
  assert.equal(new URL(page.url()).pathname, '/');
  assert.equal(await page.locator('.hero-logo svg').evaluate(e => e.getBoundingClientRect().width > 40), true, 'the Route mark renders in the hero');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('body *')].some(e => getComputedStyle(e).animationName !== 'none')), false, 'reduced motion disables animations');
  await writeFile('artifacts/browser-report.json', JSON.stringify({ errors, external, accessibility, overflow }, null, 2));
  assert.deepEqual(errors, [], 'no runtime errors');
  assert.deepEqual(external, [], 'no external, wallet, launch or payment requests');
  assert.deepEqual(overflow, [], 'all routes fit 320, 390, 900 and 1440px');
  assert.deepEqual(accessibility, [], 'WCAG A/AA checks');
  console.log('PASS: routes, responsiveness, allocations, uploads, draft persistence, review, keyboard and accessibility. No external requests.');
} finally { await writeFile('artifacts/browser-report.json', JSON.stringify({ errors, external, accessibility, overflow }, null, 2)); await browser.close(); }
