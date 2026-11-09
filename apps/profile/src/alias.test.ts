import { describe, expect, it } from 'vitest';
import { aliasRedirect } from './alias';

const PROD = 'https://profile.auth.alummahnow.net';

describe('account.* alias', () => {
  it('redirects to the profile host keeping path and query', () => {
    const res = aliasRedirect('https://account.alummahnow.net/apps?lang=ar', PROD);
    expect(res?.status).toBe(301);
    expect(res?.headers.get('Location')).toBe('https://profile.auth.alummahnow.net/apps?lang=ar');
  });

  it('redirects the bare host to the profile root', () => {
    const res = aliasRedirect('https://account.qa.alummahnow.net/', 'https://profile.auth.qa.alummahnow.net');
    expect(res?.headers.get('Location')).toBe('https://profile.auth.qa.alummahnow.net/');
  });

  it('leaves requests on the profile host alone', () => {
    expect(aliasRedirect('https://profile.auth.alummahnow.net/apps', PROD)).toBeNull();
  });

  it('does nothing without APP_URL', () => {
    expect(aliasRedirect('https://account.alummahnow.net/', undefined)).toBeNull();
  });
});
