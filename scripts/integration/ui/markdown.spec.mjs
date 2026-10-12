import { test, expect } from './fixture.mjs';

test('chat renders TeX formulas while preserving code and ordinary brackets', async ({ page, ui }) => {
  await ui.complete('paused');
  const formula = String.raw`z=\frac{x-\mu}{\sqrt{\max(s^2,\mu,1)}}`;
  const text = [
    `Inline $${formula}$`,
    `$$\n${formula}\n$$`,
    `[ ${formula} ]`,
    String.raw`\[ z_i=\frac{x_i-\mu}{s_i} \]`,
    `[ordinary brackets]`,
    '`$x$`',
    `\`[ ${formula} ]\``,
    '```tex\n' + `[ ${formula} ]` + '\n```',
    '$\\unknowncommand{x}$',
    '$\\href{javascript:alert(1)}{unsafe}$',
    `$$\n${Array(25).fill('x_i').join('+')}\n$$`,
  ].join('\n\n');
  const session = ui.sessions.get('old-session');
  session.turns = [{ id: 'math-turn', prompt: 'Show formulas', images: [], status: 'completed', startedAt: session.createdAt,
    items: [{ id: 'math-answer', type: 'agent_message', text }] }];
  await page.goto('/sessions/old-session');
  const markdown = page.locator('.markdown').filter({ has: page.locator('.katex') });
  await expect(markdown.locator('.katex')).toHaveCount(7);
  await expect(markdown.locator('.katex-display')).toHaveCount(4);
  await expect(markdown.locator('.katex-mathml annotation').first()).toHaveText(formula);
  await expect(markdown.locator('.katex-mathml annotation').nth(3)).toHaveText(String.raw`z_i=\frac{x_i-\mu}{s_i}`);
  await expect(markdown).toContainText('[ordinary brackets]');
  await expect(markdown.locator('code').filter({ hasText: '$x$' })).toHaveText('$x$');
  await expect(markdown.locator('.markdown-code-block code')).toHaveText(`[ ${formula} ]\n`);
  await expect(markdown.locator('.markdown-code-block .katex')).toHaveCount(0);
  await expect(markdown).toContainText('\\unknowncommand');
  await expect(markdown.locator('a[href^="javascript:"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  const display = markdown.locator('.katex-display').last();
  await expect(display).toBeVisible();
  expect(await display.evaluate(el => getComputedStyle(el).overflowX)).toBe('auto');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await display.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
});
