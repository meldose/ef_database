import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, role = 'admin') {
  await page.goto('/'); await page.getByLabel('Email', { exact: true }).fill(`${role}@demo.altegro.local`);
  await page.getByLabel('Password', { exact: true }).fill('efrobotics'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fleet priorities at a glance' })).toBeVisible();
}
const note = { name: 'inspection.txt', mimeType: 'text/plain', buffer: Buffer.from('Inspection evidence from isolated browser tests.') };

test('login, session reload and logout', async ({ page }) => {
  await login(page); await page.reload(); await expect(page.getByRole('heading', { name: 'Fleet priorities at a glance' })).toBeVisible();
  await page.getByRole('button', { name: 'Log out', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Sign in to Altegro' })).toBeVisible();
});

test('Passport history, document upload and download', async ({ page }, testInfo) => {
  await login(page); await page.getByRole('navigation').getByRole('button', { name: 'Robots', exact: true }).click();
  await page.getByRole('button', { name: 'Open Passport AX-DEMO-001', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Complete lifecycle timeline' })).toBeVisible();
  const title = `Browser document ${testInfo.project.name}`; await page.getByLabel('Document title').fill(title); await page.getByLabel('Attachment (maximum 2 MB)', { exact: true }).setInputFiles(note);
  await page.getByRole('button', { name: 'Save document', exact: true }).click(); await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  const document = page.locator('.evidence').filter({ has: page.getByText(title, { exact: true }) }).first();
  const download = page.waitForEvent('download'); await document.getByRole('link', { name: 'Download inspection.txt' }).click(); expect((await download).suggestedFilename()).toBe('inspection.txt');
});

test('support conversation, attachments and status changes', async ({ page }, testInfo) => {
  await login(page); await page.getByRole('navigation').getByRole('button', { name: 'Support', exact: true }).click();
  await page.getByLabel('Support robot').selectOption({ label: 'AX-DEMO-001' }); const title = `Browser support ${testInfo.project.name}`;
  await page.getByLabel('Ticket title').fill(title); await page.getByLabel('Issue description').fill('Please inspect the loading bay sensor.'); await page.getByLabel('Ticket attachment').setInputFiles(note);
  await page.getByRole('button', { name: 'Create ticket', exact: true }).click(); await expect(page.getByRole('heading', { name: `Conversation · ${title}` })).toBeVisible();
  const download = page.waitForEvent('download'); await page.getByRole('link', { name: 'Download inspection.txt' }).click(); expect((await download).suggestedFilename()).toBe('inspection.txt');
  await page.getByLabel('Reply message').fill('Sensor checked and issue resolved.'); await page.getByLabel('Reply status').selectOption('resolved'); await page.getByRole('button', { name: 'Send reply', exact: true }).click();
  await expect(page.getByText('Sensor checked and issue resolved.', { exact: true })).toBeVisible(); await expect(page.getByLabel('Reply status')).toHaveValue('resolved');
});

test('cross-provider maintenance creates, pauses and completes', async ({ page }, testInfo) => {
  await login(page); await page.getByRole('navigation').getByRole('button', { name: 'Events & service', exact: true }).click();
  await page.getByLabel('Maintenance robot').selectOption({ label: 'CB-DEMO-001 · cenobots' }); const title = `CenoBots maintenance ${testInfo.project.name}`;
  await page.getByLabel('Service title').fill(title); await page.getByRole('button', { name: 'Create schedule', exact: true }).click();
  const schedule = page.locator('.schedule-list > article').filter({ hasText: title }); await expect(schedule).toBeVisible(); await schedule.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(schedule.getByRole('button', { name: 'Resume', exact: true })).toBeVisible(); await schedule.getByRole('button', { name: 'Complete', exact: true }).click(); await expect(schedule.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
});

test('qualified scheduling rejects conflicting visits and records completion', async ({ page }, testInfo) => {
  await login(page); await page.getByRole('navigation').getByRole('button', { name: 'Technicians', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Schedule technician visit' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.getByLabel('Visit robot').selectOption({ label: 'AX-DEMO-001' }); await page.getByRole('combobox', { name: 'Qualified technician', exact: true }).selectOption('technician-lena');
  const day = new Date(); day.setDate(day.getDate() + (testInfo.project.name.startsWith('mobile') ? 2 : 1)); const date = day.toISOString().slice(0, 10); const title = `Browser visit ${testInfo.project.name}`;
  await page.getByLabel('Visit title').fill(title); await page.getByLabel('Visit starts').fill(`${date}T10:00`); await page.getByLabel('Visit ends').fill(`${date}T11:00`); await page.getByRole('button', { name: 'Schedule visit', exact: true }).click();
  const order = page.locator('.calendar-order').filter({ hasText: title }); await expect(order).toBeVisible();
  await page.getByLabel('Visit robot').selectOption({ label: 'AX-DEMO-001' }); await page.getByRole('combobox', { name: 'Qualified technician', exact: true }).selectOption('technician-lena'); await page.getByLabel('Visit title').fill('Conflicting visit'); await page.getByLabel('Visit starts').fill(`${date}T10:30`); await page.getByLabel('Visit ends').fill(`${date}T11:30`); await page.getByRole('button', { name: 'Schedule visit', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'already has a work order' })).toBeVisible(); await order.getByLabel('Work status').selectOption('completed'); await order.getByLabel('Completion note').fill('Inspection complete.'); await order.getByRole('button', { name: 'Update work order' }).click(); await expect(order).toContainText('completed');
});

test('fleet comparisons switch site, provider and periods', async ({ page }) => {
  await login(page); await page.getByRole('navigation').getByRole('button', { name: 'Reports', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Fleet comparison', exact: true })).toBeVisible();
  await page.getByLabel('Compare by').selectOption('provider'); await page.getByLabel('Comparison period').selectOption('90'); await expect(page.getByRole('table')).toContainText('autoxing'); await expect(page.getByRole('table')).toContainText('cenobots');
});

test('scheduled reports can be created, paused and deleted', async ({ page }, testInfo) => {
  await login(page); await page.getByRole('navigation').getByRole('button', { name: 'Reports', exact: true }).click();
  const name=`Browser report ${testInfo.project.name}`; await page.getByLabel('Report name').fill(name); await page.getByLabel('Frequency').selectOption('monthly'); await page.getByLabel('Day of month').fill('12'); await page.getByRole('button',{ name:'Create report',exact:true }).click();
  const schedule=page.locator('.schedule-list > article').filter({ hasText:name }); await expect(schedule).toBeVisible(); await expect(schedule).toContainText('admin@demo.altegro.local'); await schedule.getByRole('button',{ name:'Pause',exact:true }).click(); await expect(schedule).toContainText('Paused');
  page.once('dialog',(dialog) => dialog.accept()); await schedule.getByRole('button',{ name:'Delete',exact:true }).click(); await expect(schedule).toHaveCount(0);
});

test('German language option localizes the modern workspace', async ({ page }) => {
  await login(page); await page.getByRole('combobox',{ name:'Language',exact:true }).selectOption('de'); await expect(page.locator('html')).toHaveAttribute('lang','de'); await expect(page.getByRole('heading',{ name:'Flottenprioritäten auf einen Blick' })).toBeVisible();
  await page.getByRole('navigation').getByRole('button',{ name:'Berichte',exact:true }).click(); await expect(page.getByRole('heading',{ name:'Geplante E-Mail-Berichte',exact:true })).toBeVisible(); await page.getByRole('combobox',{ name:'Sprache',exact:true }).selectOption('en'); await expect(page.locator('html')).toHaveAttribute('lang','en');
});

test('technician availability and qualifications update', async ({ page }, testInfo) => {
  await login(page); await page.getByRole('navigation').getByRole('button', { name: 'Technicians', exact: true }).click();
  const availability = page.getByRole('combobox', { name: 'Availability for Elvis Heil', exact: true });
  await availability.selectOption('off_duty'); await expect(availability).toHaveValue('off_duty');
  await page.getByLabel('Visit robot').selectOption({ label: 'AX-DEMO-001' }); await expect(page.getByRole('combobox', { name: 'Qualified technician', exact: true }).locator('option[value="technician-elvis"]')).toHaveCount(0);
  await availability.selectOption('available'); await expect(page.getByRole('combobox', { name: 'Qualified technician', exact: true }).locator('option[value="technician-elvis"]')).toHaveCount(1);
  await page.getByLabel('Qualification technician').selectOption('technician-elvis'); const code = `browser_skill_${testInfo.project.name.replaceAll('-', '_')}`;
  await page.getByLabel('Qualification code').fill(code); await page.getByRole('button', { name: 'Save qualification', exact: true }).click(); await expect(page.locator('.evidence').filter({ hasText: 'Elvis Heil' })).toContainText(code);
});

test('auditor sees read-only support and no scheduling controls', async ({ page }) => {
  await login(page, 'auditor'); await expect(page.getByRole('navigation').getByRole('button', { name: 'Technicians', exact: true })).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button', { name: 'Support', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Support tickets', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Create ticket', exact: true })).toHaveCount(0);
});
