/**
 * OAuth clients have a display name in English (`name`) and Arabic
 * (`metadata.name_ar`). The account selector shows it ("to continue to …"),
 * so both are required (owner rule: localized staff-set fields need both
 * languages; no fallback).
 *
 * Runs in front of OpenAuth's clientAdminRoutes:
 * - POST /clients: `name` and `metadata.name_ar` must be non-empty.
 * - PATCH /clients/:id that sets `name` or `metadata`: the client must end up
 *   with both. OpenAuth replaces `metadata` as a whole, so a PATCH that sends
 *   `metadata` must carry `name_ar`; one that only renames keeps the stored one.
 * Other PATCHes (enable, redirect URIs, scopes alone) pass, so a legacy client
 * without an Arabic name can still be managed; the admin list flags it.
 *
 * Reads at most one row, by primary key.
 */
import type { MiddlewareHandler } from 'hono';
import { emptyLangs } from '../../../../packages/ui/src/l10n/localized.ts';

type Body = { name?: unknown; metadata?: unknown };

const bad = (message: string, field: string) => ({ error: 'Bad Request', error_description: message, message, field });

function parse(raw: string | null): unknown {
	try {
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

function nameArOf(metadata: unknown): string {
	const v = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).name_ar : undefined;
	return typeof v === 'string' ? v : '';
}

export function requireLocalizedClientName(db: () => D1Database): MiddlewareHandler {
	return async (c, next) => {
		const method = c.req.method;
		const path = new URL(c.req.url).pathname;
		const create = method === 'POST' && /^\/clients\/?$/.test(path);
		const update = method === 'PATCH' && /^\/clients\/[^/]+\/?$/.test(path);
		if (!create && !update) return next();

		let body: Body;
		try {
			body = (await c.req.json()) as Body;
		} catch {
			return next(); // OpenAuth answers malformed JSON itself
		}
		if (!body || typeof body !== 'object') return next();

		if (create) {
			const missing = emptyLangs({ en: typeof body.name === 'string' ? body.name : '', ar: nameArOf(body.metadata) });
			if (missing.includes('en')) return c.json(bad('The English name is required', 'name'), 400);
			if (missing.includes('ar')) return c.json(bad('The Arabic name (metadata.name_ar) is required', 'name_ar'), 400);
			return next();
		}

		const setsName = body.name !== undefined;
		const setsMetadata = body.metadata !== undefined;
		if (!setsName && !setsMetadata) return next();
		if (setsName && (typeof body.name !== 'string' || !body.name.trim())) {
			return c.json(bad('The English name is required', 'name'), 400);
		}
		if (setsMetadata) {
			if (!nameArOf(body.metadata).trim()) return c.json(bad('The Arabic name (metadata.name_ar) is required', 'name_ar'), 400);
			return next();
		}
		// Rename only: the stored Arabic name must already be there
		const clientId = decodeURIComponent(path.split('/')[2] ?? '');
		const row = await db().prepare('SELECT metadata FROM oauth_clients WHERE id = ?').bind(clientId).first<{ metadata: string | null }>();
		if (row && !nameArOf(parse(row.metadata)).trim()) {
			return c.json(bad('Add the Arabic name (metadata.name_ar) with the English one', 'name_ar'), 400);
		}
		return next();
	};
}
