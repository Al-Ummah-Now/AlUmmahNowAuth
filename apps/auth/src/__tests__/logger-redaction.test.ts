/**
 * Sign-in logs carry no email addresses, codes, cookies or redirect Locations (#313).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger, maskEmails, queryKeys, redactLogValue } from '../logger';

afterEach(() => vi.restoreAllMocks());

function captured(fn: () => void): string {
	const lines: string[] = [];
	for (const m of ['debug', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((line: string) => void lines.push(line));
	fn();
	return lines.join('\n');
}

describe('logger redaction', () => {
	it('keeps only the domain of an email, in the message and in any context value', () => {
		const out = captured(() =>
			logger.info('Code sent to someone.name+tag@example.com', { email: 'a.b@mail.example.org', nested: { list: ['x@y.co'] }, note: 'for a@b.io' })
		);
		expect(out).not.toMatch(/someone|a\.b@|x@y|a@b/);
		expect(out).toContain('***@example.com');
		expect(out).toContain('***@mail.example.org');
		expect(out).toContain('***@y.co');
		expect(out).toContain('***@b.io');
	});

	it('redacts Location, Set-Cookie, headers, codes and tokens', () => {
		const out = captured(() =>
			logger.warn('issuer', {
				location: 'https://app.example/callback?code=SECRETCODE&state=s',
				headers: { 'set-cookie': '__session=SESSIONJWE' },
				'Set-Cookie': 'x=SESSION2',
				code: '123456',
				refresh_token: 'RTOKEN',
				status: 302,
			})
		);
		for (const secret of ['SECRETCODE', 'SESSIONJWE', 'SESSION2', '123456', 'RTOKEN']) expect(out).not.toContain(secret);
		expect(out).toContain('"status":302');
	});

	it('logs query parameter names for each request, never their values', () => {
		const out = captured(() =>
			logger.logRequest(new Request('https://auth.example/authorize?client_id=c&login_hint=user%40example.com&code=abc'))
		);
		expect(out).toContain('"queryKeys":"client_id,login_hint,code"');
		expect(out).not.toContain('user');
		expect(out).not.toContain('abc');
	});

	it('helpers', () => {
		expect(maskEmails('no email here')).toBe('no email here');
		expect(queryKeys('')).toBe('');
		expect(redactLogValue({ code: '' })).toEqual({ code: '' });
		expect(redactLogValue(new Error('failed for z@q.dev'))).toBe('failed for ***@q.dev');
	});
});
