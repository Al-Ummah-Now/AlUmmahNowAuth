/**
 * An E2E run account an admin creates gets the run marker, like one that signs up (markRunUser), so
 * the run's teardown may delete it. QA and stage only: markRunUser checks the address and the
 * deployment, and does nothing for any other account or in production.
 */
import type { MiddlewareHandler } from 'hono';
import { isRunUserEmail, markRunUser, type RunUsersEnv } from '../utils/e2e-sink';

/** Mount on the collection's own path: only creating a user answers 201 with an id and an email. */
export function markCreatedRunUser(env: RunUsersEnv & { AUTH_DB: D1Database }): MiddlewareHandler {
	return async (c, next) => {
		await next();
		if (c.req.method !== 'POST' || c.res.status !== 201) return;
		const user = (await c.res
			.clone()
			.json()
			.catch(() => null)) as { id?: unknown; email?: unknown } | null;
		if (typeof user?.id !== 'string' || typeof user.email !== 'string' || !isRunUserEmail(user.email.toLowerCase())) return;
		await markRunUser(env, env.AUTH_DB, { id: user.id, email: user.email }, 'admin-create');
	};
}
