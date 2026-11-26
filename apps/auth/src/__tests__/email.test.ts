import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SendEmail from '../email';

const options = {
  apiKey: 're_test',
  from: 'Example <sender@example.com>',
  to: 'recipient@example.com',
  subject: 'Test',
  html: '<p>Test</p>',
  text: 'Test',
};

function resendError(status: number, retryAfter?: string) {
  return Response.json({
    statusCode: status,
    name: status === 429 ? 'rate_limit_exceeded' : 'validation_error',
    message: 'Rejected by Resend',
  }, { status, headers: retryAfter ? { 'Retry-After': retryAfter } : undefined });
}

describe('SendEmail', () => {
  const fetchEmail = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchEmail.mockReset();
    vi.stubGlobal('fetch', fetchEmail);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('validates email addresses before calling Resend', async () => {
    await expect(SendEmail({ ...options, to: 'invalid' })).rejects.toThrow('Invalid email address');
    expect(fetchEmail).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 422])('stops on a permanent HTTP %i error', async (status) => {
    fetchEmail.mockResolvedValueOnce(resendError(status));
    await expect(SendEmail(options)).rejects.toThrow('Unable to send email after 1 attempt.');
    expect(fetchEmail).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops on a Resend validation error without a statusCode in the body', async () => {
    fetchEmail.mockResolvedValueOnce(Response.json({ name: 'validation_error', message: 'Invalid address' }, { status: 422 }));
    await expect(SendEmail(options)).rejects.toThrow('Unable to send email after 1 attempt.');
    expect(fetchEmail).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['delay in seconds', () => resendError(429, '3')],
    ['HTTP date on a named error', () => Response.json({ name: 'rate_limit_exceeded' }, {
      status: 429,
      headers: { 'Retry-After': new Date(Date.now() + 3000).toUTCString() },
    })],
  ])('honors Retry-After as %s for HTTP 429', async (_label, response) => {
    vi.setSystemTime(new Date('2026-11-26T00:00:00Z'));
    fetchEmail.mockResolvedValueOnce(response())
      .mockResolvedValueOnce(Response.json({ id: 'email-1' }));

    const send = SendEmail(options);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchEmail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(send).resolves.toEqual({ success: true, emailId: 'email-1' });
    expect(fetchEmail).toHaveBeenCalledTimes(2);
  });

  it('stops when Retry-After exceeds the in-request wait budget', async () => {
    fetchEmail.mockResolvedValueOnce(resendError(429, '60'));
    await expect(SendEmail(options)).rejects.toThrow('Unable to send email after 1 attempt.');
    expect(fetchEmail).toHaveBeenCalledTimes(1);
  });

  it.each(['429', '500', 'network'])('bounds retries after %s failures', async (kind) => {
    if (kind === 'network') fetchEmail.mockRejectedValue(new TypeError('Connection reset'));
    else fetchEmail.mockImplementation(async () => resendError(Number(kind)));

    const check = expect(SendEmail(options)).rejects.toThrow('Unable to send email after 3 attempts.');
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchEmail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchEmail).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    await check;
    expect(fetchEmail).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
