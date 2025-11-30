/**
 * @fileoverview Custom error types for token operations
 *
 * Provides structured error handling for JWT and refresh token operations
 */

/**
 * Error codes for token-related errors
 */
export enum TokenErrorCode {
	// Token validation errors
	INVALID_TOKEN = 'INVALID_TOKEN',
	TOKEN_EXPIRED = 'TOKEN_EXPIRED',
	TOKEN_REVOKED = 'TOKEN_REVOKED',
	TOKEN_NOT_FOUND = 'TOKEN_NOT_FOUND',

	// Token rotation errors
	TOKEN_REUSE_DETECTED = 'TOKEN_REUSE_DETECTED',
	CONCURRENT_REFRESH = 'CONCURRENT_REFRESH',
	MAX_ROTATION_EXCEEDED = 'MAX_ROTATION_EXCEEDED',

	// Token generation errors
	KEY_GENERATION_FAILED = 'KEY_GENERATION_FAILED',
	TOKEN_GENERATION_FAILED = 'TOKEN_GENERATION_FAILED',

	// Verification errors
	SIGNATURE_INVALID = 'SIGNATURE_INVALID',
	CLAIMS_INVALID = 'CLAIMS_INVALID',
	CLIENT_ID_MISMATCH = 'CLIENT_ID_MISMATCH',

	// System errors
	DATABASE_ERROR = 'DATABASE_ERROR',
	ENCRYPTION_ERROR = 'ENCRYPTION_ERROR',
}

/**
 * HTTP status codes for token errors
 */
export const TokenErrorStatus: Record<TokenErrorCode, number> = {
	[TokenErrorCode.INVALID_TOKEN]: 401,
	[TokenErrorCode.TOKEN_EXPIRED]: 401,
	[TokenErrorCode.TOKEN_REVOKED]: 401,
	[TokenErrorCode.TOKEN_NOT_FOUND]: 401,
	[TokenErrorCode.TOKEN_REUSE_DETECTED]: 401,
	[TokenErrorCode.CONCURRENT_REFRESH]: 409, // Conflict - token was already rotated
	[TokenErrorCode.MAX_ROTATION_EXCEEDED]: 403,
	[TokenErrorCode.KEY_GENERATION_FAILED]: 500,
	[TokenErrorCode.TOKEN_GENERATION_FAILED]: 500,
	[TokenErrorCode.SIGNATURE_INVALID]: 401,
	[TokenErrorCode.CLAIMS_INVALID]: 401,
	[TokenErrorCode.CLIENT_ID_MISMATCH]: 401,
	[TokenErrorCode.DATABASE_ERROR]: 500,
	[TokenErrorCode.ENCRYPTION_ERROR]: 500,
};

/**
 * Custom error class for token-related errors
 */
export class TokenError extends Error {
	public readonly code: TokenErrorCode;
	public readonly statusCode: number;
	public readonly details?: Record<string, unknown>;
	public readonly timestamp: number;

	constructor(code: TokenErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = 'TokenError';
		this.code = code;
		this.statusCode = TokenErrorStatus[code];
		this.details = details;
		this.timestamp = Date.now();

		// Maintains proper stack trace for where our error was thrown (only available on V8)
		const ErrorWithCaptureStackTrace = Error as typeof Error & {
			captureStackTrace?: (target: object, constructor: unknown) => void;
		};
		if (typeof ErrorWithCaptureStackTrace.captureStackTrace === 'function') {
			ErrorWithCaptureStackTrace.captureStackTrace(this, TokenError);
		}
	}

	/**
	 * Converts the error to a JSON-serializable object for API responses
	 */
	toJSON(): {
		error: string;
		error_description: string;
		code: string;
		timestamp: number;
		details?: Record<string, unknown>;
	} {
		return {
			error: this.code.toLowerCase(),
			error_description: this.message,
			code: this.code,
			timestamp: this.timestamp,
			...(this.details && { details: this.details }),
		};
	}

	/**
	 * Helper to create an invalid token error
	 */
	static invalidToken(message: string = 'Invalid token', details?: Record<string, unknown>): TokenError {
		return new TokenError(TokenErrorCode.INVALID_TOKEN, message, details);
	}

	/**
	 * Helper to create a token expired error
	 */
	static tokenExpired(message: string = 'Token has expired', details?: Record<string, unknown>): TokenError {
		return new TokenError(TokenErrorCode.TOKEN_EXPIRED, message, details);
	}

	/**
	 * Helper to create a token revoked error
	 */
	static tokenRevoked(message: string = 'Token has been revoked', details?: Record<string, unknown>): TokenError {
		return new TokenError(TokenErrorCode.TOKEN_REVOKED, message, details);
	}

	/**
	 * Helper to create a token reuse detected error
	 */
	static tokenReuseDetected(
		message: string = 'Token reuse detected - all tokens in chain have been revoked',
		details?: Record<string, unknown>
	): TokenError {
		return new TokenError(TokenErrorCode.TOKEN_REUSE_DETECTED, message, details);
	}

	/**
	 * Helper to create a concurrent refresh error
	 */
	static concurrentRefresh(
		message: string = 'Concurrent refresh detected - please retry',
		details?: Record<string, unknown>
	): TokenError {
		return new TokenError(TokenErrorCode.CONCURRENT_REFRESH, message, details);
	}

	/**
	 * Helper to create a max rotation exceeded error
	 */
	static maxRotationExceeded(
		message: string = 'Maximum rotation count exceeded',
		details?: Record<string, unknown>
	): TokenError {
		return new TokenError(TokenErrorCode.MAX_ROTATION_EXCEEDED, message, details);
	}

	/**
	 * Helper to create a client ID mismatch error
	 */
	static clientIdMismatch(message: string = 'Client ID mismatch', details?: Record<string, unknown>): TokenError {
		return new TokenError(TokenErrorCode.CLIENT_ID_MISMATCH, message, details);
	}

	/**
	 * Helper to create a signature invalid error
	 */
	static signatureInvalid(message: string = 'Token signature is invalid', details?: Record<string, unknown>): TokenError {
		return new TokenError(TokenErrorCode.SIGNATURE_INVALID, message, details);
	}

	/**
	 * Helper to create a database error
	 */
	static databaseError(message: string = 'Database operation failed', details?: Record<string, unknown>): TokenError {
		return new TokenError(TokenErrorCode.DATABASE_ERROR, message, details);
	}
}
