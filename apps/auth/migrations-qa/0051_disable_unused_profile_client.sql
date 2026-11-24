-- Migration: 0051_disable_unused_profile_client
-- The profile app signs in as 109a1087-… on QA too. 0007's REPLACE took the place of the row 0004 seeded under
-- another id (same tenant and name); where that row still exists, nothing uses it.
-- QA keeps its localhost redirect URIs: local development of the other apps signs in against QA.
UPDATE oauth_clients SET enabled = 0, updated_at = unixepoch() * 1000
WHERE id = '209a1087-6626-40f7-8a7f-7f42f83f4f30' AND enabled = 1;
