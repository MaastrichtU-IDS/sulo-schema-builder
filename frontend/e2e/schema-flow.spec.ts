import { test, expect } from '@playwright/test';

// End-to-end smoke flow against the running stack (Vite :5173 + API :3001 + QLever).
//
// One-time setup:
//   npm i -D @playwright/test
//   npx playwright install chromium
// Run (with the app and QLever already up):
//   npx playwright test
//
// These tests exercise the real UI: seeding the example schema, editing a
// property's OWL characteristics, and verifying the generated OWL export.

const BASE = 'http://localhost:5173';

test.describe('Schema builder — core flow', () => {
  test('loads the example schema and shows its classes', async ({ page }) => {
    await page.goto(`${BASE}/ontology`);
    await page.getByRole('button', { name: 'Load Example' }).click();
    // After seeding, the app navigates to the schema detail page.
    await expect(page).toHaveURL(/\/ontology\/[0-9a-f-]+$/, { timeout: 30_000 });
    await expect(page.getByText('Clinical Health Record Schema')).toBeVisible();
    await expect(page.getByText('ClinicalVisit')).toBeVisible();
  });

  test('marks a property Functional and the OWL export reflects it', async ({ page }) => {
    await page.goto(`${BASE}/ontology`);
    await page.locator('a[href*="/ontology/"]').first().click();
    await page.waitForLoadState('networkidle');

    // Open the Properties tab and edit the first property.
    await page.getByRole('button', { name: 'Properties' }).first().click();
    await page.getByRole('button', { name: 'Edit' }).first().click();

    // Tick the Functional characteristic.
    const functional = page.getByRole('checkbox', { name: /^Functional/ });
    await functional.scrollIntoViewIfNeeded();
    await functional.check();
    await page.getByRole('button', { name: /Save changes/ }).click();

    // Open Generate → OWL + SULO and assert the characteristic is emitted.
    await page.getByRole('button', { name: 'Generate' }).first().click();
    await page.getByRole('button', { name: /OWL/ }).click();
    await expect(page.getByText(/owl:FunctionalProperty/)).toBeVisible({ timeout: 10_000 });
  });

  test('rejects a class name containing spaces', async ({ page }) => {
    await page.goto(`${BASE}/ontology`);
    await page.locator('a[href*="/ontology/"]').first().click();
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /Add class/i }).first().click();
    await page.getByPlaceholder(/e\.g\./i).first().fill('Bad Name');
    await page.getByRole('button', { name: /Add Class/i }).click();
    await expect(page.getByText('No spaces allowed')).toBeVisible();
  });
});
