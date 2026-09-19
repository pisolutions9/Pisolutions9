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
    const firstAnswer = (await firstAssistant.locator('.chat-content').innerText()).trim();
    expect(firstAnswer.length).toBeGreaterThan(10);
    expect(firstAnswer).not.toMatch(/Classification:|BUSINESS_OBJECTIVE/i);

    const assistantTurns = transcript.locator('.chat-turn.assistant');
    const beforeSecond = await assistantTurns.count();
    await input.fill('Explain photosynthesis to a 10-year-old in two short sentences.');
    await send.click();

    await expect(assistantTurns).toHaveCount(beforeSecond + 1, { timeout: 70000 });
    const secondAssistant = assistantTurns.nth(beforeSecond);
    const secondAnswer = (await secondAssistant.locator('.chat-content').innerText()).trim();
    expect(secondAnswer.length).toBeGreaterThan(10);
    expect(secondAnswer).not.toBe(firstAnswer);
    expect(secondAnswer).not.toMatch(/Classification:|BUSINESS_OBJECTIVE/i);

    await input.fill('Create an inventory CSV:\npens,12,15.00\nnotebooks,8,45.00');
    await send.click();

    const artifactLink = transcript.locator('a.download[download="inventory.csv"]').last();
    await expect(artifactLink).toBeVisible({ timeout: 70000 });
    await expect(artifactLink).toHaveText(/Download inventory\.csv/);

    await expect(assistantTurns).toHaveCount(3);
  });
});
