import { expect, test, type Route } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import * as fs from 'node:fs/promises';

test('guest downloads an expired-run artifact to the browser and restores it after reload', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/agent');
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: /Home workspace Paired/ }).click();
  await page.getByRole('button', { name: 'Use at startup' }).click();
  try {
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByText('remote-only', { exact: true })).toBeVisible();
    await page.goto('/agent/remote-only/session-download');
    const button = page.getByRole('button', { name: 'Download home-desktop.png' });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(button).toBeVisible();
      await expect(page.getByRole('button', { name: 'Download expired-desktop.png' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Download expired-desktop.png' })).toBeDisabled();
      await expect(page.getByRole('status').filter({ hasText: 'This file has expired or was removed.' })).toBeVisible();
      const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
      expect(download.suggestedFilename()).toBe('home-desktop.png');
      expect(await download.failure()).toBeNull();
      const saved = testInfo.outputPath(`download-${attempt}.png`);
      await download.saveAs(saved);
      const bytes = await fs.readFile(saved);
      expect(bytes.subarray(1, 4).toString()).toBe('PNG');
      expect(bytes.readUInt32BE(16)).toBe(1920);
      expect(bytes.readUInt32BE(20)).toBe(1080);
      expect(download.url()).toMatch(/^http:\/\/127\.0\.0\.1:32141\/v1\/downloads\/[a-f0-9]{48}$/);
      await page.reload();
    }
    await expect(button).toBeVisible();
    const files = page.getByRole('region', { name: 'Generated files' });
    const answer = page.getByText('The screenshot is ready.', { exact: true });
    expect((await files.boundingBox())!.y).toBeGreaterThan((await answer.boundingBox())!.y);
    await expect(page.getByRole('button', { name: 'Download worklogs.csv' })).toBeVisible();
    const [document] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download worklogs.csv' }).click()]);
    await document.saveAs(testInfo.outputPath('worklogs.csv'));
    expect(await fs.readFile(testInfo.outputPath('worklogs.csv'), 'utf8')).toBe('Date,Hours\n2026-09-16,8\n');
    const thumbnail = files.getByRole('img', { name: 'home-desktop.png' });
    await expect(thumbnail).toBeVisible();
    expect(await thumbnail.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(480);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      // Read both boxes together after the responsive shell has settled.
      await expect.poll(() => thumbnail.evaluate(node => {
        const image = node.getBoundingClientRect();
        const content = node.closest('section')!.getBoundingClientRect();
        return Math.abs(image.width + 2 - content.width / 2);
      })).toBeLessThan(1);
      const imageBox = (await thumbnail.boundingBox())!;
      expect(Math.abs(imageBox.width / imageBox.height - 1920 / 1080)).toBeLessThan(0.02);
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    let releasePreview!: () => void;
    const previewGate = new Promise<void>(resolve => { releasePreview = resolve; });
    let previewRequests = 0;
    const delayPreview = async (route: Route) => {
      if (route.request().resourceType() === 'image') { previewRequests++; await previewGate; }
      await route.continue();
    };
    await page.route('**/v1/downloads/*', delayPreview);
    const viewerResponse = page.waitForResponse(response => response.url().includes('/v1/downloads/') && response.request().resourceType() === 'image');
    await page.getByRole('button', { name: 'Preview home-desktop.png', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'home-desktop.png preview' });
    await expect(dialog.getByRole('img')).toBeVisible();
    await expect.poll(() => previewRequests).toBe(1);
    expect(await dialog.getByRole('img').evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(480);
    await expect(dialog.getByRole('button', { name: 'View image at full size' })).toBeDisabled();
    const beforePreview = (await dialog.getByRole('img').boundingBox())!;
    const beforeDownload = (await dialog.getByRole('button', { name: 'Download image' }).boundingBox())!;
    expect(beforePreview.width).toBeGreaterThan(480);
    releasePreview();
    await expect.poll(() => dialog.getByRole('img').evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1920);
    const afterPreview = (await dialog.getByRole('img').boundingBox())!;
    const afterDownload = (await dialog.getByRole('button', { name: 'Download image' }).boundingBox())!;
    for (const dimension of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(afterPreview[dimension] - beforePreview[dimension])).toBeLessThan(1);
      expect(Math.abs(afterDownload[dimension] - beforeDownload[dimension])).toBeLessThan(1);
    }
    expect(previewRequests).toBe(1);
    await page.unroute('**/v1/downloads/*', delayPreview);
    const viewer = await viewerResponse;
    expect(viewer.headers()['content-type']).toContain('image/webp');
    expect((await viewer.body()).length).toBeLessThanOrEqual(1_000_000);
    await dialog.getByRole('button', { name: 'View image at full size' }).click();
    await expect(dialog.getByRole('button', { name: 'Fit image to window' })).toBeVisible();
    const [fullImage] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download image' }).click()]);
    expect(fullImage.suggestedFilename()).toBe('home-desktop.png');
    expect(await fullImage.failure()).toBeNull();
    await page.screenshot({ path: '../../output/playwright/artifact-full-image.png' });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Download expired-desktop.png' })).toBeDisabled();
    await page.getByRole('log', { name: 'Conversation' }).evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: '../../output/playwright/unavailable-download.png' });
  } finally { await request.put('/v1/workspaces/default', { data: { id: 'local' } }); }
});

test('Agent and Apps reuse one sidebar shell and header toggle', async ({ page }) => {
  await page.goto('/agent');
  const profilesSidebar = page.getByRole('navigation', { name: 'Profiles' });
  const resizeHandle = page.getByRole('separator', { name: 'Resize sidebar' });
  await expect(profilesSidebar).toBeVisible();
  await resizeHandle.press('ArrowRight');
  await resizeHandle.press('ArrowRight');
  const profileBox = await profilesSidebar.boundingBox();

  await page.getByRole('tab', { name: 'Apps' }).click();
  await expect(page).toHaveURL(/\/apps\/translator$/);
  const appsSidebar = page.getByRole('navigation', { name: 'Apps' });
  await expect(appsSidebar.getByLabel('Search apps')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toBeVisible();
  const appsBox = await appsSidebar.boundingBox();
  expect(Math.round(appsBox?.width ?? 0)).toBe(Math.round(profileBox?.width ?? -1));

  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expect(appsSidebar).toHaveCount(0);
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(page.getByRole('navigation', { name: 'Apps' })).toBeVisible();
});

test('Connection switches the local Web shell between named Marifold servers', async ({ page }) => {
  await page.goto('/agent');
  await expect(page.getByText('research-lab', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Workspace' }).click();
  await page.getByRole('button', { name: 'Direct servers' }).click();
  await page.getByRole('button', { name: 'Add server' }).click();
  await page.getByLabel('Server name').fill('Remote fixture');
  await page.getByLabel('Service URL').fill('http://127.0.0.1:32142');
  await page.getByLabel('Bearer token').fill('remote-fixture-token');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();

  await expect(page.getByText('remote-only', { exact: true })).toBeVisible();
  await expect(page.getByText('research-lab', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Remote fixture', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText('remote-only', { exact: true })).toBeVisible();
  await expect(page.getByText('Remote fixture', { exact: true })).toBeVisible();

  await page.goto('/agent/remote-only/session-download');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download home-desktop.png' }).click()]);
  expect(download.url()).toMatch(/^http:\/\/127\.0\.0\.1:32142\/v1\/downloads\/[a-f0-9]{48}$/);
  expect(await download.failure()).toBeNull();
  await expect(page.getByRole('img', { name: 'home-desktop.png' })).toBeVisible();

  await page.getByRole('button', { name: 'Workspace' }).click();
  await page.getByRole('button', { name: 'Direct servers' }).click();
  await page.getByRole('button', { name: /This server/ }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();

  await expect(page.getByText('research-lab', { exact: true })).toBeVisible();
  await expect(page.getByText('remote-only', { exact: true })).toHaveCount(0);
});

test('paired workspaces share host data and preserve separate local drafts and startup defaults', async ({ page, request }) => {
  await page.goto('/agent/default/session-gallery');
  const composer = page.getByPlaceholder('Message the agent…');
  await composer.fill('private Local draft');
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: /Home workspace Paired/ }).click();
  await expect(page.getByLabel('Allow agent tools on this device')).not.toBeChecked();
  await page.getByLabel('Allow agent tools on this device').check();
  await expect(page.getByLabel('Allow agent tools on this device')).toBeChecked();
  await page.screenshot({ path: '../../output/playwright/workspace-picker.png' });
  await page.getByRole('button', { name: 'Use at startup' }).click();
  try {
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByText('remote-only', { exact: true })).toBeVisible();
    await expect(page.getByText('research-lab', { exact: true })).toHaveCount(0);
    await page.getByText('remote-only', { exact: true }).click();
    await expect(composer).toHaveValue('');
    await composer.fill('private Home draft');
    await page.reload();
    await expect(page.getByText('remote-only', { exact: true })).toBeVisible();
    await expect(composer).toHaveValue('private Home draft');
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page.getByRole('button', { name: /Local This device/ }).click();
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open profile config for default' })).toBeVisible();
    await expect(composer).toHaveValue('private Local draft');
    await page.screenshot({ path: '../../output/playwright/workspace-local.png' });
  } finally { await request.put('/v1/workspaces/default', { data: { id: 'local' } }); }
});

test('profile search filters the project-style profile list', async ({ page }) => {
  await page.goto('/agent');
  await expect(page.getByText('Research reply preview.')).toBeVisible();
  await expect(page.locator('[data-profile-row] time').first()).toBeVisible();
  const avatar = page.locator('[data-profile-row]').first().locator('[aria-hidden="true"]').first();
  await expect(avatar).toHaveCSS('width', '40px');
  await expect(avatar).toHaveCSS('height', '40px');

  const search = page.getByLabel('Search profiles');
  await search.fill('RESEARCH');
  const researchRow = page.locator('[data-profile-row]').filter({ hasText: 'research-lab' });
  await expect(researchRow).toBeVisible();
  await expect(page.locator('[data-profile-row]').filter({ hasText: 'default' })).toHaveCount(0);

  await search.press('ArrowDown');
  await expect(researchRow).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/agent\/research-lab$/);
});

test('profile actions pin contacts, open Config, and double-confirm removal', async ({ page }) => {
  await page.goto('/agent');
  await page.getByLabel('Profile actions for research-lab').click();
  await page.getByRole('menuitem', { name: 'Pin' }).click();
  await expect(page.getByTitle('Pinned').first()).toBeVisible();

  await page.getByLabel('Profile actions for research-lab').click();
  await page.getByRole('menuitem', { name: 'Config' }).click();
  await expect(page).toHaveURL(/\/config\/profiles\/research-lab$/);

  await page.getByRole('button', { name: 'Remove profile' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Remove “research-lab”?' });
  await expect(dialog).toBeVisible();
  const finalRemove = dialog.getByRole('button', { name: 'Remove profile' });
  await expect(finalRemove).toBeDisabled();
  await dialog.getByLabel('Profile name confirmation').fill('research-lab');
  await expect(finalRemove).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});

test('session sidebar profile header opens the selected profile Config', async ({ page }) => {
  await page.goto('/agent/default/session-gallery');
  const sessionsSidebar = page.getByRole('navigation', { name: 'Sessions' });
  const avatarButton = sessionsSidebar.getByRole('button', { name: 'Open profile config for default' });

  await expect(sessionsSidebar.getByText('marifold', { exact: true })).toHaveCSS('font-size', '14px');
  await expect(sessionsSidebar.getByText('default', { exact: true })).toHaveCSS('font-size', '16px');
  await expect(avatarButton).toHaveCSS('cursor', 'pointer');

  await avatarButton.click();
  await expect(page).toHaveURL(/\/config\/profiles\/default$/);
});

test('modern Office files are extracted locally into composer attachments', async ({ page }) => {
  await page.goto('/agent/default/session-gallery');
  const docx = zipSync({
    'word/document.xml': strToU8(`
      <w:document xmlns:w="urn:word"><w:body>
        <w:p><w:r><w:t>Browser Office fixture</w:t></w:r></w:p>
      </w:body></w:document>`),
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: 'brief.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from(docx),
  });

  await expect(page.getByText('brief.docx')).toBeVisible();
  await expect(page.getByTitle(/Word document · .* extracted text/)).toBeVisible();
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
  await page.getByRole('radiogroup', { name: 'Web search enabled' }).getByRole('radio', { name: 'On' }).click();
  await expect(page.getByRole('radiogroup', { name: 'Web search enabled' }).getByRole('radio', { name: 'On' }))
    .toHaveAttribute('aria-checked', 'true');

  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
