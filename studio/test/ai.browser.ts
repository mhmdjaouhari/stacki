import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Page } from 'playwright';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(process.env['STUDIO_URL'] ?? 'http://localhost:4350/studio');
  await page.getByRole('button', { name: 'AI chat', exact: true }).click();
  await page.getByLabel('AI prompt', { exact: true }).waitFor();
  await verifyDrafts(page);
  await verifyImages(page);
  await page.reload();
  await page.getByRole('button', { name: 'AI chat', exact: true }).click();
  await page.getByLabel('AI prompt', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('AI prompt', { exact: true }).inputValue(), 'First draft');
  assert.equal(await page.getByRole('img', { name: 'reference.png', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Remove reference.png', exact: true }).click();
  assert.equal(await page.getByRole('img', { name: 'reference.png', exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('AI prompt', { exact: true }).waitFor();
  const composer = await page.locator('.chat-composer').boundingBox();
  assert.ok(composer && composer.x >= 0 && composer.x + composer.width <= 390);
  assert.ok(await page.getByRole('button', { name: 'Voice input', exact: true }).isVisible());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await verifySingleTranscript(page);
  await verifyBackgroundDot(page);
  assert.deepEqual(errors, []);
  console.log(
    'Chat drafts, switching, image preparation/removal, reload persistence, single transcript across renders, the chat list by keyboard, the background-chat dot, and mobile composer passed. Live AI and microphone recognition require a configured provider and an interactive microphone.',
  );
} finally {
  await browser.close();
}

async function verifyDrafts(page: Page) {
  const prompt = page.getByLabel('AI prompt', { exact: true });
  await prompt.fill('First draft');
  await page
    .getByRole('button', { name: 'New chat', exact: true })
    .filter({ has: page.locator('svg') })
    .last()
    .click();
  assert.equal(await prompt.inputValue(), '');
  await prompt.fill('Second draft');
  await prompt.press('Shift+Enter');
  assert.equal(await prompt.inputValue(), 'Second draft\n');
  assert.equal(await page.locator('.chat-tabs').count(), 0);
  await page.getByRole('button', { name: 'Chat history', exact: true }).click();
  // The list opens on the current chat (newest first), so Down then Enter selects the first chat.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#chat-history').count(), 0);
  assert.equal(await prompt.inputValue(), 'First draft');
  await page.getByRole('button', { name: 'Navigator', exact: true }).click();
  await page.getByRole('button', { name: 'AI chat', exact: true }).click();
  assert.equal(await prompt.inputValue(), 'First draft');
  await page.getByRole('button', { name: 'Chat history', exact: true }).click();
  assert.equal(await page.locator('.chat-history-select').count(), 2);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#chat-history').count(), 0);
  if (await page.getByText('No model connected', { exact: true }).count()) {
    assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
    await prompt.press('Enter');
    assert.equal(await prompt.inputValue(), 'First draft');
  }
}
// The transcript and the composer once shared a React key. React then left one orphaned
// transcript in the page per render, so a chat with history filled with stale copies.
// Typing renders the panel once per keystroke, which reproduced the fault without a provider.
async function verifySingleTranscript(page: Page) {
  const keystrokeCount = 6;
  await page.evaluate(async () => {
    const thread = {
      id: 'single-transcript',
      title: 'Saved chat',
      draft: '',
      images: [],
      model: '',
      messages: [
        { id: 'question', role: 'user', content: 'Saved question', images: [] },
        { id: 'answer', role: 'assistant', content: 'Saved answer', images: [] },
      ],
      status: 'idle',
    };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('studio-ai-chats', 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new Error('Could not open the chat database'));
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('chats', 'readwrite');
      transaction.objectStore('chats').put({ threads: [thread], active: thread.id }, 'session');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Could not save the chat'));
    });
    database.close();
  });
  await page.reload();
  await page.getByRole('button', { name: 'AI chat', exact: true }).click();
  await page.getByText('Saved answer', { exact: true }).waitFor();
  await page.getByLabel('AI prompt', { exact: true }).pressSequentially('x'.repeat(keystrokeCount));
  assert.equal(await page.getByLabel('AI prompt', { exact: true }).inputValue(), 'x'.repeat(keystrokeCount));
  assert.equal(await page.locator('.chat-transcript').count(), 1);
  assert.equal(await page.getByText('Saved answer', { exact: true }).count(), 1);
}
// Without tabs, a chat working in the background shows as a dot on the title button. The test
// stands in for the provider with routes: a model list, and a proposal request held open until
// the end, so the first chat stays working while the person switches to a new one.
async function verifyBackgroundDot(page: Page) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/studio/api/ai/models', (route) => route.fulfill({ json: { models: ['test-model'], defaultModel: 'test-model' } }));
  await page.route('**/studio/api/ai/propose', async (route) => {
    await held;
    await route.fulfill({ status: 503, json: { error: 'Test provider closed.' } });
  });
  await page.reload();
  await page.getByRole('button', { name: 'AI chat', exact: true }).click();
  const prompt = page.getByLabel('AI prompt', { exact: true });
  await prompt.fill('Make the hero bigger');
  await prompt.press('Enter');
  await page.locator('.chat-working').waitFor();
  const dot = page.locator('.chat-switcher-button .chat-running-dot');
  assert.equal(await dot.count(), 0, 'the active chat is not a background chat');
  await page
    .getByRole('button', { name: 'New chat', exact: true })
    .filter({ has: page.locator('svg') })
    .last()
    .click();
  await dot.waitFor();
  await page.getByRole('button', { name: 'Chat history', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: 'Working…' }).waitFor();
  await page.keyboard.press('Escape');
  release();
  await dot.waitFor({ state: 'detached' });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
}
async function verifyImages(page: Page) {
  const image = await page.screenshot({ clip: { x: 0, y: 0, width: 100, height: 100 } });
  await page.getByLabel('Attach image files', { exact: true }).setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: image });
  await page.getByRole('img', { name: 'reference.png', exact: true }).waitFor();
  await page.getByLabel('Attach image files', { exact: true }).setInputFiles({
    name: 'bad.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not an image'),
  });
  await page.getByRole('alert').filter({ hasText: 'Choose PNG' }).waitFor();
  await page.getByLabel('Attach image files', { exact: true }).setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: image });
  await page.getByRole('img', { name: 'second.png', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove second.png', exact: true }).click();
  await page.waitForTimeout(250); // IndexedDB persistence is debounced by 150 ms.
}
