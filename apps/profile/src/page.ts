import type { Locale, VisibleApp } from "./apps";
import { dirFor, MESSAGES } from "./i18n";
import { escapeHtml, renderAppCards, renderAppsSection } from "./launcher";
import { NAV_CSS } from '../../../packages/ui/src/nav/aun-nav.generated.ts';
import { compileBuiltin } from '../../../packages/ui/src/auth-theme/builtin.ts';
import { BUILTIN_DEFAULT_THEME } from '../../../packages/ui/src/auth-theme/resolve.ts';
import { iconLinks } from '../../../packages/ui/src/app-icons/serve.ts';

/** The logo's night sky (the manifest's theme_color), for the browser chrome. */
const PROFILE_THEME_COLOR = '#09273a';

export interface HomePageOptions {
  locale: Locale;
  apps: VisibleApp[];
  user: { id: string; email: string; roles: string[] } | null;
  authServerUrl: string;
  appUrl: string;
  clientId: string;
  analyticsToken?: string;
  /** The Auth theme for this page (from Auth's /themes/resolve); the built-in default when missing. */
  theme?: { id: string; css: string };
  /** APP_ENV: picks the tab icon (QA and stage get a corner dot). */
  environment?: string;
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
            background: var(--auth-profile-page-background, linear-gradient(135deg, var(--fanous-color-background) 0%, var(--fanous-color-surface-raised) 100%));
            color: var(--fanous-color-text-primary);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }
        html[lang="ar"] body { font-family: 'Segoe UI', Tahoma, 'Noto Kufi Arabic', 'Noto Sans Arabic', Arial, sans-serif; }

        :focus-visible { outline: 2px solid var(--fanous-color-primary); outline-offset: 2px; }

        /* The header is dark in every theme and mode (AlUmmahNow docs/design/NAV.md): nav tokens */
        .navbar {
            background: var(--auth-profile-nav-background, var(--fanous-c-nav-bg));
            color: var(--fanous-c-nav-text);
            padding: 0.5rem 2rem;
            min-height: 3.5rem;
            border-bottom: 1px solid var(--fanous-c-nav-border);
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
        .logo { display: flex; align-items: center; gap: 12px; color: var(--fanous-c-nav-text); text-decoration: none; min-width: 0; }
        .logo img { width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0; }
        .logo-text { display: flex; flex-direction: column; line-height: 1.15; min-width: 0; }
        .logo-brand { font-size: 0.8rem; font-weight: 600; color: var(--fanous-c-nav-active-text); letter-spacing: 0.02em; }
        .logo-app { font-size: 1.35rem; font-weight: 700; white-space: nowrap; }
        .nav-actions { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
        .nav-menu { display: flex; gap: 1rem; align-items: center; }

        /* Language link, account button and menus: the shared .aun-* classes (NAV_CSS, AlUmmahNow docs/design/NAV.md) */
        /* The shared nav's menus pick light or dark with light-dark(): the page follows the OS, like its tokens */
        :root { color-scheme: light dark; }
        .visually-hidden { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
        .accounts-list:empty { display: none; }
        html[lang="ar"] .profile-field label { text-transform: none; letter-spacing: 0; }
        .app-card-text { display: flex; flex-direction: column; min-width: 0; }
        .app-card-name { font-weight: 600; font-size: 15px; }
        .app-card-desc { font-size: 13px; color: var(--fanous-color-text-secondary); margin-top: 2px; }

        .app-tile {
            width: 40px; height: 40px; border-radius: 10px;
            display: inline-flex; align-items: center; justify-content: center; color: white; flex-shrink: 0;
        }
        .app-tile-www { background: linear-gradient(135deg, #14b8a6, #0f766e); }
        .app-tile-cms { background: linear-gradient(135deg, #ef4444, #b91c1c); }
        .app-tile-videos { background: linear-gradient(135deg, var(--fanous-color-primary), var(--fanous-color-primary-pressed)); }
        .app-tile-profile { background: linear-gradient(135deg, #10b981, #047857); }
        .app-tile-content-admin { background: linear-gradient(135deg, #f59e0b, #b45309); }
        .app-tile-auth-admin { background: linear-gradient(135deg, #8b5cf6, #5b21b6); }

        /* Your apps */
        .apps-section { max-width: 600px; margin: 0 auto 2rem; }
        .apps-section h2 { font-size: 1.25rem; color: var(--auth-profile-heading-text, var(--fanous-color-text-primary)); }
        .apps-section-sub { color: var(--fanous-color-text-secondary); font-size: 0.95rem; margin: 0.25rem 0 1rem; }
        .apps-cards-subheading {
            font-size: 0.8rem; color: var(--fanous-color-text-secondary); text-transform: uppercase; letter-spacing: 0.06em;
            margin: 1.25rem 0 0.5rem; font-weight: 600;
        }
        html[lang="ar"] .apps-cards-subheading { text-transform: none; letter-spacing: 0; }
        .apps-cards { list-style: none; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        .app-card {
            display: flex; align-items: center; gap: 12px; padding: 14px;
            background: var(--auth-profile-card-background, linear-gradient(135deg, var(--fanous-color-surface-raised) 0%, var(--fanous-color-surface) 100%));
            border: 1px solid var(--auth-profile-card-border, color-mix(in srgb, var(--fanous-color-text-secondary) 20%, transparent)); border-radius: var(--auth-profile-card-radius, 12px);
            color: var(--fanous-color-text-primary); text-decoration: none; height: 100%;
            transition: border-color 0.2s ease, transform 0.2s ease;
        }
        .app-card:hover { border-color: var(--fanous-color-primary); transform: translateY(-1px); }
        .app-card-text { flex: 1; }
        .app-card-arrow { color: #64748b; flex-shrink: 0; }
        [dir="rtl"] .app-card-arrow { transform: scaleX(-1); }


        .btn {
            padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; transition: all 0.3s ease;
            cursor: pointer; border: none; font-size: 14px; display: inline-flex; align-items: center; gap: 8px; font-family: inherit;
        }
        .btn-primary { background: var(--auth-profile-button-background, linear-gradient(135deg, var(--fanous-color-primary) 0%, var(--fanous-color-primary-hover) 100%)); color: var(--auth-profile-button-text, white); box-shadow: 0 2px 8px rgba(14, 165, 233, 0.3); }
        .btn-primary:hover { background: linear-gradient(135deg, var(--fanous-color-primary-hover) 0%, var(--fanous-color-primary-pressed) 100%); transform: translateY(-2px); box-shadow: 0 4px 16px rgba(14, 165, 233, 0.4); }
        .btn-secondary { background: rgba(255, 255, 255, 0.1); color: var(--fanous-color-text-primary); border: 1px solid rgba(255, 255, 255, 0.2); }
        .btn-secondary:hover { background: rgba(255, 255, 255, 0.2); color: white; }

        .container { width: 100%; max-width: 1200px; margin: 0 auto; padding: 3rem 2rem; flex: 1; }
        .hero { text-align: center; margin-bottom: 3rem; }
        .hero h1 {
            font-size: 3rem; font-weight: 800; margin-bottom: 1rem;
            background: linear-gradient(135deg, var(--fanous-color-primary) 0%, #06b6d4 100%);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
        }
        .hero p { font-size: 1.25rem; color: #cbd5e1; max-width: 600px; margin: 0 auto; line-height: 1.6; }
        .profile-card {
            background: var(--auth-profile-card-background, linear-gradient(135deg, var(--fanous-color-surface-raised) 0%, var(--fanous-color-surface) 100%)); padding: 2rem; border-radius: var(--auth-profile-card-radius, 12px);
            border: 1px solid var(--auth-profile-card-border, color-mix(in srgb, var(--fanous-color-text-secondary) 20%, transparent)); box-shadow: var(--auth-profile-card-shadow, 0 4px 20px rgba(0, 0, 0, 0.4)); max-width: 600px; margin: 0 auto;
        }
        .profile-card h2 { color: var(--auth-profile-heading-text, var(--fanous-color-primary)); margin-bottom: 1.5rem; font-size: 1.75rem; }
        .profile-field { margin-bottom: 1rem; padding: 1rem; background: rgba(15, 23, 42, 0.6); border-radius: 8px; }
        .profile-field label {
            display: block; color: var(--fanous-color-text-secondary); font-size: 0.875rem; margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em;
        }
        .profile-field .value { color: var(--fanous-color-text-primary); font-size: 1.125rem; font-weight: 500; overflow-wrap: anywhere; }
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
            background: linear-gradient(135deg, var(--fanous-color-background) 0%, var(--fanous-color-surface-raised) 100%); padding: 2rem;
            border-top: 1px solid color-mix(in srgb, var(--fanous-color-text-secondary) 20%, transparent); text-align: center; color: var(--fanous-color-text-secondary);
        }

        @media (max-width: 640px) {
            .navbar { padding: 0.5rem 1rem; }
            .logo-brand { display: none; }
            .logo-app { font-size: 1.1rem; }
            .logo img { width: 34px; height: 34px; }
            .nav-actions { gap: 0.25rem; }
            .container { padding: 1.5rem 1rem; }
            .hero h1 { font-size: 2rem; }
            .apps-cards { grid-template-columns: 1fr; }
            .profile-card { padding: 1.25rem; }
        }

        /* Confirmation dialog (never a browser prompt) */
        .confirm-dialog {
            padding: 0; border: 1px solid color-mix(in srgb, var(--fanous-color-text-secondary) 20%, transparent); border-radius: 12px;
            max-inline-size: min(28rem, calc(100vw - 2rem)); inline-size: 100%; margin: auto;
            background: var(--fanous-color-surface-raised); color: var(--fanous-color-text-primary); box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
        }
        .confirm-dialog::backdrop { background: rgba(0, 0, 0, 0.6); }
        .confirm-dialog form { padding: 1.5rem; }
        .confirm-dialog h2 { font-size: 1.125rem; margin-block-end: 0.5rem; text-align: start; }
        .confirm-dialog p { color: var(--fanous-color-text-secondary); font-size: 0.9rem; line-height: 1.5; margin-block-end: 1.5rem; text-align: start; overflow-wrap: anywhere; }
        .confirm-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem; }
        .confirm-actions .btn { padding: 0.6rem 1.1rem; font-size: 0.9rem; }
        .btn-danger { background: #dc2626; color: #fff; border: 1px solid #b91c1c; }
        .btn-danger:hover { background: #b91c1c; }
`;

const ICON_SIGNIN = '<svg class="aun-menu-icon aun-flip" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg>';
const ICON_SESSIONS = '<svg class="aun-menu-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
const ICON_SIGNOUT = '<svg class="aun-menu-icon aun-flip" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>';

export function renderHomePage(o: HomePageOptions): string {
  const theme = o.theme ?? { id: BUILTIN_DEFAULT_THEME, css: compileBuiltin(BUILTIN_DEFAULT_THEME, o.authServerUrl)!.tokensCss };
  const t = MESSAGES[o.locale];
  const e = escapeHtml;
  const other: Locale = o.locale === "ar" ? "en" : "ar";
  const isLoggedIn = o.user !== null;

  return `<!DOCTYPE html>
<html lang="${o.locale}" dir="${dirFor(o.locale)}" data-theme="${e(theme.id)}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${e(t.pageTitle)}</title>
    ${iconLinks(o.environment, { manifest: true, themeColor: PROFILE_THEME_COLOR })}
    <style>${theme.css}${NAV_CSS}${STYLES}</style>
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
                <a class="lang-toggle aun-lang" href="?lang=${other}" lang="${other}" hreflang="${other}" aria-label="${e(t.switchLanguageLabel)}">${e(t.switchLanguage)}</a>
                <div class="account-switcher" id="accountSwitcher" style="display: none; position: relative;">
                    <button type="button" class="account-trigger aun-acct-btn" id="accountTrigger" aria-haspopup="menu" aria-expanded="false" aria-controls="accountDropdown" onclick="toggleAccountDropdown()">
                        <span class="aun-avatar" id="activeAvatar" aria-hidden="true">?</span>
                        <span class="aun-acct-name" id="activeEmail" dir="auto">${e(t.loading)}</span>
                        <span class="visually-hidden">${e(t.accountMenu)}</span>
                        <svg class="aun-caret" id="chevronIcon" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                            <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </button>
                    <div class="account-dropdown aun-menu" id="accountDropdown" role="menu" hidden>
                        <div class="aun-menu-who" id="accountWho"></div>
                        <div class="aun-menu-sep" role="separator"></div>
                        <span class="dropdown-header aun-menu-label" id="accountsLabel">${e(t.moreAccounts)}</span>
                        <div class="accounts-list" id="accountsList" role="group" aria-labelledby="accountsLabel"></div>
                        <button type="button" class="dropdown-action aun-menu-item" role="menuitem" id="addAccountBtn" onclick="handleAddAccount()">${ICON_SIGNIN}<span class="aun-menu-text">${e(t.addAccount)}</span></button>
                        <div class="aun-menu-sep" role="separator"></div>
                        <button type="button" class="dropdown-action aun-menu-item" role="menuitem" onclick="handleManageSessions()">${ICON_SESSIONS}<span class="aun-menu-text">${e(t.manageSessions)}</span></button>
                        ${renderAppsSection(o.apps, t)}
                        <div class="aun-menu-sep" role="separator"></div>
                        <button type="button" class="dropdown-action aun-menu-item" role="menuitem" id="signOutOne" onclick="requestSignOutAccount(currentUser.id)">${ICON_SIGNOUT}<span class="aun-menu-text">${e(t.signOut)}</span></button>
                        <button type="button" class="dropdown-action danger aun-menu-item aun-menu-item--danger" role="menuitem" id="signOutAllBtn" onclick="requestSignOutAll()">${ICON_SIGNOUT}<span class="aun-menu-text">${e(t.signOutAll)}</span></button>
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

    <dialog class="confirm-dialog" id="confirmDialog" role="alertdialog" aria-labelledby="confirmTitle" aria-describedby="confirmMessage">
        <form method="dialog">
            <h2 id="confirmTitle"></h2>
            <p id="confirmMessage"></p>
            <div class="confirm-actions">
                <button type="submit" value="cancel" class="btn btn-secondary" id="confirmCancel" autofocus>${e(t.confirmCancel)}</button>
                <button type="submit" value="confirm" class="btn btn-danger" id="confirmAction" data-testid="confirm-action"></button>
            </div>
        </form>
    </dialog>

    <script>
        var currentUser = ${scriptJson(o.user)};
        var isLoggedIn = ${isLoggedIn};
        var authServerUrl = ${scriptJson(o.authServerUrl)};
        var appUrl = ${scriptJson(o.appUrl)};
        var clientId = ${scriptJson(o.clientId)};
        var T = ${scriptJson(t)};
        var SIGNOUT_ICON = ${scriptJson(ICON_SIGNOUT)};

        var accounts = [];
        var dropdownOpen = false;
        var MAX_ACCOUNTS = 3;

        function esc(s) {
            return String(s).replace(/[&<>"']/g, function (c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
        }
        function formatRelativeTime(dateString) {
            var diffMins = Math.floor((Date.now() - new Date(dateString).getTime()) / 60000);
            if (diffMins < 1) return T.justNow;
            if (diffMins < 60) return T.minutesAgo.replace('{n}', diffMins);
            if (diffMins < 1440) return T.hoursAgo.replace('{n}', Math.floor(diffMins / 60));
            return T.daysAgo.replace('{n}', Math.floor(diffMins / 1440));
        }
        // Every sign-in goes through this app's /login (it keeps the return path).
        // No prompt = auth decides (silent for its active account, else the form);
        // 'none' = silent only (after switching accounts); 'login' = add an account.
        function loginUrl(prompt) {
            var url = '/login?return=' + encodeURIComponent(window.location.pathname + window.location.search);
            return prompt ? url + '&prompt=' + prompt : url;
        }

        function setAccountDropdown(open) {
            dropdownOpen = open;
            document.getElementById('accountDropdown').hidden = !open;
            document.getElementById('accountTrigger').setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        function menuItems() {
            return Array.prototype.slice.call(document.querySelectorAll('#accountDropdown a, #accountDropdown button:not([disabled])'))
                .filter(function (el) { return el.offsetParent !== null; });
        }
        // Keyboard (AlUmmahNow docs/design/NAV.md): ArrowDown on the button opens at the first item;
        // ArrowUp/ArrowDown move, Home/End jump, Escape closes and returns focus to the button.
        document.getElementById('accountTrigger').addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setAccountDropdown(true); var l = menuItems(); if (l[0]) l[0].focus(); }
        });
        document.getElementById('accountDropdown').addEventListener('keydown', function (e) {
            var list = menuItems();
            var i = list.indexOf(document.activeElement);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                var next = (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
                if (list[next]) list[next].focus();
            } else if (e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                var target = list[e.key === 'Home' ? 0 : list.length - 1];
                if (target) target.focus();
            }
        });
        function toggleAccountDropdown() { setAccountDropdown(!dropdownOpen); }
        document.addEventListener('click', function (e) {
            var switcher = document.getElementById('accountSwitcher');
            if (switcher && !switcher.contains(e.target) && dropdownOpen) setAccountDropdown(false);
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && dropdownOpen) { setAccountDropdown(false); document.getElementById('accountTrigger').focus(); }
        });

        // The list is every account signed in to this browser, from the auth
        // server; this app's own user is only a placeholder until it loads.
        async function loadAccounts() {
            if (isLoggedIn && currentUser && accounts.length === 0) {
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

        function initialOf(text) { return (Array.from(String(text || '?').trim())[0] || '?').toUpperCase(); }
        // An email that keeps its domain when it does not fit (AlUmmahNow docs/design/NAV.md): the
        // local part shrinks with an ellipsis, "@domain" stays whole, the full address is the tooltip
        function emailHtml(email, cls) {
            var at = email.lastIndexOf('@');
            if (at <= 0) return '<span class="' + cls + '" dir="ltr" title="' + esc(email) + '">' + esc(email) + '</span>';
            return '<span class="' + cls + ' aun-email" dir="ltr" title="' + esc(email) + '"><span class="aun-email-local">' + esc(email.slice(0, at)) + '</span><span class="aun-email-domain">' + esc(email.slice(at)) + '</span></span>';
        }
        // The account's name (auth's /session list carries it), else the email
        function nameOf(account) { return (account && account.name && String(account.name).trim()) || (account && account.email) || ''; }

        function renderAccountSwitcher() {
            var switcher = document.getElementById('accountSwitcher');
            if (!isLoggedIn || !currentUser) { switcher.style.display = 'none'; return; }
            switcher.style.display = 'inline-block';
            var activeAccount = accounts.find(function (a) { return a.isActive; });
            var displayAccount = activeAccount || { email: currentUser.email };
            var name = nameOf(displayAccount);
            document.getElementById('activeAvatar').textContent = initialOf(name);
            document.getElementById('activeEmail').textContent = name;
            document.getElementById('accountWho').innerHTML =
                '<span class="aun-avatar aun-avatar--lg" aria-hidden="true">' + esc(initialOf(name)) + '</span>' +
                '<span class="aun-menu-who-text"><span class="aun-menu-who-name" dir="auto">' + esc(name) + '</span>' +
                (displayAccount.email && displayAccount.email !== name ? emailHtml(displayAccount.email, 'aun-menu-who-sub') : '') + '</span>';

            // More accounts (the Google pattern): the current account is the top of the menu; the
            // other accounts are listed here, each with a sign-out icon button
            var others = accounts.filter(function (a) { return !(a.isActive && a.userId === currentUser.id); });
            var several = accounts.length > 1;
            document.getElementById('accountsLabel').hidden = others.length === 0;
            document.getElementById('accountsList').innerHTML = others.map(function (account) {
                var id = esc(account.userId);
                var label = nameOf(account);
                var lines = (account.email && account.email !== label ? emailHtml(account.email, 'aun-acct-email') : '') +
                    (account.isActive ? '<span class="aun-acct-current status">' + esc(T.active) + '</span>' : '');
                return '<div class="account-item aun-acct-row' + (account.isActive ? ' active' : '') + '" data-user-id="' + id + '" data-testid="account-item">' +
                    '<button type="button" class="aun-menu-item" role="menuitem" aria-label="' + esc(T.switchTo.replace('{name}', label)) + '" onclick="handleSwitchAccount(this.parentNode.dataset.userId)">' +
                    '<span class="aun-avatar" aria-hidden="true">' + esc(initialOf(label)) + '</span>' +
                    '<span class="aun-acct-text account-details"><span class="aun-acct-label email" dir="auto">' + esc(label) + '</span>' + lines + '</span>' +
                    '</button>' +
                    '<button type="button" class="sign-out-btn aun-acct-signout" data-user-id="' + id + '" onclick="event.stopPropagation(); requestSignOutAccount(this.dataset.userId)" aria-label="' + esc(T.signOutOf.replace('{name}', label)) + '" title="' + esc(T.signOutOf.replace('{name}', label)) + '">' + SIGNOUT_ICON + '</button>' +
                    '</div>';
            }).join('');
            document.getElementById('addAccountBtn').style.display = accounts.length < MAX_ACCOUNTS ? 'flex' : 'none';
            document.getElementById('signOutAllBtn').style.display = several ? 'flex' : 'none';
        }

        async function handleSwitchAccount(userId) {
            try {
                var response = await fetch(authServerUrl + '/session/switch', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                    body: JSON.stringify({ userId: userId }),
                });
                if (response.ok) {
                    // Silent re-auth: the auth server's active account just changed.
                    window.location.href = loginUrl('none');
                } else {
                    console.error('Failed to switch account:', await response.text());
                }
            } catch (error) {
                console.error('Failed to switch account:', error);
            }
        }

        // In-page confirmation: Cancel, Esc and a click on the backdrop do nothing
        var confirmPending = null;
        function askToConfirm(title, message, action, onConfirm) {
            var dlg = document.getElementById('confirmDialog');
            if (!dlg || typeof dlg.showModal !== 'function' || dlg.open) return;
            document.getElementById('confirmTitle').textContent = title;
            document.getElementById('confirmMessage').textContent = message;
            document.getElementById('confirmAction').textContent = action;
            confirmPending = onConfirm;
            dlg.returnValue = '';
            setAccountDropdown(false);
            dlg.showModal();
            document.getElementById('confirmCancel').focus();
        }
        (function () {
            var dlg = document.getElementById('confirmDialog');
            dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close('cancel'); });
            dlg.addEventListener('close', function () {
                var run = confirmPending;
                confirmPending = null;
                if (run && dlg.returnValue === 'confirm') run();
                else document.getElementById('accountTrigger').focus();
            });
        })();
        function requestSignOutAll() {
            askToConfirm(T.signOutAllTitle, T.signOutAllMessage, T.signOutAllAction, handleSignOutAll);
        }
        function requestSignOutAccount(userId) {
            var account = accounts.find(function (a) { return a.userId === userId; });
            var email = account ? account.email : '';
            askToConfirm(T.signOutAccountTitle, T.signOutAccountMessage.replace('{email}', function () { return email; }), T.signOutAccount, function () {
                handleSignOutAccount(userId);
            });
        }

        async function handleSignOutAccount(userId) {
            var others = accounts.filter(function (a) { return a.userId !== userId; });
            // The last account: single sign-out everywhere
            if (others.length === 0) { window.location.href = '/logout'; return; }
            try {
                var removed = accounts.find(function (a) { return a.userId === userId; });
                var response = await fetch(authServerUrl + '/session/accounts/' + encodeURIComponent(userId), { method: 'DELETE', credentials: 'include' });
                if (!response.ok) { console.error('Failed to sign out:', response.status); return; }
                if ((currentUser && userId === currentUser.id) || (removed && removed.isActive)) {
                    // This app was using that account: sign in silently as auth's new active account
                    window.location.href = loginUrl('none');
                } else {
                    await loadAccounts();
                }
            } catch (error) {
                console.error('Failed to sign out:', error);
            }
        }

        function handleAddAccount() { window.location.href = loginUrl('login'); }
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

        function handleLogin() { window.location.href = loginUrl(''); }
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
