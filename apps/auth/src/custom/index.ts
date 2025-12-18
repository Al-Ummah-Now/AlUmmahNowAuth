/**
 * Custom Directory
 *
 * This directory contains custom code and extensions for the OpenAuth implementation.
 * Code placed here is intended to be preserved during OpenAuth package updates.
 *
 * Purpose:
 * - Custom authentication flows
 * - Extended user management features
 * - Integration-specific implementations
 * - Business logic that extends OpenAuth functionality
 *
 * Note: This code lives alongside OpenAuth but is not part of the core package.
 */

// User helpers
export { getOrCreateUser, checkPasswordResetRequired, clearPasswordResetRequired } from './user-helpers';

// Token revocation
export { revokeSessionTokens, revokeUserTokens } from './token-revocation';

// Admin context middleware for OpenAuth routes
export { adminContextMiddleware, methodCompatMiddleware } from './admin-context-middleware';
