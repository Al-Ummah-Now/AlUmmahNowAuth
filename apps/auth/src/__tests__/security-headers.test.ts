import { describe, expect, it } from 'vitest';
import { addSecurityHeaders } from '../utils/security-headers';

describe('Auth content security policy', () => {
	it('allows CDN fonts and Cloudflare analytics while preserving Turnstile and frame protection', () => {
		const response = addSecurityHeaders(new Response(''));
		const policy = response.headers.get('Content-Security-Policy') ?? '';
		const directives = new Map(policy.split(';').map((directive) => {
			const [name, ...sources] = directive.trim().split(/\s+/);
			return [name, sources] as const;
		}));

		expect(directives.get('font-src')).toContain('https://cdn.alummahnow.net');
		expect(directives.get('script-src')).toContain('https://static.cloudflareinsights.com');
		expect(directives.get('connect-src')).toContain('https://cloudflareinsights.com');
		expect(directives.get('script-src')).toContain('https://challenges.cloudflare.com');
		expect(directives.get('frame-src')).toEqual(['https://challenges.cloudflare.com']);
		expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
	});
});
