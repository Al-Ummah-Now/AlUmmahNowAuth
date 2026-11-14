/**
 * @fileoverview Authentication handlers for OpenAuth callbacks
 *
 * Contains the onSuccess callback and related authentication logic
 * that is called after successful password verification.
 */

import { logger } from '../logger';
import { getClientIP } from '../rate-limit';
import { getAuditEmitter } from '../audit-emitter';
import { createLoginSuccessEvent, createLoginFailedEvent } from '../audit-events';
import { trackEvent } from '../utils/analytics';
import { shouldSinkCode, sinkKey, storeSinkCode, markRunUser, type RunUsersEnv } from '../utils/e2e-sink';
import { CODE_TTL_SECONDS, recordCode } from '../security/password-attempts';
import type { RBACServiceImpl } from '@al-ummah-now/openauth/rbac/index';
import { Storage, type StorageAdapter } from '@al-ummah-now/openauth/storage/storage';
import type { PasswordSendCodeError } from '@al-ummah-now/openauth/provider/password';
import { getLocaleFromRequest } from '@al-ummah-now/openauth/ui/i18n';
import { accountStateOf, isRefusedAccountState, readAccountState, type AccountState } from '../security/account-status';
import { endBrowserSignIns } from '../revocation/lifecycle';
import { renderAccountSuspendedPage } from '../ui/account-suspended-page';
import type { Theme } from '@al-ummah-now/openauth/ui/theme';
import { claimInvitedAccount } from '../invites/service';
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import type { RequestTimer } from '../utils/request-timing';
import { passkeyDeadline } from '../passkeys/policy';
import { afterSignInCard } from '../passkeys/card';
import { flagSystemAccountAttempt, isSystemUser, type SystemAccountEnv } from '../security/system-accounts';

/** Times `fn` as a stage of the request when there is a timer (#804). */
function staged<T>(timer: RequestTimer | undefined, name: string, fn: () => Promise<T>): Promise<T> {
	return timer ? timer.stage(name, fn) : fn();
}

/**
 * Returned from sendCode when the code could not be delivered. The password
 * provider re-renders the same form with a localized "couldn't send the code"
 * message instead of the error escaping to the issuer (server_error redirect).
 */
const CODE_SEND_FAILED: PasswordSendCodeError = { type: 'code_send_failed' };

/**
 * Context passed to auth handlers from the main request
 */
export interface AuthHandlerContext {
	request: Request;
	env: Partial<RunUsersEnv> & {
		AUTH_ANALYTICS?: AnalyticsEngineDataset;
	};
	ctx: ExecutionContext;
	requestId: string;
	/**
	 * AUTH_DB: account status (#662) is re-read here when the user service
	 * returned no status, and a refused user's browser sign-ins are ended.
	 */
	db?: D1Database;
	/** Where the "account suspended" page links back to. */
	homeUrl?: string;
	/** This request's sign-in theme: the "account suspended" page matches the sign-in pages. */
	theme?: Theme;
	/** This request's timings (Server-Timing, auth.timing log) */
	timer?: RequestTimer;
}

/**
 * User service interface for looking up users
 */
export interface UserServiceLike {
	/** D1-first (D1UserService); `status`/`deleted_at` come from the D1 row. */
	getUserByEmail(
		tenantId: string,
		email: string
	): Promise<{ id: string; email: string; status?: string; deleted_at?: number | null; metadata?: unknown } | null>;
	createUser(
		tenantId: string,
		data: { email: string; name?: string | null }
	): Promise<{ id: string; email: string }>;
	updateLastLogin(
		tenantId: string,
		userId: string
	): Promise<void>;
}

/**
 * Auth context passed by OpenAuth to onSuccess callback
 */
export interface OpenAuthContext {
	subject: (
		type: string,
		properties: { id: string; email: string; roles: string[]; passkey_deadline?: number }
	) => Promise<Response>;
}

/**
 * Tenant info from OpenAuth
 */
export interface TenantInfo {
	id?: string;
}

/**
 * Value passed from enterprise issuer after authentication
 * Matches OpenAuth's EnterpriseAuthResult
 */
export interface EnterpriseAuthResult {
	provider: string;
	userID?: string;
	/** RFC 8176 methods of this sign-in (pwd, passkey, ...) */
	amr?: string[];
	type?: string;
	properties?: Record<string, unknown>;
	refresh?: string;
	tenantId: string;
	roles: string[];
	// Legacy: some flows might pass email directly
	email?: unknown;
}

/**
 * Create the onSuccess handler for OpenAuth enterprise issuer
 *
 * This handler is called after successful password verification.
 * It looks up the user, fetches their roles, and creates the subject response.
 *
 * @param userService - Service for looking up users
 * @param rbacService - Service for fetching user roles
 * @param handlerCtx - Context from the main request handler
 * @returns The onSuccess callback function
 */
export function createOnSuccessHandler(
	userService: UserServiceLike,
	rbacService: RBACServiceImpl,
	handlerCtx: AuthHandlerContext
) {
	const { request, env, ctx, requestId, db, homeUrl, theme, timer } = handlerCtx;

	/** D1 state of an existing account: the user service's row, else a direct D1 read. */
	async function stateOf(user: { id: string; status?: string; deleted_at?: number | null; metadata?: unknown }): Promise<AccountState> {
		// System accounts never sign in (security/system-accounts.ts)
		if (isSystemUser(user)) return 'system';
		if (typeof user.status === 'string') return accountStateOf({ status: user.status, deleted_at: user.deleted_at ?? null });
		return db ? readAccountState(db, user.id) : 'missing';
	}

	/**
	 * A suspended or deleted account gets no tokens (#662). Silent sign-on with
	 * prompt=none answers the app with login_required (OIDC), so the app shows
	 * its sign-in button; everything else gets the en/ar "account suspended" page.
	 */
	async function refuse(email: string, userId: string, state: AccountState, provider: string): Promise<Response> {
		logger.warn('[auth] Refused sign-in of a suspended or deleted account', { userId, state, provider });
		// A system account: audit event + needs-action item on the admin Errors page
		if (state === 'system') {
			flagSystemAccountAttempt(env as SystemAccountEnv, ctx, { userId, attempt: 'sign_in', detail: provider || undefined, request, requestId });
		}
		const clientIP = getClientIP(request);
		ctx.waitUntil(
			getAuditEmitter().emit(
				createLoginFailedEvent(email, `account_${state}`, {
					ipAddress: clientIP,
					userAgent: request.headers.get('User-Agent') ?? undefined,
					requestId,
				})
			)
		);
		trackEvent(env, {
			event: 'login_failed',
			userId,
			email,
			ipAddress: clientIP,
			userAgent: request.headers.get('User-Agent') ?? undefined,
			errorCode: `account_${state}`,
			success: false,
		});
		// A browser session left over (suspended outside the admin API) must not keep trying silent sign-on
		if (db) {
			try {
				await endBrowserSignIns(db, userId);
			} catch (error) {
				logger.error('[auth] Could not end the refused account\'s browser sign-ins', {
					userId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const url = new URL(request.url);
		const redirectUri = url.searchParams.get('redirect_uri');
		if (provider === 'session' && url.searchParams.get('prompt') === 'none' && redirectUri) {
			// The issuer validated this redirect_uri before running silent sign-on
			const location = new URL(redirectUri);
			location.searchParams.set('error', 'login_required');
			location.searchParams.set('error_description', 'The account cannot sign in');
			location.searchParams.set('state', url.searchParams.get('state') || '');
			return new Response(null, { status: 302, headers: { Location: location.toString(), 'Cache-Control': 'no-store' } });
		}
		return renderAccountSuspendedPage(getLocaleFromRequest(request), homeUrl || '/', theme);
	}

	return async (
		authCtx: OpenAuthContext,
		value: EnterpriseAuthResult,
		_tenant: TenantInfo | undefined
	): Promise<Response> => {
		// Enterprise issuer: email can be in properties (from password provider) or directly on value
		let email = String(value.properties?.email || value.email || '');
		// Passkey sign-in: the account is the credential's owner, never an email typed on the page
		if (value.provider === 'passkey') {
			const passkeyUserId = String(value.userID ?? '');
			const row = db && passkeyUserId
				? await db.prepare('SELECT id, email, metadata FROM users WHERE id = ?1 AND deleted_at IS NULL').bind(passkeyUserId).first<{ id: string; email: string; metadata: string | null }>()
				: null;
			if (isSystemUser({ id: passkeyUserId, metadata: row?.metadata })) return await refuse('', passkeyUserId, 'system', 'passkey');
			if (!row) return await refuse('', passkeyUserId, 'deleted', 'passkey');
			email = row.email;
		}
		logger.info('Authentication successful', { email, provider: value.provider });

		// DEBUG: Log the full value object and tenant
		logger.info('[DEBUG] onSuccess called', {
			valueKeys: Object.keys(value),
			value: JSON.stringify(value).slice(0, 500),
			tenant: _tenant?.id,
			hasAuthCtx: !!authCtx,
			hasSubjectMethod: typeof authCtx?.subject === 'function',
		});

		try {
			// Look up user via OpenAuth's UserService
			const tenantId = _tenant?.id || 'default';
			let existingUser = await staged(timer, 'onsuccess.user', () => userService.getUserByEmail(tenantId, email));

			// Silent sign-on carries the session account's id: a deleted account (hidden
			// from the email lookup) must be refused, not re-created as a new user (#662)
			const sessionUserId = value.provider === 'session' ? String(value.properties?.id ?? (value as { id?: unknown }).id ?? '') : '';
			if (!existingUser && sessionUserId && db) {
				const state = await staged(timer, 'onsuccess.state', () => readAccountState(db, sessionUserId));
				if (isRefusedAccountState(state)) return await refuse(email, sessionUserId, state, 'session');
			}

			if (!existingUser) {
				// User doesn't exist - this is a registration, create them
				logger.info('Creating new user during registration', { email, tenantId });
				existingUser = await staged(timer, 'onsuccess.create', () => userService.createUser(tenantId, { email }));
				logger.info('User created successfully', { userId: existingUser.id, email });
				// E2E run accounts (QA/stage only): the marker the run teardown requires
				const created = existingUser;
				await staged(timer, 'onsuccess.runmarker', () => markRunUser(env as unknown as RunUsersEnv, db, created));

				// Assign default "member" role to new users
				try {
					await rbacService.assignRoleToUser({
						userId: existingUser.id,
						roleId: 'role_member', // Seeded role ID from OpenAuth
						tenantId,
						assignedBy: 'user_system',
					});
					logger.info('Assigned default member role', {
						userId: existingUser.id,
						roleId: 'role_member',
					});
				} catch (roleError) {
					// Don't fail registration if role assignment fails
					logger.error('Failed to assign default role', {
						userId: existingUser.id,
						error: roleError instanceof Error ? roleError.message : String(roleError),
					});
				}
			} else {
				// An invited account (docs/USER_INVITES.md): this sign-in proved the address
				// (every way in is an emailed code or a password set with one), so it claims
				// the pre-provisioned account: same id, roles, plan and channels; now active
				// with the email verified. Never a second account for the same email.
				if (existingUser.status === 'invited' && db) {
					const invitedId = existingUser.id;
					const claimed = await staged(timer, 'onsuccess.invite', () => claimInvitedAccount(db, tenantId, invitedId));
					if (claimed) {
						logger.info('[auth] Invited account claimed at first sign-in', { userId: existingUser.id, provider: value.provider });
						ctx.waitUntil(
							getAuditEmitter().emit({
								timestamp: new Date().toISOString(),
								eventType: AuditEventType.USER_INVITE_ACCEPTED,
								severity: AuditEventSeverity.INFO,
								userId: existingUser.id,
								ipAddress: getClientIP(request),
								userAgent: request.headers.get('User-Agent') ?? null,
								requestId,
								success: true,
								errorMessage: null,
								metadata: { provider: value.provider },
							})
						);
					}
					// Re-read: a concurrent sign-in may have claimed it, or an admin revoked it
					existingUser = { ...existingUser, status: undefined };
				}
				// Suspended or deleted (D1): refused before anything is issued (#662)
				const known = existingUser;
				const state = await staged(timer, 'onsuccess.state', () => stateOf(known));
				if (isRefusedAccountState(state)) {
					return await refuse(email, existingUser.id, state, String(value.provider ?? ''));
				}
				// User exists - update last login timestamp. Informational only, so it
				// finishes after the redirect instead of delaying it (#804)
				ctx.waitUntil(
					userService.updateLastLogin(tenantId, known.id).catch((error: unknown) => {
						logger.error('[auth] Could not update last login', {
							userId: known.id,
							error: error instanceof Error ? error.message : String(error),
						});
					})
				);
			}

			// Get roles from RBAC
			const userId = existingUser.id;
			const rbacResult = await staged(timer, 'onsuccess.roles', () => rbacService.getUserRoles(userId, tenantId));
			const roles = rbacResult.map((r) => r.name);

			// Debug: Log the roles being returned
			logger.info('User roles from RBAC', {
				userId: existingUser.id,
				email,
				roles,
				rolesCount: roles.length,
			});

			const user = { id: existingUser.id, roles };
			// Staff passkey policy (AUTH-PASSKEYS): the deadline consumers enforce
			const deadline = db ? await staged(timer, 'onsuccess.passkey', () => passkeyDeadline(db, user.id, roles)) : undefined;

			// Emit login success audit event (use outer ctx for waitUntil)
			const clientIP = getClientIP(request);
			const loginEvent = createLoginSuccessEvent(email, user.id, {
				ipAddress: clientIP,
				userAgent: request.headers.get('User-Agent') ?? undefined,
				requestId,
			});
			ctx.waitUntil(getAuditEmitter().emit(loginEvent));

			// Track login success in analytics
			trackEvent(env, {
				event: 'login_success',
				userId: user.id,
				email,
				ipAddress: clientIP,
				userAgent: request.headers.get('User-Agent') ?? undefined,
				success: true,
			});

			// DEBUG: Log before calling subject
			// Note: userID is required by OpenAuth enterprise issuer for RBAC enrichment
			logger.info('[DEBUG] Calling authCtx.subject', {
				type: 'user',
				properties: { id: user.id, email, roles: user.roles },
			});

			const subjectResponse = await staged(timer, 'onsuccess.subject', () =>
				authCtx.subject('user', {
					id: user.id,
					email,
					roles: user.roles,
					...(deadline !== undefined ? { passkey_deadline: deadline } : {}),
				})
			);

			// DEBUG: Log the response from subject
			logger.info('[DEBUG] authCtx.subject returned', {
				responseType: typeof subjectResponse,
				isResponse: subjectResponse instanceof Response,
				status: subjectResponse instanceof Response ? subjectResponse.status : 'N/A',
				headers:
					subjectResponse instanceof Response
						? Object.fromEntries(subjectResponse.headers.entries())
						: 'N/A',
			});

			// DEBUG: If not a Response, log what it actually is and return error
			if (!(subjectResponse instanceof Response)) {
				const unknownResponse = subjectResponse as unknown;
				logger.error('[DEBUG] subjectResponse is NOT a Response!', {
					actualValue: JSON.stringify(unknownResponse).slice(0, 500),
					constructorName: (unknownResponse as { constructor?: { name?: string } })
						?.constructor?.name,
				});
				// Return a clear error so we can see what's happening
				return new Response(
					JSON.stringify({
						error: 'subject_not_response',
						debug: {
							type: typeof unknownResponse,
							value: unknownResponse,
						},
					}),
					{
						status: 500,
						headers: { 'Content-Type': 'application/json' },
					}
				);
			}

			// DEBUG: Check if it's a redirect or has unexpected content
			const isRedirect = subjectResponse.status >= 300 && subjectResponse.status < 400;
			if (!isRedirect) {
				const cloned = subjectResponse.clone();
				const body = await cloned.text();
				logger.error('[DEBUG] subjectResponse is NOT a redirect!', {
					status: subjectResponse.status,
					contentType: subjectResponse.headers.get('Content-Type'),
					body: body.slice(0, 1000),
				});
			}

			// After an interactive sign-in: offer to add a passkey (PK1) before going on to the app
			if (db && isRedirect) {
				const card = await staged(timer, 'onsuccess.card', () =>
					afterSignInCard({
						db,
						env: env as { PASSKEY_PROMPT?: string },
						provider: String(value.provider ?? ''),
						userId: user.id,
						email,
						roles: user.roles,
						deadline,
						locale: getLocaleFromRequest(request) === 'ar' ? 'ar' : 'en',
						theme,
						redirect: subjectResponse,
					})
				).catch((error: unknown) => {
					logger.error('[passkeys] Could not build the after-sign-in card', { error: error instanceof Error ? error.message : String(error) });
					return null;
				});
				if (card) return card;
			}

			return subjectResponse;
		} catch (error) {
			// Emit login failed audit event (use outer ctx for waitUntil)
			const clientIP = getClientIP(request);
			const failedEvent = createLoginFailedEvent(
				email,
				error instanceof Error ? error.message : String(error),
				{
					ipAddress: clientIP,
					userAgent: request.headers.get('User-Agent') ?? undefined,
					requestId,
				}
			);
			ctx.waitUntil(getAuditEmitter().emit(failedEvent));

			// Track login failed in analytics
			trackEvent(env, {
				event: 'login_failed',
				email,
				ipAddress: clientIP,
				userAgent: request.headers.get('User-Agent') ?? undefined,
				errorCode: error instanceof Error ? error.message : 'unknown',
				success: false,
			});

			throw error;
		}
	};
}

/**
 * Environment for sendCode handler
 */
export interface SendCodeEnv {
	AUTH_STORAGE: KVNamespace;
	/** password_codes: attempt counter and expiry of each sent code (AU-2) */
	AUTH_DB: D1Database;
	/** Verification emails per client IP (AU-1); absent in local dev and unit tests */
	SEND_CODE_LIMITER?: RateLimit;
	RESEND_API_KEY?: string | SecretBinding;
	ENVIRONMENT?: string;
	OPENAUTH_ISSUER?: string;
	/** QA/stage only (never bound in prod): enables the E2E code sink, see utils/e2e-sink.ts */
	E2E_CODE_SINK_SECRET?: string | SecretBinding;
	AUTH_ANALYTICS?: AnalyticsEngineDataset;
}

// SecretBinding type from Cloudflare Workers (simplified for compatibility)
type SecretBinding = string | { get: () => Promise<string> };

/**
 * Context for sendCode handler
 */
export interface SendCodeContext {
	request: Request;
	env: SendCodeEnv;
	ctx: ExecutionContext;
	requestId: string;
	url: URL;
	/** The sign-in's theme `email` section (colours, header image) */
	emailTheme?: import('../email-templates').EmailTheme;
	/** This request's timings (Server-Timing, auth.timing log) */
	timer?: RequestTimer;
}

/**
 * Create the sendCode handler for password provider
 *
 * This handler sends verification codes to users and performs rate limiting.
 *
 * OpenAuth's password provider only calls sendCode from two flows:
 * - registration (`/password/register`): the account does not exist yet, so no
 *   existence check is done.
 * - password change / "Forgot password?" (`/password/change`): if the email has
 *   no account, we return WITHOUT sending anything. Throwing here would escape
 *   the provider (the issuer turns it into a server_error and the user leaves the
 *   auth page) and reveal which emails are registered. Returning normally lets the
 *   provider show the "enter code" screen exactly as it does for a real account.
 *
 * Delivery problems (rate limit, missing RESEND_API_KEY, invalid address, Resend
 * rejecting or failing the send) return `{ type: "code_send_failed" }` instead of
 * throwing, so the user stays on the same form, sees a localized error and can
 * fix the address. The unknown-email no-op above happens before any of these, so
 * forgot-password still never reveals whether an account exists.
 *
 * @param userService - Service for looking up users
 * @param handlerCtx - Context from the main request handler
 * @param passwordStorage - OpenAuth storage holding password credentials at
 *   ["email", email, "password"]. Lets accounts with a password but no
 *   UserService record still receive a reset code.
 * @returns The sendCode callback function
 */
export function createSendCodeHandler(
	userService: UserServiceLike,
	handlerCtx: SendCodeContext,
	passwordStorage?: StorageAdapter
) {
	const { request, env, ctx, requestId, url, timer } = handlerCtx;

	// Import dependencies at handler creation time
	const withinRateLimitPromise = import('../rate-limit').then((m) => m.withinRateLimit);
	const sendEmailPromise = import('../email').then((m) => m.default);
	const emailTemplatesPromise = import('../email-templates');
	const requireSecretPromise = import('../utils/secrets').then((m) => m.requireSecret);
	const rateLimitEventPromise = import('../audit-events').then(
		(m) => m.createRateLimitExceededEvent
	);

	/** The live D1 account of this address (idx_users_email_lower), if any. */
	async function d1Account(email: string): Promise<{ id: string; metadata: string | null } | null> {
		return env.AUTH_DB.prepare(
			'SELECT id, metadata FROM users WHERE lower(email) = lower(?) AND deleted_at IS NULL LIMIT 1'
		)
			.bind(email)
			.first<{ id: string; metadata: string | null }>();
	}

	async function hasAccount(email: string, d1User: { id: string } | null): Promise<boolean> {
		// D1 first: it is consistent. Both KV lookups below can still answer "missing"
		// for up to a minute after sign-up, because sign-up read those keys (to check
		// the email was free) before writing them, and that miss is cached at the edge.
		// A forgot-password right after signing up would then silently send nothing.
		if (d1User) return true;
		if (await userService.getUserByEmail('default', email)) return true;
		if (!passwordStorage) return false;
		const passwordRecord = await Storage.get(passwordStorage, ['email', email, 'password']);
		return passwordRecord !== undefined && passwordRecord !== null;
	}

	return async (email: string, code: string): Promise<void | PasswordSendCodeError> => {
		// Resolve all imports
		const [
			withinRateLimit,
			SendEmail,
			emailTemplates,
			requireSecret,
			createRateLimitExceededEvent,
		] = await Promise.all([
			withinRateLimitPromise,
			sendEmailPromise,
			emailTemplatesPromise,
			requireSecretPromise,
			rateLimitEventPromise,
		]);

		logger.info('Sending login code', { email, codeLength: code.length });

		// Rate limiting (AU-1): Workers Rate Limiting, SEND_CODE_LIMITER (limit per env
		// in wrangler config). QA/stage E2E addresses (sink active, never in prod) are
		// limited per address instead of per IP: a CI runner signs up dozens of users
		// from one IP, and each test uses its own address, so the per-address limit
		// still applies.
		const clientIP = getClientIP(request);
		const sinkThisCode = await shouldSinkCode(env, email);
		const rateLimitKey = sinkThisCode ? `e2e:${email.toLowerCase()}` : `ip:${clientIP}`;
		const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

		if (!(await withinRateLimit(env.SEND_CODE_LIMITER, rateLimitKey))) {
			const retryAfter = 60;
			logger.warn('Rate limit exceeded for login attempt', {
				clientIP,
				email,
				retryAfter,
			});

			// Emit rate limit exceeded audit event
			const auditEvent = createRateLimitExceededEvent('/sendCode', 0, 60, retryAfter, {
				ipAddress: clientIP,
				userAgent: request.headers.get('User-Agent') ?? undefined,
				requestId,
			});
			ctx.waitUntil(getAuditEmitter().emit(auditEvent));

			// Track rate limit in analytics
			trackEvent(env, {
				event: 'rate_limit_hit',
				email,
				ipAddress: clientIP,
				userAgent: request.headers.get('User-Agent') ?? undefined,
			});

			return CODE_SEND_FAILED;
		}

		// Registration: the account doesn't exist yet, so skip the existence check.
		// Otherwise (password change / forgot password) only send to real accounts,
		// and treat unknown emails as a silent no-op (see JSDoc above).
		const isRegistration = url.pathname.includes('/register');
		const d1User = await d1Account(email);
		// A system account never gets a code: no sign-in, registration or password reset
		// with it. Silent like an unknown email (no code is recorded, so none can be
		// checked); audited and flagged on the admin Errors page.
		if (d1User && isSystemUser(d1User)) {
			flagSystemAccountAttempt(env as unknown as SystemAccountEnv, ctx, {
				userId: d1User.id,
				attempt: 'sign_in',
				detail: isRegistration ? 'register' : 'email_code',
				request,
				requestId,
			});
			return;
		}
		if (!isRegistration) {
			const accountExists = await hasAccount(email, d1User);
			if (!accountExists) {
				logger.warn('Password reset code requested for unknown email; not sending', {
					email,
					pathname: url.pathname,
				});
				return;
			}
		}

		// The code's attempt counter and expiry (AU-2); the provider's checkCode
		// hook rejects any code without a live row here
		await recordCode(env.AUTH_DB, email, code);

		// Track login attempt in analytics
		trackEvent(env, {
			event: 'login_attempt',
			email,
			ipAddress: clientIP,
			userAgent: request.headers.get('User-Agent') ?? undefined,
		});

		try {
			const apiKey = await requireSecret(
				env.RESEND_API_KEY,
				'RESEND_API_KEY',
				env as unknown as Record<string, unknown>
			);

			logger.debug('Using RESEND_API_KEY from environment');

			// QA/stage E2E addresses: store the code for the test instead of emailing it.
			// Runs after RESEND_API_KEY resolves, so a missing secret still fails here.
			if (sinkThisCode) {
				await storeSinkCode(env, email, code);
				logger.info('Verification code stored in E2E sink', { email });
				return;
			}

			// Generate email content from professional template
			// One language: the page the user asked from (?lang=ar, else English;
			// the form posts to its own URL, so the query is still here). Never Accept-Language.
			const emailData = {
				code,
				email,
				expiryMinutes: CODE_TTL_SECONDS / 60, // enforced by recordCode/checkCode
				locale: url.searchParams.get('lang') === 'ar' ? ('ar' as const) : ('en' as const),
				purpose: emailTemplates.codePurposeOf(url.pathname),
			};
			const { html: htmlContent, text: textContent, subject } = emailTemplates.renderVerificationCodeEmail(emailData, handlerCtx.emailTheme);

			const emailResult = await staged(timer, 'sendcode.email', () => SendEmail({
				apiKey,
				from: 'Al Ummah Now <login@alummahnow.net>',
				to: email,
				subject,
				html: htmlContent,
				text: textContent,
			}));
			logger.info('Login code sent successfully', { email, emailId: emailResult.emailId });

			// For E2E tests, store the email ID in KV so tests can retrieve it
			if (isLocalhost && emailResult.emailId) {
				await env.AUTH_STORAGE.put(
					sinkKey(email),
					JSON.stringify({
						emailId: emailResult.emailId,
						code,
						timestamp: Date.now(),
					}),
					{ expirationTtl: 300 }
				); // 5 minute TTL
				logger.debug('Stored email ID for E2E test', {
					email,
					emailId: emailResult.emailId,
				});
			}
		} catch (error) {
			logger.error('Failed to send login code', {
				email,
				error: error instanceof Error ? error.message : String(error),
			});
			return CODE_SEND_FAILED;
		}
	};
}
