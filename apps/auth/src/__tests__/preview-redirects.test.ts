import { describe, expect, it, vi } from 'vitest';
import { isPreviewRedirect, withPreviewRedirects } from '../utils/preview-redirects';
import qaConfig from '../../wrangler.qa.json';
import prodConfig from '../../wrangler.json';

const QA = { ENVIRONMENT: 'qa', PREVIEW_WEB_CLIENT_ID: 'web-qa', PREVIEW_WORKERS_SUBDOMAIN: 'acct' };
const GOOD = 'https://al-ummah-web-pr-498.acct.workers.dev/api/callback';

describe('isPreviewRedirect', () => {
	it.each([GOOD, `${GOOD}?locale=ar`, 'https://al-ummah-web-pr-1.acct.workers.dev/api/callback/multi-account'])('allows %s', (uri) => {
		expect(isPreviewRedirect(QA, 'web-qa', uri)).toBe(true);
	});

	it.each([
		'https://al-ummah-web-pr-x.acct.workers.dev/api/callback',
		'https://al-ummah-web-pr-498.other.workers.dev/api/callback',
		'https://evil.example/al-ummah-web-pr-498.acct.workers.dev/api/callback',
		'https://al-ummah-web-pr-498.acct.workers.dev.evil.example/api/callback',
		'http://al-ummah-web-pr-498.acct.workers.dev/api/callback',
		'https://al-ummah-web-pr-498.acct.workers.dev/other',
		`${GOOD}?locale=ar&next=https://evil.example`,
	])('refuses %s', (uri) => {
		expect(isPreviewRedirect(QA, 'web-qa', uri)).toBe(false);
	});

	it('refuses any other client', () => {
		expect(isPreviewRedirect(QA, 'admin', GOOD)).toBe(false);
	});

	it.each([
		[{ ...QA, ENVIRONMENT: 'production' }],
		[{ ...QA, ENVIRONMENT: undefined }],
		[{ ...QA, PREVIEW_WORKERS_SUBDOMAIN: undefined }],
		[{ ...QA, PREVIEW_WEB_CLIENT_ID: undefined }],
	])('is off without the QA settings: %j', (env) => {
		expect(isPreviewRedirect(env, 'web-qa', GOOD)).toBe(false);
	});
});

describe('withPreviewRedirects', () => {
	const row = { client_id: 'web-qa', redirect_uris: '["https://videos.qa.alummahnow.net/api/callback"]' };
	const db = () => {
		const statement = { bind: vi.fn(() => statement), first: vi.fn(async () => row) };
		return { prepare: vi.fn(() => statement) } as unknown as D1Database;
	};
	const request = (path: string, uri = GOOD, client = 'web-qa') =>
		new Request(`https://auth.qa.alummahnow.net${path}?client_id=${client}&redirect_uri=${encodeURIComponent(uri)}`);

	it('adds this request\'s preview redirect to that client', async () => {
		const wrapped = withPreviewRedirects(db(), QA, request('/authorize'));
		const found = await wrapped.prepare('SELECT * FROM oauth_clients WHERE id = ?').bind('web-qa').first<{ redirect_uris: string }>();
		expect(JSON.parse(found!.redirect_uris)).toEqual(['https://videos.qa.alummahnow.net/api/callback', GOOD]);
	});

	it('leaves other clients\' rows alone', async () => {
		const wrapped = withPreviewRedirects(db(), QA, request('/authorize'));
		const found = await wrapped.prepare('SELECT * FROM oauth_clients WHERE id = ?').bind('other').first<{ redirect_uris: string }>();
		expect(found!.redirect_uris).toBe(row.redirect_uris);
	});

	it('returns the database untouched off /authorize, or with a bad redirect, or outside QA', () => {
		const original = db();
		expect(withPreviewRedirects(original, QA, request('/token'))).toBe(original);
		expect(withPreviewRedirects(original, QA, request('/authorize', 'https://evil.example/api/callback'))).toBe(original);
		expect(withPreviewRedirects(original, { ...QA, ENVIRONMENT: 'production' }, request('/authorize'))).toBe(original);
	});
});

describe('deployment config', () => {
	it('is set for QA, on the QA web client', () => {
		expect(qaConfig.vars.PREVIEW_WEB_CLIENT_ID).toBe('e0de3c30-0304-4ac4-86d6-1e185dec0439');
		expect(qaConfig.vars.PREVIEW_WORKERS_SUBDOMAIN).toBeTruthy();
	});

	it('is never set for production', () => {
		expect(JSON.stringify(prodConfig)).not.toContain('PREVIEW_');
	});
});
