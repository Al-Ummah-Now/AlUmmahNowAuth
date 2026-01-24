/**
 * @fileoverview Authentication handlers for OpenAuth callbacks
 *
 * Contains the onSuccess callback and related authentication logic
 * that is called after successful password verification.
 */

import { logger } from '../logger';
import { getClientIP } from '../rate-limit';
import { getAuditEmitter } from '../audit-emitter';
import { createLoginSuccessEvent, createLoginFailedEvent, createAccountCreatedEvent, createRoleManagementEvent, AuditEventType } from '../audit-events';
import { trackEvent } from '../utils/analytics';
import type { RBACServiceImpl } from '@al-ummah-now/openauth/rbac/index';

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

				// Emit account created audit event
				const registrationIP = getClientIP(request);
				const accountCreatedEvent = createAccountCreatedEvent(existingUser.id, email, 'user', {
					ipAddress: registrationIP,
					userAgent: request.headers.get('User-Agent') ?? undefined,
					requestId,
				});
				ctx.waitUntil(getAuditEmitter().emit(accountCreatedEvent));

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

					// Emit role assignment audit event
					const roleEvent = createRoleManagementEvent(
						AuditEventType.ROLE_ASSIGNED,
						'role_member',
						'member',
						'user_system',
						{
							userId: existingUser.id,
							userEmail: email,
							ipAddress: registrationIP,
							userAgent: request.headers.get('User-Agent') ?? undefined,
							requestId,
						}
					);
					ctx.waitUntil(getAuditEmitter().emit(roleEvent));
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
	RESEND_API_KEY?: string | SecretBinding;
	ENVIRONMENT?: string;
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
}

/**
 * Create the sendCode handler for password provider
 *
 * This handler sends verification codes to users and performs rate limiting.
 *
 * @param userService - Service for looking up users
 * @param handlerCtx - Context from the main request handler
 * @returns The sendCode callback function
 */
export function createSendCodeHandler(
	userService: UserServiceLike,
	handlerCtx: SendCodeContext
) {
	const { request, env, ctx, requestId, url } = handlerCtx;

	// Import dependencies at handler creation time
	const checkRateLimitPromise = import('../rate-limit').then((m) => m.checkRateLimit);
	const getEndpointRateLimitPromise = import('../services/rate-limit-config').then(
		(m) => m.getEndpointRateLimit
	);
	const sendEmailPromise = import('../email').then((m) => m.default);
	const emailTemplatesPromise = import('../email-templates');
	const requireSecretPromise = import('../utils/secrets').then((m) => m.requireSecret);
	const rateLimitEventPromise = import('../audit-events').then(
		(m) => m.createRateLimitExceededEvent
	);

	return async (email: string, code: string): Promise<void> => {
		// Resolve all imports
		const [
			checkRateLimit,
			getEndpointRateLimit,
			SendEmail,
			emailTemplates,
			requireSecret,
			createRateLimitExceededEvent,
		] = await Promise.all([
			checkRateLimitPromise,
			getEndpointRateLimitPromise,
			sendEmailPromise,
			emailTemplatesPromise,
			requireSecretPromise,
			rateLimitEventPromise,
		]);

		logger.info('Sending login code', { email, codeLength: code.length });

		// Rate limiting: configurable via KV, with environment-specific defaults
		const clientIP = getClientIP(request);
		const rateLimitKey = `login:${clientIP}`;
		const rateLimitConfig = await getEndpointRateLimit(
			env.AUTH_STORAGE,
			'login',
			env.ENVIRONMENT
		);

		// Allow higher limits for localhost development
		const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
		const limit = isLocalhost ? 100 : rateLimitConfig.limit;

		const rateLimit = await checkRateLimit(
			env.AUTH_STORAGE,
			rateLimitKey,
			limit,
			rateLimitConfig.windowSeconds
		);

		if (!rateLimit.allowed) {
			const retryAfter = rateLimit.resetAt - Math.floor(Date.now() / 1000);
			logger.warn('Rate limit exceeded for login attempt', {
				clientIP,
				email,
				retryAfter,
			});

			// Emit rate limit exceeded audit event
			const auditEvent = createRateLimitExceededEvent('/sendCode', 5, 300, retryAfter, {
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

			throw new Error(
				`Too many login attempts. Please try again in ${Math.ceil(retryAfter / 60)} minutes.`
			);
		}

		logger.debug('Rate limit check passed', {
			clientIP,
			email,
			remaining: rateLimit.remaining,
		});

		// Check if user exists BEFORE sending code (sign-in only, not registration)
		// Skip this check for registration flow - user won't exist yet
		const isRegistration = url.pathname.includes('/register');
		if (!isRegistration) {
			const existingUser = await userService.getUserByEmail('default', email);
			if (!existingUser) {
				logger.warn('Login attempted for non-existent user', { email });
				// Use generic error to prevent user enumeration
				throw new Error('Incorrect email or password');
			}
		}

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

			// Generate email content from professional template
			const emailData = {
				code,
				email,
				expiryMinutes: 1440, // 24 hours (matches OpenAuth's provider session TTL)
			};
			const htmlContent = emailTemplates.getVerificationCodeTemplate(emailData);
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
				const testKey = `test:email:${email}`;
				await env.AUTH_STORAGE.put(
					testKey,
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
			throw error;
		}
	};
}
