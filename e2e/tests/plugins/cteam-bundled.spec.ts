import { expect, test } from '../../fixtures/test.fixture';
import {
  enablePluginWithVerification,
  waitForPluginManagementInit,
} from '../../helpers/plugin-test.helpers';

test.describe('CTeam bundled plugin', () => {
  test('configures multiple work-item types in one project integration', async ({
    page,
    workViewPage,
  }) => {
    await workViewPage.waitForTaskList();
    expect(await waitForPluginManagementInit(page)).toBeTruthy();
    expect(await enablePluginWithVerification(page, 'CTeam', 15000)).toBeTruthy();
    const card = page
      .locator('plugin-management mat-card')
      .filter({ has: page.locator('mat-card-title', { hasText: /^CTeam$/ }) });
    await card.getByRole('button', { name: 'Set up in Issue Provider Panel' }).click();

    await expect(page.locator('issue-panel')).toBeVisible();
    await page.locator('issue-panel mat-tab-group .mat-mdc-tab:last-child').click();
    await expect(page.locator('issue-provider-setup-overview')).toBeVisible();
    await page
      .locator('issue-provider-setup-overview button.provider-tile')
      .filter({ hasText: 'CTeam' })
      .click();

    const dialog = page.locator('mat-dialog-container');
    const additionalTypes = dialog.getByLabel('Additional work-item types (optional)');
    await expect(additionalTypes).toBeVisible();
    await additionalTypes.fill('BUG:688\nDEMAND:693\nTASK:690');
    await expect(additionalTypes).toHaveValue('BUG:688\nDEMAND:693\nTASK:690');
    await dialog.locator('mat-dialog-actions button').first().click();
    await expect(dialog).toBeHidden();
  });

  test('loads the real bundled credentials UI and stores credentials only on this device', async ({
    page,
    workViewPage,
  }) => {
    await workViewPage.waitForTaskList();
    expect(await waitForPluginManagementInit(page)).toBeTruthy();
    expect(await enablePluginWithVerification(page, 'CTeam', 15000)).toBeTruthy();
    await expect(
      page.locator('.nav-sidenav .nav-label').filter({ hasText: /^CTeam$/ }),
    ).toHaveCount(0);
    const card = page
      .locator('plugin-management mat-card')
      .filter({ has: page.locator('mat-card-title', { hasText: /^CTeam$/ }) });
    await card
      .locator('button')
      .filter({
        has: page.locator('mat-icon', { hasText: /^settings$/ }),
      })
      .click();
    await expect(page).toHaveURL(/plugins\/cteam-issue-provider\/index/);
    const frame = page.frameLocator('plugin-index iframe');
    await expect(
      frame.getByRole('heading', { name: 'CTeam local credentials' }),
    ).toBeVisible();
    await frame.getByLabel('DevOps user ID').fill('test-not-a-real-user');
    await frame.getByLabel('DevOps access token').fill('test-not-a-real-token');
    await frame.getByRole('button', { name: 'Save on this device' }).click();
    await expect(frame.locator('#status')).toHaveText('Saved on this device.');
    await expect(frame.getByLabel('DevOps access token')).toHaveValue('');

    await page.reload();
    await expect(frame.locator('#status')).toHaveText(
      'Local credentials are configured. The token is not displayed.',
    );
    await expect(frame.getByLabel('DevOps user ID')).toHaveValue('test-not-a-real-user');
    await expect(frame.getByLabel('DevOps access token')).toHaveValue('');
    await frame.getByRole('button', { name: 'Remove local credentials' }).click();
    await expect(frame.locator('#status')).toHaveText('Local credentials removed.');
  });
});
