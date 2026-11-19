/** The builder preview strips scripts without breaking the page (Auth QA themes.spec.ts:72, 2026-11-15..18). */
import { describe, expect, it } from 'vitest';
import { inert } from './preview';
import { PAGE_MODE_SCRIPT } from '../../../../packages/ui/src/nav/page-header.ts';

describe('theme preview: inert', () => {
	it("removes every script with its contents, so the shared header's script can't swallow the sign-in form", () => {
		const page = `<!doctype html><html><head><script>${PAGE_MODE_SCRIPT}</script><script src="/x.js"></script></head><body><script type="module">if(a<b){}</script><form><input type="email" name="email"><input type="password" name="password"></form></body></html>`;
		const out = inert(page);
		expect(out).not.toMatch(/<script/i);
		expect(out).not.toMatch(/<template/i);
		expect(out).not.toContain('rules.length');
		expect(out).toContain('<input type="password" name="password">');
	});

	it('nested and split tags leave no script behind', () => {
		const out = inert('<scr<script>x</script>ipt>alert(1)</script ><script\n>y</script foo><p>ok</p>');
		expect(out).not.toMatch(/<script/i);
		expect(out).toContain('<p>ok</p>');
	});
});
