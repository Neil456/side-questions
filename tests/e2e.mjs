// End-to-end test: loads the unpacked extension into Chromium and serves tests/mock/ in place of
// https://chatgpt.com, then drives the whole flow: highlight → ask → branch → follow-up → reload →
// reopen → delete, and the transcript fallback when branching isn't offered.
//
//   npm test            (headless)
//   HEADED=1 npm test   (watch it run)
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = path.join(ROOT, 'tests', 'mock');
const SHOTS = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : null;
const SEED = '11111111-1111-4111-8111-111111111111';
const MAIN_URL = `https://chatgpt.com/c/${SEED}`;
const PHRASE = 'scaled by the square root of the key dimension';

const step = (name) => console.log(`• ${name}`);
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'marginalia-'));

// Every tab, including the helper tab the extension opens itself, resolves chatgpt.com to this server.
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=chatgpt.com',
  '-keyout', path.join(profile, 'key.pem'), '-out', path.join(profile, 'cert.pem'),
], { stdio: 'ignore' });

const backendCalls = [];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = https.createServer(
  { key: fs.readFileSync(path.join(profile, 'key.pem')), cert: fs.readFileSync(path.join(profile, 'cert.pem')) },
  (req, res) => {
    const { pathname } = new URL(req.url, 'https://chatgpt.com');
    const json = (v) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (pathname === '/api/auth/session') return json({ accessToken: 'test-token' });
    if (pathname.startsWith('/backend-api/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        backendCalls.push({ method: req.method, pathname, body, auth: req.headers.authorization });
        json({ success: true });
      });
      return;
    }
    const file = pathname.startsWith('/__mock/') ? path.join(MOCK, path.basename(pathname)) : path.join(MOCK, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  },
);
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: !process.env.HEADED,
  viewport: { width: 1680, height: 960 },
  ignoreHTTPSErrors: true,
  args: [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${server.address().port}`,
    '--no-proxy-server',
    '--ignore-certificate-errors',
  ],
});

async function selectPhrase(page, phrase) {
  await page.evaluate((phrase) => {
    for (const msg of document.querySelectorAll('[data-message-author-role]')) {
      const walker = document.createTreeWalker(msg, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.data.indexOf(phrase);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + phrase.length);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        const rect = r.getBoundingClientRect();
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.right, clientY: rect.bottom }));
        return;
      }
    }
    throw new Error(`phrase not found: ${phrase}`);
  }, phrase);
}

async function phraseRect(page, phrase) {
  return page.evaluate((phrase) => {
    const walker = document.createTreeWalker(document.querySelector('#thread'), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(phrase);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + phrase.length);
      const b = r.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom };
    }
    return null;
  }, phrase);
}

async function phraseCenter(page, phrase) {
  return page.evaluate((phrase) => {
    const walker = document.createTreeWalker(document.querySelector('#thread'), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(phrase);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i + 4);
      r.setEnd(n, i + 8);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return null;
  }, phrase);
}

const mockLog = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('mock:log') || '[]'));
const mockConv = (page, id) => page.evaluate((id) => JSON.parse(localStorage.getItem(`mock:conv:${id}`)), id);
const highlightCount = (page) =>
  page.evaluate(() => ['mg-thread', 'mg-active'].reduce((n, k) => n + (CSS.highlights.get(k)?.size || 0), 0));

let failed = false;
try {
  if (!ctx.serviceWorkers().length) await ctx.waitForEvent('serviceworker');
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(MAIN_URL);
  await page.waitForSelector('#mg-root', { state: 'attached' });

  step('selecting text shows the Ask button');
  await selectPhrase(page, PHRASE);
  await page.locator('.mg-ask').waitFor({ state: 'visible' });

  step('Ask opens a card next to the highlight, in the margin');
  await page.locator('.mg-ask').click();
  const card = page.locator('.mg-card');
  await card.waitFor({ state: 'visible' });
  await assert.doesNotReject(page.locator('.mg-card .mg-input:focus').waitFor({ timeout: 2000 }));
  const [cardBox, msgBox] = await Promise.all([
    card.boundingBox(),
    page.locator('[data-message-author-role="assistant"]').boundingBox(),
  ]);
  assert.ok(cardBox.x >= msgBox.x + msgBox.width, 'wide window: card sits in the margin, right of the column');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(100);
  const [narrowCard, hl] = await Promise.all([card.boundingBox(), phraseRect(page, PHRASE)]);
  assert.ok(narrowCard.y >= hl.bottom, 'narrow window: card opens below the highlighted line');
  await page.setViewportSize({ width: 1680, height: 960 });
  const scrollBefore = await page.locator('#scroll').evaluate((el) => el.scrollTop);

  step('first question branches the conversation in a pinned helper tab and streams the answer back');
  const workerPromise = ctx.waitForEvent('page');
  await page.locator('.mg-card .mg-input').fill('Why the square root specifically?');
  await page.keyboard.press('Enter');
  const worker = await workerPromise;
  await page.locator('.mg-card .mg-a', { hasText: 'Mock answer to: Why the square root specifically?' }).waitFor({ timeout: 30000 });
  await page.locator('.mg-card .mg-input:not([disabled])').waitFor();

  let log = await mockLog(page);
  const first = log.at(-1);
  assert.notEqual(first.conv, SEED, 'never posts in the main conversation');
  assert.equal(first.priorMessages, 2, 'the branch carries the main conversation history');
  assert.ok(norm(first.prompt).includes(PHRASE), 'prompt quotes the highlight');
  assert.ok(norm(first.prompt).includes('Those scores are'), 'prompt includes the surrounding paragraph');
  assert.equal((await mockConv(page, SEED)).messages.length, 2, 'main conversation untouched');
  assert.equal(await page.locator('#scroll').evaluate((el) => el.scrollTop), scrollBefore, 'reading position unchanged');
  assert.ok(new URL(worker.url()).pathname.endsWith(first.conv), 'helper tab is on the branch');
  assert.equal(await worker.locator('#mg-worker-banner').count(), 1, 'helper tab is labelled');
  assert.equal(await page.locator('.mg-card a.mg-icon').getAttribute('href'), `https://chatgpt.com/c/${first.conv}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'card-light.png') });

  step('follow-up goes to the same branch');
  await page.locator('.mg-card .mg-input').fill('What happens without the scaling?');
  await page.keyboard.press('Enter');
  await page.locator('.mg-card .mg-a', { hasText: 'What happens without the scaling?' }).waitFor({ timeout: 30000 });
  log = await mockLog(page);
  assert.equal(log.at(-1).conv, first.conv);
  assert.equal(norm(log.at(-1).prompt), 'What happens without the scaling?');
  assert.equal(await page.locator('.mg-card .mg-a').count(), 2);

  step('Esc collapses the card to a marker in the margin');
  await page.locator('.mg-card .mg-input').press('Escape');
  await page.locator('.mg-pill').waitFor({ state: 'visible' });
  assert.equal(await card.isVisible(), false);

  step('reload restores the highlight; clicking it reopens the thread with its history');
  await page.reload();
  await page.locator('.mg-pill').waitFor({ state: 'visible' });
  assert.equal(await highlightCount(page), 1);
  const pt = await phraseCenter(page, PHRASE);
  await page.mouse.click(pt.x, pt.y);
  await card.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.mg-card .mg-a').count(), 2);

  step('dark mode');
  await page.evaluate(() => localStorage.setItem('mock:theme', 'dark'));
  await page.reload();
  await page.locator('.mg-pill').click();
  await card.waitFor({ state: 'visible' });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'card-dark.png') });
  await page.evaluate(() => localStorage.removeItem('mock:theme'));

  step('delete removes the thread and deletes the branch chat, never the main one');
  await page.locator('.mg-card .mg-delete').click();
  await assert.doesNotReject(page.locator('.mg-card, .mg-pill').first().waitFor({ state: 'detached', timeout: 3000 }));
  await page.waitForTimeout(300);
  assert.deepEqual(
    backendCalls.map((c) => [c.method, c.pathname, c.body, c.auth]),
    [['PATCH', `/backend-api/conversation/${first.conv}`, '{"is_visible":false}', 'Bearer test-token']],
  );
  await page.reload();
  await page.waitForSelector('#mg-root', { state: 'attached' });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.mg-pill').count(), 0);
  assert.equal(await highlightCount(page), 0);

  step('without "Branch in new chat", falls back to a new chat with the transcript');
  await page.evaluate(() => localStorage.setItem('mock:nobranch', '1'));
  await selectPhrase(page, 'Multi-head attention');
  await page.locator('.mg-ask').click();
  await page.locator('.mg-card .mg-input').fill('How many heads are typical?');
  await page.keyboard.press('Enter');
  await page.locator('.mg-card .mg-a', { hasText: 'How many heads are typical?' }).waitFor({ timeout: 45000 });
  const fallback = (await mockLog(page)).at(-1);
  assert.ok(fallback.isNew, 'used a new chat');
  assert.ok(fallback.prompt.includes('<transcript>'));
  assert.ok(fallback.prompt.includes('Can you explain scaled dot-product attention'), 'transcript carries the conversation');
  assert.equal((await mockConv(page, SEED)).messages.length, 2, 'main conversation still untouched');

  console.log('\nAll checks passed.');
} catch (e) {
  failed = true;
  console.error('\nFAILED:', e);
  if (SHOTS) for (const [i, p] of ctx.pages().entries()) await p.screenshot({ path: path.join(SHOTS, `failure-${i}.png`) }).catch(() => {});
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
