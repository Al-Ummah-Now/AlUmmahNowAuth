/**
 * @fileoverview Account selector UI component
 *
 * Server-rendered HTML for account selection during OIDC authorize flow.
 * Displays all logged-in accounts and allows the user to:
 * - Select an existing account to continue
 * - Add a new account (if under max limit)
 */

/**
 * Account data for display in selector
 */
export interface AccountSelectorAccount {
	userId: string;
	email: string;
	name?: string;
	avatarUrl?: string;
	lastUsed: string;
	isActive: boolean;
}

/**
 * Props for account selector component
 */
export interface AccountSelectorProps {
	accounts: AccountSelectorAccount[];
	clientId: string;
	clientName: string;
	redirectUri: string;
	state?: string;
	scope?: string;
	codeChallenge?: string;
	codeChallengeMethod?: string;
	nonce?: string;
	allowAddAccount: boolean;
}

/**
 * Render account selector HTML
 *
 * Creates a server-rendered HTML page that displays all accounts
 * and allows selection or adding a new account.
 *
 * @param props - Account selector properties
 * @returns Complete HTML page as string
 */
export function renderAccountSelector(props: AccountSelectorProps): string {
	const { accounts, clientName, allowAddAccount } = props;

	return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Choose an account</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: #f5f5f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      max-width: 400px;
      width: 100%;
      overflow: hidden;
    }
    .header {
      padding: 24px;
      text-align: center;
      border-bottom: 1px solid #eee;
    }
    .header h1 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 8px;
      color: #1a1a1a;
    }
    .header p {
      color: #666;
      font-size: 14px;
    }
    .accounts {
      padding: 8px 0;
    }
    .account {
      display: flex;
      align-items: center;
      padding: 16px 24px;
      cursor: pointer;
      transition: background 0.2s;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
    }
    .account:hover {
      background: #f5f5f5;
    }
    .account.active {
      background: #e8f5e9;
    }
    .avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: #1976d2;
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      margin-right: 16px;
      flex-shrink: 0;
      font-size: 16px;
    }
    .account-info {
      flex: 1;
      min-width: 0;
    }
    .account-email {
      font-weight: 500;
      color: #333;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 14px;
    }
    .account-status {
      font-size: 12px;
      color: #666;
      margin-top: 2px;
    }
    .add-account {
      display: flex;
      align-items: center;
      padding: 16px 24px;
      cursor: pointer;
      transition: background 0.2s;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
      border-top: 1px solid #eee;
    }
    .add-account:hover {
      background: #f5f5f5;
    }
    .add-icon {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-right: 16px;
      font-size: 24px;
      color: #666;
    }
    .add-account-text {
      font-weight: 500;
      color: #333;
      font-size: 14px;
    }
    .account:disabled {
      opacity: 0.6;
      cursor: wait;
    }
  </style>
  <script>
    async function switchAccount(userId, authorizeUrl) {
      // Disable all buttons while switching
      document.querySelectorAll('.account').forEach(btn => btn.disabled = true);

      try {
        // 1. Call /session/switch to switch the active account
        const response = await fetch('/session/switch', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId }),
        });

        if (!response.ok) {
          const error = await response.json();
          alert('Failed to switch account: ' + (error.error || 'Unknown error'));
          document.querySelectorAll('.account').forEach(btn => btn.disabled = false);
          return;
        }

        // 2. Redirect to /authorize?prompt=none to get tokens silently
        window.location.href = authorizeUrl;
      } catch (error) {
        alert('Failed to switch account: ' + error.message);
        document.querySelectorAll('.account').forEach(btn => btn.disabled = false);
      }
    }
  </script>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Choose an account</h1>
      <p>to continue to ${escapeHtml(clientName)}</p>
    </div>
    <div class="accounts">
      ${accounts.map((account) => renderAccountOption(account, props)).join('')}
      ${allowAddAccount ? renderAddAccountOption(props) : ''}
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Render a single account option
 */
function renderAccountOption(
	account: AccountSelectorAccount,
	props: AccountSelectorProps
): string {
	// Build authorize URL for redirect after switch
	const authorizeParams = new URLSearchParams();
	authorizeParams.set('client_id', props.clientId);
	authorizeParams.set('redirect_uri', props.redirectUri);
	authorizeParams.set('response_type', 'code');
	authorizeParams.set('prompt', 'none');
	if (props.state) authorizeParams.set('state', props.state);
	if (props.scope) authorizeParams.set('scope', props.scope);
	if (props.codeChallenge) {
		authorizeParams.set('code_challenge', props.codeChallenge);
		authorizeParams.set('code_challenge_method', props.codeChallengeMethod || 'S256');
	}
	if (props.nonce) authorizeParams.set('nonce', props.nonce);
	const authorizeUrl = `/authorize?${authorizeParams.toString()}`;

	return `
    <button
      type="button"
      class="account ${account.isActive ? 'active' : ''}"
      data-user-id="${escapeHtml(account.userId)}"
      data-authorize-url="${encodeURIComponent(authorizeUrl)}"
      onclick="switchAccount(this.dataset.userId, decodeURIComponent(this.dataset.authorizeUrl))"
    >
      <div class="avatar">${getInitials(account.email)}</div>
      <div class="account-info">
        <div class="account-email">${escapeHtml(account.email)}</div>
        <div class="account-status">${account.isActive ? 'Active' : 'Signed in'}</div>
      </div>
    </button>
  `;
}

/**
 * Render "Use another account" option
 */
function renderAddAccountOption(props: AccountSelectorProps): string {
	const hiddenFields = buildHiddenFields({
		client_id: props.clientId,
		redirect_uri: props.redirectUri,
		state: props.state,
		scope: props.scope,
		code_challenge: props.codeChallenge,
		code_challenge_method: props.codeChallengeMethod,
		nonce: props.nonce,
		action: 'add_account',
		prompt: 'login',
	});

	return `
    <form method="GET" action="/authorize">
      ${hiddenFields}
      <button type="submit" class="add-account">
        <div class="add-icon">+</div>
        <div class="account-info">
          <div class="add-account-text">Use another account</div>
        </div>
      </button>
    </form>
  `;
}

/**
 * Build hidden form fields from parameters
 */
function buildHiddenFields(params: Record<string, string | undefined>): string {
	return Object.entries(params)
		.filter(([_, value]) => value !== undefined)
		.map(
			([key, value]) =>
				`<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value!)}">`
		)
		.join('\n      ');
}

/**
 * Get initials from email address
 *
 * @param email - Email address
 * @returns First letter of email in uppercase
 */
function getInitials(email: string): string {
	return email.charAt(0).toUpperCase();
}

/**
 * Escape HTML special characters to prevent XSS
 *
 * @param str - String to escape
 * @returns Escaped string safe for HTML
 */
function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}
