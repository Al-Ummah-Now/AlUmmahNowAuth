/**
 * Auth's errors reach the videos admin Errors page (#341). A marked test error goes through the
 * real reporter (POST /test/report-error, QA/stage only) and admin-api's ingest must accept it
 * (202): the ingest URL, the internal key and the app name 'auth' all work in this env. Test
 * errors never alert and are deleted after a day.
 */
import { test, expect } from '@playwright/test';
import { TEST_URLS } from '../../utils/test-data';

test('an Auth error report reaches the admin Errors page ingest', async ({ request }) => {
  test.skip(!process.env.E2E_CODE_SINK_SECRET, 'E2E_CODE_SINK_SECRET not set: test routes are closed');
  const res = await request.post(`${TEST_URLS.authServer}/test/report-error`, {
    headers: { 'X-E2E-Secret': process.env.E2E_CODE_SINK_SECRET! },
  });
  const body = (await res.json().catch(() => ({}))) as { reference?: string; ingest?: number | string };
  expect(body.reference, 'a reference the user can quote').toMatch(/^ERR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  expect(body.ingest, `ingest answer for ${body.reference} (no-url / no-key: reporting is not configured; 400: the ingest refuses app 'auth')`).toBe(202);
  expect(res.status()).toBe(200);
});
