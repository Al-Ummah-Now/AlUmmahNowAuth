import type { Locale, VisibleApp } from "./apps";
import { dirFor, MESSAGES } from "./i18n";
import { escapeHtml, LAUNCHER_SCRIPT, renderAppCards, renderLauncher } from "./launcher";

export interface HomePageOptions {
  locale: Locale;
  apps: VisibleApp[];
  user: { id: string; email: string; roles: string[] } | null;
  authServerUrl: string;
  appUrl: string;
  clientId: string;
  analyticsToken?: string;
}

/** JSON for embedding inside <script>: escapes "<" so "</script>" in data can't end the block. */
export function scriptJson(value: unknown): string {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .split(LS).join("\\u2028")
    .split(PS).join("\\u2029");
}

const STYLES = `
        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
            color: #f8fafc;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }
        html[lang="ar"] body { font-family: 'Segoe UI', Tahoma, 'Noto Kufi Arabic', 'Noto Sans Arabic', Arial, sans-serif; }

        :focus-visible { outline: 2px solid #38bdf8; outline-offset: 2px; }

        .navbar {
            background: linear-gradient(135deg, #093041 0%, #0f4d66 100%);
            padding: 0.75rem 2rem;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
            border-bottom: 1px solid rgba(15, 77, 102, 0.2);
            position: relative;
            z-index: 10;
        }
        .navbar-content {
            max-width: 1200px;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 1rem;
        }
        .logo { display: flex; align-items: center; gap: 12px; color: white; text-decoration: none; min-width: 0; }
        .logo img { width: 40px; height: 40px; border-radius: 8px; flex-shrink: 0; }
        .logo-text { display: flex; flex-direction: column; line-height: 1.15; min-width: 0; }
        .logo-brand { font-size: 0.8rem; font-weight: 600; color: #7dd3fc; letter-spacing: 0.02em; }
        .logo-app { font-size: 1.35rem; font-weight: 700; white-space: nowrap; }
        .nav-actions { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
        .nav-menu { display: flex; gap: 1rem; align-items: center; }

        .lang-toggle {
            color: #e2e8f0; text-decoration: none; font-size: 14px; font-weight: 600;
            padding: 8px 12px; border-radius: 9999px; min-height: 40px; display: inline-flex; align-items: center;
        }
        .lang-toggle:hover { background: rgba(255, 255, 255, 0.12); }

        .icon-btn {
            width: 40px; height: 40px; border-radius: 50%;
            display: inline-flex; align-items: center; justify-content: center;
            background: transparent; border: 1px solid transparent; color: #e2e8f0; cursor: pointer;
            transition: background 0.2s ease;
        }
        .icon-btn:hover, .icon-btn[aria-expanded="true"] { background: rgba(255, 255, 255, 0.14); border-color: rgba(255, 255, 255, 0.2); }

        /* App launcher */
        .apps-launcher { position: relative; }
        .apps-menu {
            position: absolute;
            top: calc(100% + 8px);
            inset-inline-end: 0;
            width: 340px;
            max-height: calc(100vh - 90px);
            overflow-y: auto;
            background: #1e293b;
            border: 1px solid rgba(148, 163, 184, 0.25);
            border-radius: 16px;
            box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
            padding: 8px;
            z-index: 1000;
        }
        .apps-menu[hidden] { display: none; }
        .apps-group-label {
            padding: 8px 10px 6px; font-size: 12px; color: #94a3b8;
            text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;
        }
        html[lang="ar"] .apps-group-label, html[lang="ar"] .profile-field label, html[lang="ar"] .dropdown-header { text-transform: none; letter-spacing: 0; }
        .apps-separator { height: 1px; background: rgba(148, 163, 184, 0.2); margin: 6px 4px; }
        .apps-item {
            display: grid; grid-template-columns: 40px 1fr auto; align-items: center; gap: 12px;
            padding: 10px; border-radius: 10px; color: #f8fafc; text-decoration: none;
            min-height: 56px;
        }
        .apps-item:hover, .apps-item:focus { background: rgba(255, 255, 255, 0.08); }
        .apps-item:focus-visible { outline: 2px solid #38bdf8; outline-offset: -2px; }
        .apps-item.is-current { background: rgba(14, 165, 233, 0.14); }
        .apps-item-text, .app-card-text { display: flex; flex-direction: column; min-width: 0; }
        .apps-item-name, .app-card-name { font-weight: 600; font-size: 15px; }
        .apps-item-desc, .app-card-desc { font-size: 13px; color: #94a3b8; margin-top: 2px; }
        .apps-item-pill {
            font-size: 11px; font-weight: 600; color: #7dd3fc; background: rgba(14, 165, 233, 0.18);
            padding: 3px 8px; border-radius: 9999px; white-space: nowrap;
        }

        .app-tile {
            width: 40px; height: 40px; border-radius: 10px;
            display: inline-flex; align-items: center; justify-content: center; color: white; flex-shrink: 0;
        }
        .app-tile-videos { background: linear-gradient(135deg, #0ea5e9, #0369a1); }
        .app-tile-profile { background: linear-gradient(135deg, #10b981, #047857); }
        .app-tile-content-admin { background: linear-gradient(135deg, #f59e0b, #b45309); }
        .app-tile-auth-admin { background: linear-gradient(135deg, #8b5cf6, #5b21b6); }

        /* Your apps */
        .apps-section { max-width: 600px; margin: 0 auto 2rem; }
        .apps-section h2 { font-size: 1.25rem; color: #f8fafc; }
        .apps-section-sub { color: #94a3b8; font-size: 0.95rem; margin: 0.25rem 0 1rem; }
        .apps-cards-subheading {
            font-size: 0.8rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.06em;
            margin: 1.25rem 0 0.5rem; font-weight: 600;
        }
        html[lang="ar"] .apps-cards-subheading { text-transform: none; letter-spacing: 0; }
        .apps-cards { list-style: none; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        .app-card {
            display: flex; align-items: center; gap: 12px; padding: 14px;
            background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
            border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 12px;
            color: #f8fafc; text-decoration: none; height: 100%;
            transition: border-color 0.2s ease, transform 0.2s ease;
        }
        .app-card:hover { border-color: #38bdf8; transform: translateY(-1px); }
        .app-card-text { flex: 1; }
        .app-card-arrow { color: #64748b; font-size: 1.5rem; line-height: 1; }

        /* Account Switcher Dropdown */
        .account-switcher { position: relative; display: inline-block; }
        .account-trigger {
            display: flex; align-items: center; gap: 10px; padding: 6px 12px;
            background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 9999px; cursor: pointer; transition: all 0.2s ease; color: #e2e8f0; font-size: 14px;
            min-height: 40px; max-width: 280px;
        }
        .account-trigger:hover { background: rgba(255, 255, 255, 0.2); border-color: rgba(255, 255, 255, 0.3); }
        .account-trigger .avatar {
            width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
            color: white; font-weight: 600; font-size: 12px; flex-shrink: 0;
        }
        .account-trigger #activeEmail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .account-trigger .chevron { transition: transform 0.2s ease; flex-shrink: 0; }
        .account-trigger .chevron.open { transform: rotate(180deg); }
        .account-dropdown {
            position: absolute; top: calc(100% + 8px); inset-inline-end: 0; min-width: 280px;
            background: #1e293b; border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4); z-index: 1000; overflow: hidden;
        }
        .dropdown-header {
            padding: 12px 16px; border-bottom: 1px solid rgba(148, 163, 184, 0.2); font-size: 12px; color: #94a3b8;
            text-transform: uppercase; letter-spacing: 0.05em;
        }
        .accounts-list { padding: 8px; }
        .account-item { display: flex; align-items: center; padding: 10px 12px; border-radius: 8px; cursor: pointer; transition: background 0.2s ease; }
        .account-item:hover { background: rgba(255, 255, 255, 0.1); }
        .account-item.active { background: rgba(14, 165, 233, 0.15); }
        .account-item .avatar {
            width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
            color: white; font-weight: 600; font-size: 14px; margin-inline-end: 12px; flex-shrink: 0;
        }
        .account-item .account-details { flex: 1; min-width: 0; }
        .account-item .email { display: block; font-size: 14px; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .account-item .status { display: block; font-size: 12px; color: #94a3b8; }
        .account-item .active-check { color: #10b981; margin-inline-start: 8px; }
        .account-item .sign-out-btn {
            padding: 6px; background: none; border: none; color: #94a3b8; cursor: pointer; border-radius: 4px;
            margin-inline-start: 8px; opacity: 0; transition: all 0.2s ease;
        }
        .account-item:hover .sign-out-btn, .account-item .sign-out-btn:focus { opacity: 1; }
        .account-item .sign-out-btn:hover { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
        .dropdown-divider { height: 1px; background: rgba(148, 163, 184, 0.2); margin: 8px 0; }
        .dropdown-action {
            display: flex; align-items: center; gap: 10px; width: 100%; padding: 12px 16px; background: none; border: none;
            color: #94a3b8; cursor: pointer; font-size: 14px; text-align: start; transition: all 0.2s ease; font-family: inherit;
        }
        .dropdown-action:hover { background: rgba(255, 255, 255, 0.1); color: #f8fafc; }
        .dropdown-action.danger:hover { background: rgba(239, 68, 68, 0.15); color: #ef4444; }

        .btn {
            padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; transition: all 0.3s ease;
            cursor: pointer; border: none; font-size: 14px; display: inline-flex; align-items: center; gap: 8px; font-family: inherit;
        }
        .btn-primary { background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); color: white; box-shadow: 0 2px 8px rgba(14, 165, 233, 0.3); }
        .btn-primary:hover { background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); transform: translateY(-2px); box-shadow: 0 4px 16px rgba(14, 165, 233, 0.4); }
        .btn-secondary { background: rgba(255, 255, 255, 0.1); color: #e2e8f0; border: 1px solid rgba(255, 255, 255, 0.2); }
        .btn-secondary:hover { background: rgba(255, 255, 255, 0.2); color: white; }

        .container { width: 100%; max-width: 1200px; margin: 0 auto; padding: 3rem 2rem; flex: 1; }
        .hero { text-align: center; margin-bottom: 3rem; }
        .hero h1 {
            font-size: 3rem; font-weight: 800; margin-bottom: 1rem;
            background: linear-gradient(135deg, #0ea5e9 0%, #06b6d4 100%);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
        }
        .hero p { font-size: 1.25rem; color: #cbd5e1; max-width: 600px; margin: 0 auto; line-height: 1.6; }
        .profile-card {
            background: linear-gradient(135deg, #1e293b 0%, #334155 100%); padding: 2rem; border-radius: 12px;
            border: 1px solid rgba(148, 163, 184, 0.2); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4); max-width: 600px; margin: 0 auto;
        }
        .profile-card h2 { color: #0ea5e9; margin-bottom: 1.5rem; font-size: 1.75rem; }
        .profile-field { margin-bottom: 1rem; padding: 1rem; background: rgba(15, 23, 42, 0.6); border-radius: 8px; }
        .profile-field label {
            display: block; color: #94a3b8; font-size: 0.875rem; margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em;
        }
        .profile-field .value { color: #f8fafc; font-size: 1.125rem; font-weight: 500; overflow-wrap: anywhere; }
        .badge { display: inline-block; padding: 4px 12px; border-radius: 6px; font-size: 0.875rem; font-weight: 600; margin-inline-end: 8px; }
        .badge-admin { background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%); color: white; }
        .badge-user { background: linear-gradient(135deg, #059669 0%, #047857 100%); color: white; }
        .welcome-message {
            background: linear-gradient(135deg, rgba(5, 150, 105, 0.15) 0%, rgba(16, 185, 129, 0.08) 100%);
            border: 1px solid #059669; padding: 1.5rem; border-radius: 12px; margin: 0 auto 2rem; text-align: center; max-width: 600px;
        }
        .welcome-message h3 { color: #10b981; margin-bottom: 0.5rem; font-size: 1.5rem; }
        .error-message {
            background: rgba(220, 38, 38, 0.1); border: 1px solid #dc2626; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; color: #fca5a5;
        }
        .footer {
            background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 2rem;
            border-top: 1px solid rgba(148, 163, 184, 0.2); text-align: center; color: #94a3b8;
        }

        @media (max-width: 640px) {
            .navbar { padding: 0.5rem 1rem; }
            .logo-brand { display: none; }
            .logo-app { font-size: 1.1rem; }
            .logo img { width: 34px; height: 34px; }
            .nav-actions { gap: 0.25rem; }
            .account-trigger { padding: 4px; gap: 4px; }
            .account-trigger #activeEmail { display: none; }
            .apps-launcher { position: static; }
            .apps-menu { position: absolute; top: calc(100% + 4px); inset-inline: 12px; width: auto; }
            .container { padding: 1.5rem 1rem; }
            .hero h1 { font-size: 2rem; }
            .apps-cards { grid-template-columns: 1fr; }
            .profile-card { padding: 1.25rem; }
        }
`;

const ICON_PLUS = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z"/></svg>';
const ICON_SESSIONS = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.5 3A1.5 1.5 0 013 1.5h10A1.5 1.5 0 0114.5 3v10a1.5 1.5 0 01-1.5 1.5H3A1.5 1.5 0 011.5 13V3zM3 2.5a.5.5 0 00-.5.5v10a.5.5 0 00.5.5h10a.5.5 0 00.5-.5V3a.5.5 0 00-.5-.5H3z"/></svg>';
const ICON_SIGNOUT = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 2.75A.75.75 0 012.75 2h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 2.75zm0 10.5a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75zM2.75 7a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z"/></svg>';

export function renderHomePage(o: HomePageOptions): string {
  const t = MESSAGES[o.locale];
  const e = escapeHtml;
  const other: Locale = o.locale === "ar" ? "en" : "ar";
  const isLoggedIn = o.user !== null;

  return `<!DOCTYPE html>
<html lang="${o.locale}" dir="${dirFor(o.locale)}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${e(t.pageTitle)}</title>
    <style>${STYLES}</style>
</head>
<body>
    <header class="navbar">
        <div class="navbar-content">
            <a class="logo" href="/">
                <img src="https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png" alt="">
                <span class="logo-text"><span class="logo-brand">${e(t.brand)}</span><span class="logo-app">${e(t.brandApp)}</span></span>
            </a>
            <nav class="nav-actions" aria-label="${e(t.brand)}">
                <div class="nav-menu" id="navMenu"></div>
                <a class="lang-toggle" href="?lang=${other}" lang="${other}" hreflang="${other}" aria-label="${e(t.switchLanguageLabel)}">${e(t.switchLanguage)}</a>
                ${renderLauncher(o.apps, t)}
                <div class="account-switcher" id="accountSwitcher" style="display: none;">
                    <button type="button" class="account-trigger" id="accountTrigger" aria-haspopup="true" aria-expanded="false" aria-controls="accountDropdown" aria-label="${e(t.accountMenu)}" onclick="toggleAccountDropdown()">
                        <span class="avatar" id="activeAvatar" style="background-color: #1976d2;" aria-hidden="true">?</span>
                        <span id="activeEmail">${e(t.loading)}</span>
                        <svg class="chevron" id="chevronIcon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                            <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </button>
                    <div class="account-dropdown" id="accountDropdown" style="display: none;">
                        <div class="dropdown-header">${e(t.signedInAccounts)}</div>
                        <div class="accounts-list" id="accountsList"></div>
                        <div class="dropdown-divider"></div>
                        <button type="button" class="dropdown-action" id="addAccountBtn" onclick="handleAddAccount()">${ICON_PLUS}${e(t.addAccount)}</button>
                        <button type="button" class="dropdown-action" onclick="handleManageSessions()">${ICON_SESSIONS}${e(t.manageSessions)}</button>
                        <button type="button" class="dropdown-action danger" onclick="handleSignOutAll()">${ICON_SIGNOUT}${e(t.signOutAll)}</button>
                    </div>
                </div>
            </nav>
        </div>
    </header>

    <main class="container">
        <div id="errorContainer"></div>

        <div id="loggedOutView" style="display: none;">
            <div class="hero">
                <h1>${e(t.heroTitle)}</h1>
                <p>${e(t.heroBody)}</p>
            </div>
            <div style="text-align: center;">
                <button type="button" onclick="handleLogin()" class="btn btn-primary" style="font-size: 1.1rem; padding: 1rem 2rem;">
                    🔐 ${e(t.signIn)}
                </button>
            </div>
        </div>

        <div id="loggedInView" style="display: none;">
            <div class="welcome-message">
                <h3>${e(t.welcomeTitle)}</h3>
                <p>${e(t.welcomeBody)}</p>
            </div>

            ${isLoggedIn ? renderAppCards(o.apps, t) : ""}

            <div class="profile-card">
                <h2>👤 ${e(t.profileHeading)}</h2>
                <div class="profile-field"><label>${e(t.userId)}</label><div class="value" id="userId" dir="ltr">-</div></div>
                <div class="profile-field"><label>${e(t.email)}</label><div class="value" id="userEmail" dir="ltr">-</div></div>
                <div class="profile-field"><label>${e(t.role)}</label><div class="value" id="userRole">-</div></div>
                <div style="margin-top: 2rem; text-align: center;">
                    <button type="button" onclick="handleLogout()" class="btn btn-secondary">🚪 ${e(t.signOut)}</button>
                </div>
            </div>
        </div>
    </main>

    <footer class="footer">
        <p>${e(t.footer)}</p>
    </footer>

    <script>${LAUNCHER_SCRIPT}</script>
    <script>
        var currentUser = ${scriptJson(o.user)};
        var isLoggedIn = ${isLoggedIn};
        var authServerUrl = ${scriptJson(o.authServerUrl)};
        var appUrl = ${scriptJson(o.appUrl)};
        var clientId = ${scriptJson(o.clientId)};
        var T = ${scriptJson(t)};

        var accounts = [];
        var dropdownOpen = false;
        var MAX_ACCOUNTS = 3;
        var avatarColors = ['#1976d2', '#388e3c', '#d32f2f', '#7b1fa2', '#f57c00', '#0097a7'];

        function esc(s) {
            return String(s).replace(/[&<>"']/g, function (c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
        }
        function getAvatarColor(email) { return avatarColors[email.charCodeAt(0) % avatarColors.length]; }
        function formatRelativeTime(dateString) {
            var diffMins = Math.floor((Date.now() - new Date(dateString).getTime()) / 60000);
            if (diffMins < 1) return T.justNow;
            if (diffMins < 60) return T.minutesAgo.replace('{n}', diffMins);
            if (diffMins < 1440) return T.hoursAgo.replace('{n}', Math.floor(diffMins / 60));
            return T.daysAgo.replace('{n}', Math.floor(diffMins / 1440));
        }
        function authorizeUrl(extra) {
            return authServerUrl + '/authorize?response_type=code&client_id=' + encodeURIComponent(clientId) +
                '&redirect_uri=' + encodeURIComponent(appUrl + '/callback') + (extra || '');
        }

        function setAccountDropdown(open) {
            dropdownOpen = open;
            document.getElementById('accountDropdown').style.display = open ? 'block' : 'none';
            document.getElementById('chevronIcon').classList.toggle('open', open);
            document.getElementById('accountTrigger').setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        function toggleAccountDropdown() { setAccountDropdown(!dropdownOpen); }
        document.addEventListener('click', function (e) {
            var switcher = document.getElementById('accountSwitcher');
            if (switcher && !switcher.contains(e.target) && dropdownOpen) setAccountDropdown(false);
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && dropdownOpen) { setAccountDropdown(false); document.getElementById('accountTrigger').focus(); }
        });

        async function loadAccounts() {
            if (isLoggedIn && currentUser) {
                accounts = [{ userId: currentUser.id, email: currentUser.email, isActive: true, lastUsed: new Date().toISOString() }];
                renderAccountSwitcher();
            }
            try {
                var response = await fetch(authServerUrl + '/session/accounts', { credentials: 'include' });
                if (response.ok) {
                    var data = await response.json();
                    if (data.accounts && data.accounts.length > 0) {
                        accounts = data.accounts;
                        renderAccountSwitcher();
                    }
                }
            } catch (error) {
                console.error('Failed to load multi-account data from auth server:', error);
            }
        }

        function renderAccountSwitcher() {
            var switcher = document.getElementById('accountSwitcher');
            if (!isLoggedIn || !currentUser) { switcher.style.display = 'none'; return; }
            switcher.style.display = 'inline-block';
            var activeAccount = accounts.find(function (a) { return a.isActive; });
            var displayAccount = activeAccount || { email: currentUser.email };
            document.getElementById('activeAvatar').style.backgroundColor = getAvatarColor(displayAccount.email);
            document.getElementById('activeAvatar').textContent = displayAccount.email.charAt(0).toUpperCase();
            document.getElementById('activeEmail').textContent = displayAccount.email;

            document.getElementById('accountsList').innerHTML = accounts.map(function (account) {
                var id = esc(account.userId);
                return '<div class="account-item ' + (account.isActive ? 'active' : '') + '"' +
                    (account.isActive ? '' : ' onclick="handleSwitchAccount(this.dataset.userId)"') + ' data-user-id="' + id + '">' +
                    '<div class="avatar" style="background-color: ' + getAvatarColor(account.email) + '">' + esc(account.email.charAt(0).toUpperCase()) + '</div>' +
                    '<div class="account-details"><span class="email" dir="ltr">' + esc(account.email) + '</span>' +
                    '<span class="status">' + esc(account.isActive ? T.active : T.lastUsed + ' ' + formatRelativeTime(account.lastUsed)) + '</span></div>' +
                    (account.isActive ? '<span class="active-check" aria-hidden="true">✓</span>' : '') +
                    '<button type="button" class="sign-out-btn" data-user-id="' + id + '" onclick="event.stopPropagation(); handleSignOutAccount(this.dataset.userId)" title="' + esc(T.signOutAccount) + '" aria-label="' + esc(T.signOutAccount + ' ' + account.email) + '">×</button>' +
                    '</div>';
            }).join('');
            document.getElementById('addAccountBtn').style.display = accounts.length < MAX_ACCOUNTS ? 'flex' : 'none';
        }

        async function handleSwitchAccount(userId) {
            try {
                var response = await fetch(authServerUrl + '/session/switch', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                    body: JSON.stringify({ userId: userId }),
                });
                if (response.ok) {
                    // Silent re-auth: the auth server's active account just changed.
                    window.location.href = authorizeUrl('&prompt=none');
                } else {
                    console.error('Failed to switch account:', await response.text());
                }
            } catch (error) {
                console.error('Failed to switch account:', error);
            }
        }

        async function handleSignOutAccount(userId) {
            try {
                var response = await fetch(authServerUrl + '/session/accounts/' + encodeURIComponent(userId), { method: 'DELETE', credentials: 'include' });
                var result = await response.json();
                if (result.remainingAccounts === 0) {
                    window.location.href = '/logout';
                } else {
                    await loadAccounts();
                    if (result.wasActive) window.location.reload();
                }
            } catch (error) {
                console.error('Failed to sign out:', error);
            }
        }

        function handleAddAccount() { window.location.href = authorizeUrl('&prompt=select_account'); }
        function handleManageSessions() { window.location.href = authServerUrl + '/settings/sessions'; }
        async function handleSignOutAll() {
            try {
                await fetch(authServerUrl + '/session/all', { method: 'DELETE', credentials: 'include' });
                window.location.href = '/logout';
            } catch (error) {
                console.error('Failed to sign out all:', error);
            }
        }

        function renderUserUI(user) {
            document.getElementById('loggedInView').style.display = 'block';
            document.getElementById('loggedOutView').style.display = 'none';
            document.getElementById('navMenu').innerHTML = '';
            document.getElementById('userId').textContent = user.id;
            document.getElementById('userEmail').textContent = user.email;

            var roleDiv = document.getElementById('userRole');
            roleDiv.innerHTML = '';
            var roles = user.roles || [];
            roles.forEach(function (role) {
                var badge = document.createElement('span');
                var lower = role.toLowerCase();
                badge.className = lower === 'admin' || lower === 'super admin' ? 'badge badge-admin' : 'badge badge-user';
                badge.textContent = role.toUpperCase();
                roleDiv.appendChild(badge);
            });
            if (roles.length === 0) roleDiv.textContent = T.noRoles;
            loadAccounts();
        }

        async function updateUI() {
            if (isLoggedIn && currentUser) {
                renderUserUI(currentUser);
                try {
                    var response = await fetch('/api/me', { credentials: 'include' });
                    if (response.ok) renderUserUI(await response.json());
                } catch (err) {
                    console.error('Failed to fetch fresh user data:', err);
                }
            } else {
                document.getElementById('loggedInView').style.display = 'none';
                document.getElementById('loggedOutView').style.display = 'block';
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn btn-primary';
                btn.textContent = '🔐 ' + T.signIn;
                btn.addEventListener('click', handleLogin);
                var nav = document.getElementById('navMenu');
                nav.innerHTML = '';
                nav.appendChild(btn);
            }
        }

        function handleLogin() { window.location.href = authorizeUrl(''); }
        function handleLogout() { window.location.href = '/logout'; }

        function checkForErrors() {
            var error = new URLSearchParams(window.location.search).get('error');
            if (error) {
                var box = document.createElement('div');
                box.className = 'error-message';
                var strong = document.createElement('strong');
                strong.textContent = T.authError + ' ';
                box.appendChild(strong);
                box.appendChild(document.createTextNode(error));
                document.getElementById('errorContainer').appendChild(box);
                window.history.replaceState({}, document.title, window.location.pathname);
            }
        }

        window.addEventListener('DOMContentLoaded', function () {
            updateUI();
            checkForErrors();
        });
    </script>
    ${o.analyticsToken ? `<script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='${e(JSON.stringify({ token: o.analyticsToken }))}'></script>` : ""}
</body>
</html>`;
}
