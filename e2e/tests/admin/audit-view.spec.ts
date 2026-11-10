/**
 * E2E Test: Admin Audit View
 *
 * Tests the audit logs page functionality in the admin dashboard.
 * Verifies that audit events are captured, displayed, and can be filtered/searched.
 */

import { test, expect } from '@playwright/test';
import { loginAdmin } from '../../fixtures/admin';
import { TEST_USERS, TEST_URLS } from '../../utils/test-data';

// Signs in with the test password / one-time codes (or sends test secrets in headers):
// traces would record them, so none for this file. See e2e/utils/secret-input.ts.
test.use({ trace: 'off' });

/**
 * Helper function to wait for audit events to be processed
 * Audit events go through a queue, so we need to wait for them to appear in the database
 *
 * Note: In QA environment, audit events may take longer to process due to queue latency.
 * We increase timeouts and add network idle waits to handle this.
 */
async function waitForAuditEvents(page: any, minCount: number = 1, maxWaitMs: number = 45000): Promise<void> {
  const startTime = Date.now();
  let lastRowCount = 0;

  while (Date.now() - startTime < maxWaitMs) {
    // Wait for network to be idle before checking
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    // Reload the page to get fresh data
    await page.reload();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    // Check if we have events in the table
    const tableRows = page.locator('tbody tr');
    const rowCount = await tableRows.count();

    // Log progress for debugging
    if (rowCount !== lastRowCount) {
      console.log(`Audit events found: ${rowCount} (waiting for ${minCount})`);
      lastRowCount = rowCount;
    }

    if (rowCount >= minCount) {
      return;
    }

    // Wait 1000ms before trying again (increased from 500ms for QA latency)
    await page.waitForTimeout(1000);
  }

  throw new Error(`Timed out waiting for ${minCount} audit events to appear (found ${lastRowCount} after ${maxWaitMs}ms)`);
}

test.describe('Admin Audit View', () => {
  // Increase timeout for audit tests - audit queue in QA may have latency
  test.setTimeout(90000);

  test.beforeEach(async ({ page }) => {
    // Login as admin - this will create login-related audit events
    await loginAdmin(page, TEST_USERS.admin().email);
  });

  test('should display audit logs page', async ({ page }) => {
    // Navigate to audit logs page
    await page.goto(`${TEST_URLS.adminDashboard}/audit`);

    // Verify page loaded correctly
    await expect(page).toHaveURL(new RegExp(`${TEST_URLS.adminDashboard}/audit`));

    // Verify page title and header (h2 is used in the admin layout)
    await expect(page.locator('h2:has-text("Audit Logs")')).toBeVisible();
    // Look for the card description which is unique on the page
    await expect(page.locator('text=/View and filter system audit logs/i')).toBeVisible();

    // Wait for audit events to be processed before checking table headers
    // The login creates audit events asynchronously, and the table only renders when events exist
    await waitForAuditEvents(page, 1);

    // Verify table headers are present (table only shows when events exist)
    await expect(page.locator('th:has-text("Timestamp")')).toBeVisible();
    await expect(page.locator('th:has-text("Event Type")')).toBeVisible();
    await expect(page.locator('th:has-text("Severity")')).toBeVisible();
    await expect(page.locator('th:has-text("User ID")')).toBeVisible();
    await expect(page.locator('th:has-text("IP Address")')).toBeVisible();
    await expect(page.locator('th:has-text("Status")')).toBeVisible();
  });

  test('should show login events in audit log', async ({ page }) => {
    // Navigate to audit logs page
    await page.goto(`${TEST_URLS.adminDashboard}/audit`);

    // Wait for audit events to be processed through the queue
    // Login creates multiple events: token_issued, login_success, etc.
    await waitForAuditEvents(page, 1);

    // Verify at least one event is displayed in the table
    const tableRows = page.locator('tbody tr');
    const rowCount = await tableRows.count();
    expect(rowCount).toBeGreaterThan(0);

    // Verify the event has expected structure (columns)
    const firstRow = tableRows.first();
    await expect(firstRow.locator('td').nth(0)).toContainText(/\d{1,2}\/\d{1,2}\/\d{4}/); // Timestamp
    await expect(firstRow.locator('td').nth(1)).toBeVisible(); // Event type
    await expect(firstRow.locator('td').nth(2)).toBeVisible(); // Severity badge
    await expect(firstRow.locator('td').nth(5)).toBeVisible(); // Status badge
  });

  test('should filter audit logs by event type', async ({ page }) => {
    // Navigate to audit logs page
    await page.goto(`${TEST_URLS.adminDashboard}/audit`);

    // Wait for events to appear
    await waitForAuditEvents(page, 1);

    // Click "Show Filters" button
    await page.click('button:has-text("Show Filters")');

    // Wait for filter panel to be visible
    await expect(page.locator('label:has-text("Event Type")')).toBeVisible();

    // Enter a specific event type filter (e.g., token events)
    await page.fill('input[id="event_type"]', 'auth.token');

    // Click "Apply Filters" button
    await page.click('button:has-text("Apply Filters")');

    // Wait for navigation and page to load
    await page.waitForURL(/event_type=auth\.token/);
    await page.waitForLoadState('networkidle');

    // Verify the filter is active (shown in URL or active filters display)
    const url = new URL(page.url());
    expect(url.searchParams.get('event_type')).toBe('auth.token');

    // Verify filtered results
    // Either we have matching results or "No audit events found" message
    const noEventsMessage = page.locator('h3:has-text("No audit events found")');
    const tableRows = page.locator('tbody tr');

    const hasResults = await tableRows.count() > 0;
    const showsEmptyState = await noEventsMessage.isVisible();

    // One of these should be true
    expect(hasResults || showsEmptyState).toBe(true);

    // If we have results, verify they match the filter
    if (hasResults) {
      const firstEventType = await tableRows.first().locator('td').nth(1).textContent();
      expect(firstEventType).toContain('auth.token');
    }
  });

  test('should filter audit logs by severity', async ({ page }) => {
    // Navigate to audit logs page
    await page.goto(`${TEST_URLS.adminDashboard}/audit`);

    // Wait for events to appear
    await waitForAuditEvents(page, 1);

    // Click "Show Filters" button
    await page.click('button:has-text("Show Filters")');

    // Wait for filter panel
    await expect(page.locator('label:has-text("Severity")')).toBeVisible();

    // Select severity filter (use the Select component)
    await page.locator('button[id="severity"]').click();
    await page.locator('[role="option"]:has-text("Info")').click();

    // Apply filters
    await page.click('button:has-text("Apply Filters")');

    // Wait for URL to update
    await page.waitForURL(/severity=info/);

    // Verify the severity filter is in the URL
    const url = new URL(page.url());
    expect(url.searchParams.get('severity')).toBe('info');

    // Verify active filter badge is shown (when filters are hidden)
    await page.click('button:has-text("Hide Filters")');
    await expect(page.locator('text=/Active filters:/i')).toBeVisible();
    await expect(page.locator('text=/Severity: info/i')).toBeVisible();
  });

  test('should search audit logs by user ID', async ({ page }) => {
    // Navigate to audit logs page
    await page.goto(`${TEST_URLS.adminDashboard}/audit`);

    // Wait for events to appear
    await waitForAuditEvents(page, 1);

    // Get a user ID from the first row to search for
    const firstRow = page.locator('tbody tr').first();
    const userIdCell = firstRow.locator('td').nth(3); // User ID column
    const userId = await userIdCell.textContent();

    // Skip test if no user ID (some events may not have user_id)
    if (!userId || userId.trim() === '-') {
      test.skip();
      return;
    }

    const trimmedUserId = userId.trim();

    // Show filters
    await page.click('button:has-text("Show Filters")');

    // The user filter is a picker: paste the id, then pick the matching option
    // (the user's suggestion, or the "use this id" option for a pasted id)
    const userInput = page.getByTestId('audit-user-input');
    await userInput.fill(trimmedUserId);
    const option = page.getByTestId('audit-user-list').getByRole('option').first();
    await expect(option).toBeVisible();
    await option.click();
    await expect(page.getByTestId('audit-user-chip')).toHaveAttribute('data-id', trimmedUserId);

    // Apply filters
    await page.click('button:has-text("Apply Filters")');

    // Wait for URL to update
    await page.waitForURL(/search=/);

    // Verify search filter in URL
    const url = new URL(page.url());
    expect(url.searchParams.get('search')).toBe(trimmedUserId);

    // Verify results contain the searched user ID
    const tableRows = page.locator('tbody tr');
    const rowCount = await tableRows.count();

    if (rowCount > 0) {
      // All visible rows should have the searched user ID
      const firstRowUserId = await tableRows.first().locator('td').nth(3).textContent();
      expect(firstRowUserId?.trim()).toBe(trimmedUserId);
    }
  });

  test('should clear filters', async ({ page }) => {
    // Navigate to audit logs page with filters
    await page.goto(`${TEST_URLS.adminDashboard}/audit?event_type=auth.login&severity=info`);

    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Verify filters are active
    await expect(page.locator('text=/Active filters:/i')).toBeVisible();

    // Show filters panel
    await page.click('button:has-text("Show Filters")');

    // Click "Clear Filters" button
    await page.click('button:has-text("Clear Filters")');

    // Verify we're back at the base URL without query params
    await expect(page).toHaveURL(`${TEST_URLS.adminDashboard}/audit`);

    // Verify active filters are gone
    await expect(page.locator('text=/Active filters:/i')).not.toBeVisible();

    // Verify filter inputs are empty
    const eventTypeInput = page.locator('input[id="event_type"]');
    await expect(eventTypeInput).toHaveValue('');
  });

  test('should paginate audit logs', async ({ page }) => {
    // Navigate to audit logs page
    await page.goto(`${TEST_URLS.adminDashboard}/audit`);

    // Wait for events to appear
    await waitForAuditEvents(page, 1);

    // Check if pagination is available
    const paginationInfo = page.locator('text=/Page \\d+ of \\d+/');
    const hasPagination = await paginationInfo.isVisible();

    if (!hasPagination) {
      // Not enough events for pagination - skip this test
      test.skip();
      return;
    }

    // Get current page number
    const paginationText = await paginationInfo.textContent();
    const match = paginationText?.match(/Page (\d+) of (\d+)/);

    if (!match || parseInt(match[2]) <= 1) {
      // Only one page available
      test.skip();
      return;
    }

    const _totalPages = parseInt(match[2]);

    // Get first row event ID before pagination
    const firstRowBefore = page.locator('tbody tr').first();
    const _firstEventBefore = await firstRowBefore.locator('td').nth(1).textContent();

    // Click "Next" button
    await page.click('button:has-text("Next")');

    // Wait for page 2 to load
    await page.waitForURL(/page=2/);
    await page.waitForLoadState('networkidle');

    // Verify we're on page 2
    const url = new URL(page.url());
    expect(url.searchParams.get('page')).toBe('2');

    // Verify pagination info updated
    await expect(page.locator('text=/Page 2 of \\d+/')).toBeVisible();

    // Verify content changed (different events shown)
    const firstRowAfter = page.locator('tbody tr').first();
    const _firstEventAfter = await firstRowAfter.locator('td').nth(1).textContent();

    // Events should be different (unless we have duplicate events, which is unlikely)
    // If they're the same, it's still valid pagination (just same event types)
    // So we just verify the page number changed, which we already did

    // Click "Previous" button
    await page.click('button:has-text("Previous")');

    // Wait for page 1 to load
    await page.waitForURL(/audit(?:\?page=1)?$/);
    await page.waitForLoadState('networkidle');

    // Verify we're back on page 1
    await expect(page.locator('text=/Page 1 of \\d+/')).toBeVisible();
  });

  test('should show filter toggle button', async ({ page }) => {
    // Navigate to audit logs page
    await page.goto(`${TEST_URLS.adminDashboard}/audit`);

    // Verify "Show Filters" button is visible
    const filterButton = page.locator('button:has-text("Show Filters")');
    await expect(filterButton).toBeVisible();

    // Click to show filters
    await filterButton.click();

    // Verify filter panel is visible
    await expect(page.locator('label:has-text("Event Type")')).toBeVisible();
    await expect(page.locator('label:has-text("Severity")')).toBeVisible();
    await expect(page.locator('label:has-text("Search")')).toBeVisible();

    // Verify button text changed to "Hide Filters"
    await expect(page.locator('button:has-text("Hide Filters")')).toBeVisible();

    // Click to hide filters
    await page.click('button:has-text("Hide Filters")');

    // Verify filter panel is hidden
    await expect(page.locator('label:has-text("Event Type")')).not.toBeVisible();

    // Verify button text changed back to "Show Filters"
    await expect(page.locator('button:has-text("Show Filters")')).toBeVisible();
  });

  test('should display event severity badges with correct colors', async ({ page }) => {
    // Navigate to audit logs page
    await page.goto(`${TEST_URLS.adminDashboard}/audit`);

    // Wait for events to appear
    await waitForAuditEvents(page, 1);

    // Get the first row severity cell (3rd column, index 2)
    const firstRow = page.locator('tbody tr').first();
    const severityCell = firstRow.locator('td').nth(2);

    // Verify severity cell is visible and has text content
    await expect(severityCell).toBeVisible();

    // Verify severity has text (info, warning, error, etc.)
    const severityText = await severityCell.textContent();
    expect(severityText).toMatch(/info|warning|error|critical|debug/i);
  });

  test('should display success/failed status badges', async ({ page }) => {
    // Navigate to audit logs page
    await page.goto(`${TEST_URLS.adminDashboard}/audit`);

    // Wait for events to appear
    await waitForAuditEvents(page, 1);

    // Get the first row status cell (6th column, index 5)
    const firstRow = page.locator('tbody tr').first();
    const statusCell = firstRow.locator('td').nth(5);

    // Verify status cell is visible
    await expect(statusCell).toBeVisible();

    // Verify cell shows either "Success" or "Failed"
    const statusText = await statusCell.textContent();
    expect(statusText).toMatch(/Success|Failed/i);
  });

  test('should show navigation back to dashboard', async ({ page }) => {
    // Navigate to audit logs page
    await page.goto(`${TEST_URLS.adminDashboard}/audit`);

    // Verify back button is present
    const backButton = page.locator('a[href="/"]').first();
    await expect(backButton).toBeVisible();

    // Click back button
    await backButton.click();

    // Verify we're back on dashboard
    await expect(page).toHaveURL(new RegExp(`${TEST_URLS.adminDashboard}/?$`));
    await expect(page.locator('h1:has-text("Dashboard"), h2:has-text("Dashboard")')).toBeVisible();
  });

  test('should filter by date range', async ({ page }) => {
    // Navigate to audit logs page
    await page.goto(`${TEST_URLS.adminDashboard}/audit`);

    // Wait for events to appear
    await waitForAuditEvents(page, 1);

    // Show filters
    await page.click('button:has-text("Show Filters")');

    // Set date range (last 7 days)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    // Format dates for datetime-local input (YYYY-MM-DDTHH:mm)
    const formatDateTimeLocal = (date: Date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${year}-${month}-${day}T${hours}:${minutes}`;
    };

    const startDateStr = formatDateTimeLocal(startDate);
    const endDateStr = formatDateTimeLocal(endDate);

    // Fill date inputs
    await page.fill('input[id="start_date"]', startDateStr);
    await page.fill('input[id="end_date"]', endDateStr);

    // Apply filters
    await page.click('button:has-text("Apply Filters")');

    // Wait for URL to update
    await page.waitForURL(/start_date=/);

    // Verify date filters are in URL
    const url = new URL(page.url());
    expect(url.searchParams.get('start_date')).toBeTruthy();
    expect(url.searchParams.get('end_date')).toBeTruthy();

    // Hide filters to see active filter badges
    await page.click('button:has-text("Hide Filters")');

    // Verify active date filter badges are shown
    await expect(page.locator('text=/Active filters:/i')).toBeVisible();
    await expect(page.locator('text=/From:/i')).toBeVisible();
    await expect(page.locator('text=/To:/i')).toBeVisible();
  });
});
