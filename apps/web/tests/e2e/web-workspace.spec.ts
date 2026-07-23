import { expect, test } from '@playwright/test';

test('profile search filters the project-style profile list', async ({ page }) => {
  await page.goto('/agent');
  const search = page.getByLabel('Search profiles');
  await search.fill('RESEARCH');
  await expect(page.getByRole('button', { name: /research-lab/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /^default/i })).toHaveCount(0);

  await search.press('ArrowDown');
  await expect(page.getByRole('button', { name: /research-lab/i })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/agent\/research-lab$/);
});

test('session search, archive, drafts, and image gallery work together', async ({ page }) => {
  await page.goto('/agent/default/session-gallery');
  await expect(page.getByText('Image gallery', { exact: true }).first()).toBeVisible();
  const composer = page.getByPlaceholder('Message the agent…');
  await composer.fill('gallery draft');

  await page.getByText('Travel notes', { exact: true }).click();
  await expect(page).toHaveURL(/session-travel$/);
  await composer.fill('travel draft');
  await page.getByText('Image gallery', { exact: true }).first().click();
  await expect(composer).toHaveValue('gallery draft');

  await page.getByLabel('Search sessions').fill('travel');
  await expect(page.getByText('Travel notes', { exact: true })).toBeVisible();
  await expect(page.getByText('Image gallery', { exact: true })).toHaveCount(0);
  await page.getByLabel('Search sessions').fill('');

  await page.getByLabel('Session actions for Travel notes').click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(page.getByText('Travel notes', { exact: true })).toHaveCount(0);
  await page.getByTitle('Show archived sessions').click();
  await expect(page.getByText('Travel notes', { exact: true })).toBeVisible();

  await page.getByTitle('Show active sessions').click();
  await page.getByText('Image gallery', { exact: true }).first().click();
  await page.getByLabel('Preview Image 1').click();
  await expect(page.getByRole('dialog', { name: 'Image 1 preview' })).toBeVisible();
  await expect(page.getByText('1 / 2')).toBeVisible();
  await page.getByLabel('Next image').click();
  await expect(page.getByText('2 / 2')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /preview/ })).toHaveCount(0);
});

test('session dialogs and global settings are keyboard-operable', async ({ page }) => {
  await page.goto('/agent/default/session-gallery');
  await page.getByLabel('Session actions for Image gallery').click();
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('Enter');
  const renameDialog = page.getByRole('dialog', { name: 'Rename session' });
  await expect(renameDialog).toBeVisible();
  await expect(page.getByLabel('Session name')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(renameDialog).toHaveCount(0);
  await expect(page.getByLabel('Session actions for Image gallery')).toBeFocused();

  await page.goto('/config/agent');
  await expect(page.getByText('Agent defaults', { exact: true }).last()).toBeVisible();
  const shellApproval = page.getByRole('radiogroup', { name: 'Run shell commands approval' });
  await shellApproval.getByRole('radio', { name: 'Deny' }).click();
  await expect(shellApproval.getByRole('radio', { name: 'Deny' })).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('button', { name: 'Web search' }).click();
  await expect(page.getByText('Web search', { exact: true }).last()).toBeVisible();
  await page.getByRole('radiogroup', { name: 'Web-search tool' }).getByRole('radio', { name: 'On' }).click();
  await expect(page.getByRole('radiogroup', { name: 'Web-search tool' }).getByRole('radio', { name: 'On' }))
    .toHaveAttribute('aria-checked', 'true');

  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
