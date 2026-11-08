/**
 * Server-rendered markup for the app launcher (header menu button) and the
 * "Your apps" cards. Pure string functions so they can be unit tested.
 *
 * Accessibility follows the WAI-ARIA APG "menu button" pattern (navigation
 * variant): a <button aria-haspopup aria-expanded aria-controls> opens a
 * role="menu" whose items are links with role="menuitem". Keyboard handling
 * lives in LAUNCHER_SCRIPT.
 */

import type { AppIcon, VisibleApp } from "./apps";
import type { Messages } from "./i18n";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ICON_PATHS: Record<AppIcon, string> = {
  play: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
};

export function appIcon(icon: AppIcon): string {
  return `<svg class="app-icon-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[icon]}</svg>`;
}

const GRID_ICON =
  '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" focusable="false">' +
  [3, 10, 17].flatMap((y) => [3, 10, 17].map((x) => `<circle cx="${x}" cy="${y}" r="2"/>`)).join("") +
  "</svg>";

function groups(apps: VisibleApp[], t: Messages) {
  return [
    { key: "app" as const, label: t.groupApps, items: apps.filter((a) => a.category === "app") },
    { key: "admin" as const, label: t.groupAdmin, items: apps.filter((a) => a.category === "admin") },
  ].filter((g) => g.items.length > 0);
}

function menuItem(app: VisibleApp, t: Messages): string {
  const current = app.current ? ' aria-current="page"' : "";
  const pill = app.current ? `<span class="apps-item-pill">${escapeHtml(t.current)}</span>` : "";
  return `<a role="menuitem" tabindex="-1" class="apps-item${app.current ? " is-current" : ""}" href="${escapeHtml(app.url)}" data-app="${app.id}"${current}>
          <span class="app-tile app-tile-${app.id}">${appIcon(app.icon)}</span>
          <span class="apps-item-text"><span class="apps-item-name">${escapeHtml(app.name)}</span><span class="apps-item-desc">${escapeHtml(app.description)}</span></span>
          ${pill}
        </a>`;
}

/** Header launcher: icon button plus menu. */
export function renderLauncher(apps: VisibleApp[], t: Messages): string {
  const body = groups(apps, t)
    .map(
      (g) => `<div role="group" aria-labelledby="appsGroup-${g.key}" class="apps-group">
        <div class="apps-group-label" id="appsGroup-${g.key}" aria-hidden="true">${escapeHtml(g.label)}</div>
        ${g.items.map((a) => menuItem(a, t)).join("\n        ")}
      </div>`,
    )
    .join('\n      <div role="separator" class="apps-separator"></div>\n      ');

  return `<div class="apps-launcher" id="appsLauncher">
    <button type="button" class="icon-btn" id="appsTrigger" aria-haspopup="true" aria-expanded="false" aria-controls="appsMenu" aria-label="${escapeHtml(t.appsButton)}" title="${escapeHtml(t.appsButton)}">${GRID_ICON}</button>
    <div class="apps-menu" id="appsMenu" role="menu" aria-labelledby="appsTrigger" hidden>
      ${body}
    </div>
  </div>`;
}

/** "Your apps" cards on the profile home. Omits the current app; empty string if nothing else to show. */
export function renderAppCards(apps: VisibleApp[], t: Messages): string {
  const others = apps.filter((a) => !a.current);
  if (others.length === 0) return "";
  const sections = groups(others, t)
    .map((g) => {
      const heading = g.key === "admin" ? `<h3 class="apps-cards-subheading">${escapeHtml(g.label)}</h3>` : "";
      const cards = g.items
        .map(
          (a) => `<li><a class="app-card" href="${escapeHtml(a.url)}" data-app="${a.id}">
            <span class="app-tile app-tile-${a.id}">${appIcon(a.icon)}</span>
            <span class="app-card-text"><span class="app-card-name">${escapeHtml(a.name)}</span><span class="app-card-desc">${escapeHtml(a.description)}</span></span>
            <span class="app-card-arrow" aria-hidden="true">›</span>
          </a></li>`,
        )
        .join("\n");
      return `${heading}<ul class="apps-cards" data-group="${g.key}">${cards}</ul>`;
    })
    .join("\n");
  return `<section class="apps-section" id="yourApps" aria-labelledby="yourAppsHeading">
      <h2 id="yourAppsHeading">${escapeHtml(t.appsHeading)}</h2>
      <p class="apps-section-sub">${escapeHtml(t.appsSubheading)}</p>
      ${sections}
    </section>`;
}

/**
 * Client-side keyboard and pointer behaviour for the launcher (APG menu button):
 * - Enter / Space / ArrowDown on the button open the menu and focus the first item; ArrowUp focuses the last.
 * - In the menu: ArrowDown/ArrowUp move (wrapping), Home/End jump, a printable character jumps to the
 *   next item starting with it, Escape closes and returns focus, Tab closes and lets focus move on.
 * - Enter or Space follows the link (same tab).
 * - Clicking outside closes.
 * Plain ES5-ish string with no template literals so it embeds safely in the page template.
 */
export const LAUNCHER_SCRIPT = `
(function () {
  var trigger = document.getElementById('appsTrigger');
  var menu = document.getElementById('appsMenu');
  if (!trigger || !menu) return;
  function items() { return Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]')); }
  function isOpen() { return trigger.getAttribute('aria-expanded') === 'true'; }
  function focusAt(i) {
    var list = items();
    if (!list.length) return;
    list[(i + list.length) % list.length].focus();
  }
  function open(index) {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    focusAt(index === 'last' ? items().length - 1 : 0);
  }
  function close(returnFocus) {
    if (!isOpen()) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (returnFocus) trigger.focus();
  }
  trigger.addEventListener('click', function () { isOpen() ? close(true) : open(0); });
  trigger.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); open('last'); }
  });
  menu.addEventListener('keydown', function (e) {
    var list = items();
    var i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(list.length - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') { close(false); }
    else if (e.key === ' ') { e.preventDefault(); if (document.activeElement) document.activeElement.click(); }
    else if (e.key.length === 1 && /\\S/.test(e.key)) {
      var ch = e.key.toLowerCase();
      for (var k = 1; k <= list.length; k++) {
        var cand = list[(i + k) % list.length];
        var name = cand.querySelector('.apps-item-name');
        if (name && name.textContent.trim().toLowerCase().indexOf(ch) === 0) { cand.focus(); break; }
      }
    }
  });
  menu.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a[aria-current="page"]') : null;
    if (a) { e.preventDefault(); close(true); }
  });
  document.addEventListener('click', function (e) {
    var root = document.getElementById('appsLauncher');
    if (isOpen() && root && !root.contains(e.target)) close(false);
  });
})();
`;
