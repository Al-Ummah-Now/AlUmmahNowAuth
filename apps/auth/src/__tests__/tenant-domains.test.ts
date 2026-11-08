import { describe, it, expect } from 'vitest';
import { tenantCustomDomains } from '../utils/tenant-domains';

describe('tenantCustomDomains', () => {
  it('resolves the deployment issuer host to the default tenant (stage)', () => {
    expect(tenantCustomDomains('https://auth.stage.alummahnow.net').get('auth.stage.alummahnow.net')).toBe('default');
  });

  it('keeps production, QA and local hosts', () => {
    const domains = tenantCustomDomains('https://auth.alummahnow.net');
    for (const host of ['auth.alummahnow.net', 'auth.qa.alummahnow.net', 'localhost', '127.0.0.1']) {
      expect(domains.get(host)).toBe('default');
    }
  });

  it('ignores a missing or malformed issuer', () => {
    expect(tenantCustomDomains(undefined).size).toBe(4);
    expect(tenantCustomDomains('not a url').size).toBe(4);
  });
});
