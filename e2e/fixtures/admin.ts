/**
 * Admin Dashboard Fixtures
 *
 * Reusable helpers for admin dashboard E2E tests.
 */

import { Page, expect } from '@playwright/test';
import { TEST_URLS, TestUser } from '../utils/test-data';
import { register } from './auth';
import { setupEmailInterception } from '../utils/email-interceptor';

// Test password for all E2E test users
const TEST_PASSWORD = 'TestPassword123!';

/**
 * Login to admin dashboard
 *
 * @param page - Playwright page object
 * @param email - Admin user email address
 * @returns Promise that resolves when login is complete
 */
export async function loginAdmin(page: Page, email: string): Promise<void> {
  // First, register the user if they don't exist (using profile app)
  // This creates the user with role='user' by default
  await register(page, email);

  // Upgrade the user to admin role via the test endpoint
  // This is only available in localhost (E2E testing)
  // Requires TEST_PROMOTE_SECRET header for security
  const testSecret = process.env.TEST_PROMOTE_SECRET;
  if (!testSecret) {
    throw new Error('TEST_PROMOTE_SECRET environment variable is required for admin promotion in E2E tests');
  }

  const response = await page.request.post(`${TEST_URLS.authServer}/test/promote/${encodeURIComponent(email)}`, {
    headers: {
      'X-Test-Secret': testSecret,
    },
    failOnStatusCode: false,
  });

  if (!response.ok()) {
    throw new Error(`Failed to promote user to admin: ${response.status()} - ${await response.text()}`);
  }

  // IMPORTANT: After promoting to admin, clear cookies to force fresh OAuth flow
  // The existing session tokens have stale role claims from before promotion
  // A fresh OAuth flow will issue new tokens with the updated admin role from DB
  await page.context().clearCookies();

  // Navigate to admin dashboard - this will trigger OAuth flow
  await page.goto(TEST_URLS.adminDashboard);

  // Check if already logged in to admin dashboard by looking for "Users" link in sidebar
  const usersLink = page.locator('a:has-text("Users")');
  const isLoggedIn = await usersLink.isVisible().catch(() => false);

  if (isLoggedIn) {
    // Already logged in to admin dashboard
    return;
  }

  // Set up email interception to capture verification code
  const emailInterceptor = setupEmailInterception();

  // Click "Admin Sign In" or "Sign In" link to start auth flow
  const signInLink = page.locator('a:has-text("Admin Sign In"), a:has-text("Sign In")').first();
  await signInLink.click();

  // Wait for redirect - could be auth server OR back to admin (if auto-authenticated via session)
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  // Check if we've been redirected back to admin (user already authenticated via session)
  const currentUrl = page.url();
  if (currentUrl.includes(TEST_URLS.adminDashboard)) {
    // Already authenticated via existing session - no login needed
    console.log('User auto-authenticated via existing auth session');
    return;
  }

  // We're on auth server - check if email/password form is shown
  const emailField = page.locator('input[type="email"]');

  // Wait to see which state we're in
  const needsCredentials = await emailField.isVisible({ timeout: 3000 }).catch(() => false);

  if (needsCredentials) {
    // Enter email address and password
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', TEST_PASSWORD);

    // Click Continue to submit login
    await page.click('button:has-text("Continue")');
  }

  // Handle verification code if required
  // The password provider sends a verification code after email/password submission
  const codeInput = page.locator('input[name="code"]');
  const needsVerificationCode = await codeInput.isVisible({ timeout: 5000 }).catch(() => false);

  if (needsVerificationCode) {
    // Get verification code from intercepted email
    const verificationCode = await emailInterceptor.getLastLoginCode(email);
    if (!verificationCode) {
      throw new Error('Failed to capture verification code from email during admin login. Check that email interception is working correctly.');
    }

    // Enter verification code with retry logic
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.fill('input[name="code"]', '');
      await page.fill('input[name="code"]', verificationCode);
      await page.waitForTimeout(100);

      const continueBtn = page.locator('button:has-text("Continue")');
      await expect(continueBtn).toBeEnabled({ timeout: 5000 });
      await continueBtn.click();

      try {
        await expect(page).toHaveURL(new RegExp(TEST_URLS.adminDashboard), { timeout: 12000 });
        break;
      } catch {
        const stillOnCodePage = await page.locator('input[name="code"]').isVisible().catch(() => false);
        if (stillOnCodePage && attempt < 3) {
          console.log(`Admin verification code attempt ${attempt} failed, retrying...`);
          continue;
        }
        if (attempt === 3) {
          throw new Error(`Admin verification code submission failed after ${attempt} attempts. Page URL: ${page.url()}`);
        }
      }
    }
  } else {
    // No verification code needed - wait for redirect
    await expect(page).toHaveURL(new RegExp(TEST_URLS.adminDashboard), { timeout: 15000 });
  }

  // Verify login succeeded by checking for admin-specific elements (dashboard heading and Users link)
  await expect(page.locator('h1:has-text("Dashboard"), h2:has-text("Dashboard"), h3:has-text("Dashboard")')).toBeVisible({ timeout: 10000 });
  await expect(usersLink).toBeVisible({ timeout: 10000 });
}

/**
 * Navigate to admin dashboard
 *
 * @param page - Playwright page object
 */
export async function navigateToAdmin(page: Page): Promise<void> {
  await page.goto(TEST_URLS.adminDashboard);
  await expect(page).toHaveURL(new RegExp(TEST_URLS.adminDashboard));
}

/**
 * Create a new user via admin dashboard
 *
 * @param page - Playwright page object
 * @param user - User data to create
 */
export async function createUser(page: Page, user: TestUser): Promise<void> {
  // Navigate to users page (not just the dashboard home)
  await page.goto(`${TEST_URLS.adminDashboard}/users`);
  // Wait for network requests to complete (roles are loaded asynchronously)
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await expect(page).toHaveURL(new RegExp(`${TEST_URLS.adminDashboard}/users`));

  // Wait for the "Create User" button to be visible (page is loaded)
  // Use .first() because there are 2 buttons: one trigger button in header, one submit button in dialog
  const createUserBtn = page.locator('button:has-text("Create User")').first();
  await expect(createUserBtn).toBeVisible({ timeout: 10000 });
  await createUserBtn.click();

  // Wait for dialog to open
  await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });

  // Fill in user details
  await page.fill('input[id="email"]', user.email);

  // Wait for roles to load - look for any checkbox in the dialog first
  // Roles are loaded from API asynchronously after dialog opens
  const dialogCheckbox = page.locator('[role="dialog"] label input[type="checkbox"]');
  await expect(dialogCheckbox.first()).toBeVisible({ timeout: 10000 });

  // Select role using checkbox - find by exact role name in span
  // Role names are stored in Title Case (e.g., 'Admin', 'Member')
  const roleName = user.role.charAt(0).toUpperCase() + user.role.slice(1).toLowerCase();

  // Find the label containing the role name by looking for the span with exact text
  // Structure: <label><input type="checkbox"/><span class="text-sm">{role.name}</span><span>- description</span></label>
  // Use the span.text-sm to find the exact role, then go up to parent label
  const roleNameSpan = page.locator('[role="dialog"] label span.text-sm').filter({
    hasText: new RegExp(`^${roleName}$`)
  });
  await expect(roleNameSpan).toBeVisible({ timeout: 5000 });

  // Get the checkbox that's a sibling (inside same label)
  const roleCheckbox = roleNameSpan.locator('xpath=..').locator('input[type="checkbox"]');
  await expect(roleCheckbox).toBeVisible({ timeout: 5000 });

  // Check if already checked (avoid double-click which would uncheck)
  const isAlreadyChecked = await roleCheckbox.isChecked();
  if (!isAlreadyChecked) {
    // Use click() instead of check() to properly trigger React's onChange handler
    // Playwright's check() can bypass synthetic event handlers on controlled components
    await roleCheckbox.click();
  }

  // Wait for React state to propagate after checkbox change
  await page.waitForTimeout(100);

  // Verify the checkbox is actually checked - this proves React state was updated
  // since it's a controlled component (checked={selectedRoles.includes(role.id)})
  await expect(roleCheckbox).toBeChecked({ timeout: 5000 });

  // Additional wait to ensure form state is stable before submit
  await page.waitForTimeout(200);

  // Submit form - use dialog-specific selector to avoid matching header button
  const submitButton = page.locator('[role="dialog"] button:has-text("Create User")');
  await expect(submitButton).toBeEnabled({ timeout: 5000 });
  await submitButton.click();

  // Wait for success message or dialog to close
  await expect(page.locator('[role="dialog"]')).toBeHidden({ timeout: 10000 });

  // Wait for revalidation to complete - the revalidator.revalidate() call
  // triggers a fresh fetch of the user list including their roles
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  // Verify user appears in list (wait for table to update)
  await expect(page.locator(`text=${user.email}`)).toBeVisible({ timeout: 10000 });
}

/**
 * Edit an existing user
 *
 * @param page - Playwright page object
 * @param email - Current user email
 * @param updates - Fields to update
 */
export async function editUser(
  page: Page,
  email: string,
  updates: Partial<TestUser>
): Promise<void> {
  // Navigate to users page
  await page.goto(`${TEST_URLS.adminDashboard}/users`);
  // Wait for network requests to complete
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await expect(page).toHaveURL(new RegExp(`${TEST_URLS.adminDashboard}/users`));

  // Wait for users table to load - find user row and click edit button
  const userRow = page.locator(`tr:has-text("${email}")`);
  await expect(userRow).toBeVisible({ timeout: 10000 });
  await userRow.locator('button:has-text("Edit")').click();

  // Wait for dialog to open
  await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });

  // Update fields
  if (updates.email) {
    await page.fill('input[id="email"]', updates.email);
  }
  if (updates.role) {
    // Select role using the dropdown (edit dialog uses select, not checkboxes)
    // Wait for the select to be visible and have options loaded
    const roleSelect = page.locator('select[id="role"]');
    await expect(roleSelect).toBeVisible({ timeout: 5000 });

    // Wait for at least one option to be loaded (roles load async)
    const roleOption = roleSelect.locator('option');
    await expect(roleOption.first()).toBeVisible({ timeout: 10000 });

    // Capitalize first letter to match actual role names (e.g., 'member' -> 'Member')
    const normalizedRole = updates.role.charAt(0).toUpperCase() + updates.role.slice(1).toLowerCase();

    // Wait for the specific role option to be available
    await expect(roleSelect.locator(`option:has-text("${normalizedRole}")`)).toBeVisible({ timeout: 5000 });
    await roleSelect.selectOption({ label: normalizedRole });

    // Small delay to ensure React state is updated
    await page.waitForTimeout(100);
  }

  // Submit form (click Save button in dialog)
  await page.locator('[role="dialog"]').locator('button:has-text("Save")').click();

  // Wait for success (dialog should close) or error message to appear
  // Use a longer timeout since the API call may take time
  await expect(page.locator('[role="dialog"]')).toBeHidden({ timeout: 15000 });

  // Wait for page to refresh data after successful edit
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
}

/**
 * Delete a user
 *
 * @param page - Playwright page object
 * @param email - User email to delete
 */
export async function deleteUser(page: Page, email: string): Promise<void> {
  // Navigate to users page
  await page.goto(`${TEST_URLS.adminDashboard}/users`);
  // Wait for network requests to complete
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await expect(page).toHaveURL(new RegExp(`${TEST_URLS.adminDashboard}/users`));

  // Wait for users table to load - find user row and click delete button
  const userRow = page.locator(`tr:has-text("${email}")`);
  await expect(userRow).toBeVisible({ timeout: 10000 });
  await userRow.locator('button:has-text("Delete")').click();

  // Wait for confirmation dialog and confirm deletion
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5000 });
  const confirmBtn = dialog.locator('button:has-text("Confirm")');
  await expect(confirmBtn).toBeVisible({ timeout: 5000 });
  await confirmBtn.click();

  // Wait for dialog to close (indicates delete request was submitted)
  await expect(dialog).toBeHidden({ timeout: 10000 });

  // Reload page to get fresh data (fetcher.submit doesn't auto-revalidate)
  await page.reload();
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  // Verify user is removed from list
  await expect(page.locator(`text=${email}`)).toBeHidden({ timeout: 10000 });
}

/**
 * Search for users
 *
 * @param page - Playwright page object
 * @param query - Search query
 * @returns Number of results found
 */
export async function searchUsers(page: Page, query: string): Promise<number> {
  // Navigate to users page
  await page.goto(`${TEST_URLS.adminDashboard}/users`);
  await expect(page).toHaveURL(new RegExp(`${TEST_URLS.adminDashboard}/users`));

  // Enter search query
  await page.fill('input[placeholder*="Search"]', query);

  // Wait for results to update by waiting for network to be idle or table to re-render
  // This ensures search results have loaded before counting rows
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {
    // If networkidle times out, fall back to waiting for table visibility
    // This handles cases where search is client-side (no network request)
  });

  // Count visible user rows
  const rows = await page.locator('tbody tr').count();
  return rows;
}

/**
 * Get dashboard statistics
 *
 * @param page - Playwright page object
 * @returns Dashboard stats
 */
export async function getDashboardStats(page: Page): Promise<{
  totalUsers: number;
  adminUsers: number;
  regularUsers: number;
}> {
  // Navigate to admin dashboard
  await navigateToAdmin(page);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  // Helper to extract count from card by title
  const getCardCount = async (title: string) => {
    const countText = await page.locator(`text=${title}`)
      .locator('xpath=ancestor::*[contains(@class, "rounded")][1]')
      .locator('div.text-2xl')
      .first()
      .textContent({ timeout: 5000 })
      .catch(() => '0');
    return parseInt(countText || '0');
  };

  const totalUsers = await getCardCount('Total Users');
  const adminUsers = await getCardCount('Admin Users');
  // regularUsers card might not exist - derive from total - admin
  const regularUsers = Math.max(0, totalUsers - adminUsers);

  return {
    totalUsers,
    adminUsers,
    regularUsers,
  };
}

/**
 * Verify user exists in admin list
 *
 * @param page - Playwright page object
 * @param email - User email to check
 * @returns True if user exists
 */
export async function userExists(page: Page, email: string): Promise<boolean> {
  await page.goto(`${TEST_URLS.adminDashboard}/users`);
  await expect(page).toHaveURL(new RegExp(`${TEST_URLS.adminDashboard}/users`));
  const userRow = page.locator(`tr:has-text("${email}")`);
  return await userRow.isVisible();
}

/**
 * Navigate to audit logs page
 *
 * @param page - Playwright page object
 */
export async function navigateToAuditLogs(page: Page): Promise<void> {
  await page.goto(`${TEST_URLS.adminDashboard}/audit`);
  await expect(page).toHaveURL(new RegExp(`${TEST_URLS.adminDashboard}/audit`));
}

/**
 * Get count of audit events in the current view
 *
 * @param page - Playwright page object
 * @returns Number of audit events visible
 */
export async function getAuditEventCount(page: Page): Promise<number> {
  const tableRows = page.locator('tbody tr');
  return await tableRows.count();
}

/**
 * Apply filters to audit logs
 *
 * @param page - Playwright page object
 * @param filters - Filter options
 */
export async function filterAuditLogs(
  page: Page,
  filters: {
    eventType?: string;
    severity?: 'debug' | 'info' | 'warning' | 'error' | 'critical';
    search?: string;
    startDate?: string;
    endDate?: string;
  }
): Promise<void> {
  // Ensure filters panel is visible
  const showFiltersButton = page.locator('button:has-text("Show Filters")');
  const isFiltersVisible = await showFiltersButton.isVisible();

  if (isFiltersVisible) {
    await showFiltersButton.click();
  }

  // Apply filters
  if (filters.eventType) {
    await page.fill('input[id="event_type"]', filters.eventType);
  }
  if (filters.severity) {
    await page.locator('button[id="severity"]').click();
    await page.locator(`[role="option"]:has-text("${filters.severity}")`).click();
  }
  if (filters.search) {
    await page.fill('input[id="search"]', filters.search);
  }
  if (filters.startDate) {
    await page.fill('input[id="start_date"]', filters.startDate);
  }
  if (filters.endDate) {
    await page.fill('input[id="end_date"]', filters.endDate);
  }

  // Click apply
  await page.click('button:has-text("Apply Filters")');
  await page.waitForLoadState('networkidle');
}
