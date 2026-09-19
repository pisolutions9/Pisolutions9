import { test, expect } from '@playwright/test';

const BASE = 'https://pisolutions9.github.io/Pisolutions9/';

test.describe('PI V1.02 live customer browser journey', () => {
  test.setTimeout(120000);

  test('renders a live model answer and a downloadable verified artifact', async ({ page }) => {
    await page.goto(`${BASE}?candidate=${process.env.GITHUB_SHA || 'manual'}`, { waitUntil: 'networkidle' });

    const input = page.locator('#command');
    const send = page.locator('#run');
    const transcript = page.locator('#transcript');

    await expect(input).toBeVisible();
    await expect(send).toBeVisible();
    await expect(page.locator('#systemStatus')).toContainText(/Ready to ask|Cloud runtime ready|Reply received/);

    await input.fill('Explain opportunity cost with one clear example.');
    await send.click();

    const firstAssistant = transcript.locator('.chat-turn.assistant').last();
    await expect(firstAssistant).toBeVisible({ timeout: 70000 });
    await expect(firstAssistant.locator('.chat-content')).not.toHaveText('');
    await expect(firstAssistant.locator('.chat-content')).not.toContainText('Classification:');
    await expect(firstAssistant.locator('.chat-content')).not.toContainText('BUSINESS_OBJECTIVE');

    await input.fill('Create an inventory CSV:\npens,12,15.00\nnotebooks,8,45.00');
    await send.click();

    const artifactLink = transcript.locator('a.download[download="inventory.csv"]').last();
    await expect(artifactLink).toBeVisible({ timeout: 70000 });
    await expect(artifactLink).toHaveText(/Download inventory\.csv/);

    const assistantTurns = transcript.locator('.chat-turn.assistant');
    await expect(assistantTurns).toHaveCount(2);
  });
});
