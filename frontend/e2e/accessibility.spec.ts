import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function assertAccessible(page: Page) {
  const results=await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
  expect(results.violations, results.violations.map((item) => `${item.id}: ${item.help}`).join('\n')).toEqual([]);
}

async function login(page: Page) {
  await page.goto('/'); await page.getByLabel('Email',{ exact:true }).fill('admin@demo.altegro.local'); await page.getByLabel('Password',{ exact:true }).fill('efrobotics'); await page.getByRole('button',{ name:'Sign in',exact:true }).click(); await expect(page.getByRole('heading',{ name:'Fleet priorities at a glance' })).toBeVisible();
}

test('login has no automated WCAG A/AA violations',async ({ page }) => { await page.goto('/'); await assertAccessible(page); });

test('authenticated workspaces have no automated WCAG A/AA violations',async ({ page }) => {
  await login(page); await assertAccessible(page);
  for (const workspace of ['Robots','Events & service','Support','Technicians','Reports','Audit log','Integrations']) { await page.getByRole('navigation').getByRole('button',{ name:workspace,exact:true }).click(); await page.waitForTimeout(150); await assertAccessible(page); }
});
