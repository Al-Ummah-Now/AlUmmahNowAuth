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
import { shouldSinkCode, sinkKey, storeSinkCode } from '../utils/e2e-sink';
import { CODE_TTL_SECONDS, recordCode } from '../security/password-attempts';
import type { RBACServiceImpl } from '@al-ummah-now/openauth/rbac/index';
import { Storage, type StorageAdapter } from '@al-ummah-now/openauth/storage/storage';
import type { PasswordSendCodeError } from '@al-ummah-now/openauth/provider/password';

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
	env: {
		AUTH_ANALYTICS?: AnalyticsEngineDataset;
	};
	ctx: ExecutionContext;
	requestId: string;
}

/**
 * User service interface for looking up users
 */
export interface UserServiceLike {
	getUserByEmail(
		tenantId: string,
		email: string
	): Promise<{ id: string; email: string } | null>;
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
		properties: { id: string; email: string; roles: string[] }
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
	const { request, env, ctx, requestId } = handlerCtx;

	return async (
		authCtx: OpenAuthContext,
		value: EnterpriseAuthResult,
		_tenant: TenantInfo | undefined
	): Promise<Response> => {
		// Enterprise issuer: email can be in properties (from password provider) or directly on value
		const email = String(value.properties?.email || value.email || '');
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
			let existingUser = await userService.getUserByEmail(tenantId, email);

			if (!existingUser) {
				// User doesn't exist - this is a registration, create them
				logger.info('Creating new user during registration', { email, tenantId });
				existingUser = await userService.createUser(tenantId, { email });
				logger.info('User created successfully', { userId: existingUser.id, email });

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
				// User exists - update last login timestamp
				await userService.updateLastLogin(tenantId, existingUser.id);
			}

			// Get roles from RBAC
			const rbacResult = await rbacService.getUserRoles(existingUser.id, tenantId);
			const roles = rbacResult.map((r) => r.name);

			// Debug: Log the roles being returned
			logger.info('User roles from RBAC', {
				userId: existingUser.id,
				email,
				roles,
				rolesCount: roles.length,
			});

			const user = { id: existingUser.id, roles };

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

			const subjectResponse = await authCtx.subject('user', {
				id: user.id,
				email,
				roles: user.roles,
			});

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
	const { request, env, ctx, requestId, url } = handlerCtx;

	// Import dependencies at handler creation time
	const withinRateLimitPromise = import('../rate-limit').then((m) => m.withinRateLimit);
	const sendEmailPromise = import('../email').then((m) => m.default);
	const emailTemplatesPromise = import('../email-templates');
	const requireSecretPromise = import('../utils/secrets').then((m) => m.requireSecret);
	const rateLimitEventPromise = import('../audit-events').then(
		(m) => m.createRateLimitExceededEvent
	);

	async function hasAccount(email: string): Promise<boolean> {
		// D1 first: it is consistent. Both KV lookups below can still answer "missing"
		// for up to a minute after sign-up, because sign-up read those keys (to check
		// the email was free) before writing them, and that miss is cached at the edge.
		// A forgot-password right after signing up would then silently send nothing.
		const d1User = await env.AUTH_DB.prepare(
			'SELECT 1 FROM users WHERE lower(email) = lower(?) AND deleted_at IS NULL LIMIT 1'
		)
			.bind(email)
			.first();
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
		if (!isRegistration) {
			const accountExists = await hasAccount(email);
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
			const emailData = {
				code,
				email,
				expiryMinutes: CODE_TTL_SECONDS / 60, // enforced by recordCode/checkCode
			};
			const htmlContent = emailTemplates.getVerificationCodeTemplate(emailData, handlerCtx.emailTheme);
			const textContent = emailTemplates.getVerificationCodePlainText(emailData);
			const subject = emailTemplates.getVerificationCodeSubject();

			const emailResult = await SendEmail({
				apiKey,
				from: 'Al Ummah Now <login@alummahnow.net>',
				to: email,
				subject,
				html: htmlContent,
				text: textContent,
			});
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
