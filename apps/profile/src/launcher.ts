/**
 * Server-rendered markup for the account menu's "Al Ummah Now apps" section and the
 * "Your apps" cards. Pure string functions so they can be unit tested.
 */

import type { VisibleApp } from "./apps";
import type { Messages } from "./i18n";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
/** The shared nav's icon ids (AlUmmahNow packages/shared-types app-links): the content admin is "admin". */
const NAV_ICON: Record<string, string> = { www: "www", videos: "videos", profile: "profile", cms: "cms", "content-admin": "admin", "auth-admin": "auth-admin" };

export function renderAppsSection(apps: VisibleApp[], t: Messages): string {
  const others = apps.filter((a) => !a.current);
  if (others.length === 0) return "";
  const items = others
    .map((a) => `<a role="menuitem" class="aun-menu-item" href="${escapeHtml(a.url)}" data-app="${a.id}"><span class="aun-app-icon" data-app="${NAV_ICON[a.id]}" aria-hidden="true"></span><span class="aun-menu-text">${escapeHtml(a.name)}</span></a>`)
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
            <span class="aun-app-icon aun-app-icon--card" data-app="${NAV_ICON[a.id]}" aria-hidden="true"></span>
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
