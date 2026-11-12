/**
 * Server-rendered markup for the account menu's "Al Ummah Now apps" section and the
 * "Your apps" cards. Pure string functions so they can be unit tested.
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
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
  play: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  pencil: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
};

export function appIcon(icon: AppIcon): string {
  return `<svg class="app-icon-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[icon]}</svg>`;
}

function groups(apps: VisibleApp[], t: Messages) {
  return [
    { key: "app" as const, label: t.groupApps, items: apps.filter((a) => a.category === "app") },
    { key: "admin" as const, label: t.groupAdmin, items: apps.filter((a) => a.category === "admin") },
  ].filter((g) => g.items.length > 0);
}

/**
 * The account menu's "Al Ummah Now apps" section (AlUmmahNow docs/design/NAV.md): the other apps
 * this account may open, in the shared order and labels; this app is left out. Empty when there
 * is nothing else to open.
 */
export function renderAppsSection(apps: VisibleApp[], t: Messages): string {
  const others = apps.filter((a) => !a.current);
  if (others.length === 0) return "";
  const items = others
    .map((a) => `<a role="menuitem" class="aun-menu-item" href="${escapeHtml(a.url)}" data-app="${a.id}"><span class="aun-menu-text">${escapeHtml(a.name)}</span></a>`)
    .join("\n");
  return `<div class="aun-menu-sep" role="separator"></div>
    <div role="group" aria-labelledby="appsLabel" id="accountApps">
      <span class="aun-menu-label" id="appsLabel">${escapeHtml(t.appsButton)}</span>
      ${items}
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
            <svg class="app-card-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6"/></svg>
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
