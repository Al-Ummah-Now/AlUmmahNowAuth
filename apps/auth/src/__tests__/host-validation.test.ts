import { describe, it, expect } from 'vitest';
import {
	validateHost,
	normalizeHost,
} from '../utils/host-validation';

describe('Host Validation', () => {
	describe('normalizeHost', () => {
		it('should lowercase the host', () => {
			expect(normalizeHost('Auth.AlUmmahNow.Net')).toBe('auth.alummahnow.net');
		});

		it('should strip port from host', () => {
			expect(normalizeHost('localhost:8787')).toBe('localhost');
			expect(normalizeHost('auth.alummahnow.net:443')).toBe('auth.alummahnow.net');
		});

		it('should handle IPv6 with port', () => {
			expect(normalizeHost('[::1]:8787')).toBe('[::1]');
		});

		it('should handle host without port', () => {
			expect(normalizeHost('example.com')).toBe('example.com');
		});

		it('should trim whitespace', () => {
			expect(normalizeHost('  example.com  ')).toBe('example.com');
		});
	});

	describe('validateHost', () => {
		describe('valid hosts', () => {
			it('should accept alummahnow.net subdomains', () => {
				const result = validateHost('auth.alummahnow.net', false);
				expect(result.isValid).toBe(true);
				expect(result.isKnownPattern).toBe(true);
				expect(result.normalizedHost).toBe('auth.alummahnow.net');
			});

			it('should accept auth.qa.alummahnow.net', () => {
				const result = validateHost('auth.qa.alummahnow.net', false);
				expect(result.isValid).toBe(true);
				expect(result.isKnownPattern).toBe(true);
			});

			it('should accept workers.dev domains', () => {
				const result = validateHost('my-worker.workers.dev', false);
				expect(result.isValid).toBe(true);
				expect(result.isKnownPattern).toBe(true);
			});

			it('should accept pages.dev domains', () => {
				const result = validateHost('my-app.pages.dev', false);
				expect(result.isValid).toBe(true);
				expect(result.isKnownPattern).toBe(true);
			});

			it('should accept localhost in development', () => {
				const result = validateHost('localhost', true);
				expect(result.isValid).toBe(true);
				expect(result.isKnownPattern).toBe(true);
			});

			it('should accept localhost:8787 in development', () => {
				const result = validateHost('localhost:8787', true);
				expect(result.isValid).toBe(true);
				expect(result.isKnownPattern).toBe(true);
				expect(result.normalizedHost).toBe('localhost');
			});

			it('should accept 127.0.0.1 in development', () => {
				const result = validateHost('127.0.0.1', true);
				expect(result.isValid).toBe(true);
				expect(result.isKnownPattern).toBe(true);
			});

			it('should accept 127.0.0.1:8787 in development', () => {
				const result = validateHost('127.0.0.1:8787', true);
				expect(result.isValid).toBe(true);
				expect(result.isKnownPattern).toBe(true);
				expect(result.normalizedHost).toBe('127.0.0.1');
			});

			it('should accept valid domain with uppercase', () => {
				const result = validateHost('Auth.AlUmmahNow.Net', false);
				expect(result.isValid).toBe(true);
				expect(result.normalizedHost).toBe('auth.alummahnow.net');
			});
		});

		describe('unknown but valid hosts', () => {
			it('should accept unknown domains but mark as not known pattern', () => {
				const result = validateHost('unknown.example.com', false);
				expect(result.isValid).toBe(true);
				expect(result.isKnownPattern).toBe(false);
			});

			it('should accept any valid domain format', () => {
				const result = validateHost('client.customdomain.org', false);
				expect(result.isValid).toBe(true);
				expect(result.isKnownPattern).toBe(false);
			});
		});

		describe('invalid hosts', () => {
			it('should reject empty host', () => {
				const result = validateHost('', false);
				expect(result.isValid).toBe(false);
				expect(result.reason).toContain('Empty');
			});

			it('should reject whitespace-only host', () => {
				const result = validateHost('   ', false);
				expect(result.isValid).toBe(false);
				expect(result.reason).toContain('Empty');
			});

			it('should reject excessively long host', () => {
				const longHost = 'a'.repeat(300) + '.com';
				const result = validateHost(longHost, false);
				expect(result.isValid).toBe(false);
				expect(result.reason).toContain('maximum length');
			});

			it('should reject host with invalid characters', () => {
				const result = validateHost('example<script>.com', false);
				expect(result.isValid).toBe(false);
				expect(result.reason).toContain('Invalid host format');
			});

			it('should reject single-label domain', () => {
				// Single label domains are generally not valid for web
				// except for development (localhost)
				const result = validateHost('intranet', false);
				expect(result.isValid).toBe(false);
			});
		});

		describe('development mode', () => {
			it('should mark localhost as not known pattern in production', () => {
				// localhost is valid format but not a known production pattern
				const result = validateHost('localhost', false);
				expect(result.isValid).toBe(true);
				expect(result.isKnownPattern).toBe(false);
			});

			it('should not accept 127.0.0.1 in production', () => {
				const result = validateHost('127.0.0.1', false);
				// IP addresses are valid format but not known pattern in prod
				expect(result.isValid).toBe(true);
				expect(result.isKnownPattern).toBe(false);
			});

			it('should accept IP addresses in development', () => {
				const result = validateHost('192.168.1.100', true);
				expect(result.isValid).toBe(true);
				expect(result.isKnownPattern).toBe(true);
			});
		});

		describe('edge cases', () => {
			it('should handle IPv6 localhost in development', () => {
				const result = validateHost('[::1]', true);
				expect(result.isValid).toBe(true);
			});

			it('should handle domain with hyphen', () => {
				const result = validateHost('my-service.alummahnow.net', false);
				expect(result.isValid).toBe(true);
				expect(result.isKnownPattern).toBe(true);
			});

			it('should handle deep subdomain', () => {
				const result = validateHost('api.v2.staging.alummahnow.net', false);
				expect(result.isValid).toBe(true);
				expect(result.isKnownPattern).toBe(true);
			});

			it('should reject domain starting with hyphen', () => {
				const result = validateHost('-invalid.com', false);
				expect(result.isValid).toBe(false);
			});

			it('should reject domain ending with hyphen', () => {
				const result = validateHost('invalid-.com', false);
				expect(result.isValid).toBe(false);
			});
		});
	});
});
