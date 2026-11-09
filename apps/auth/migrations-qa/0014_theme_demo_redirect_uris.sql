-- Migration: 0014_theme_demo_redirect_uris
-- QA only. Temporary theme demo sites (one web build per theme, deployed by the
-- monorepo's "Theme demos" workflow to theme-demo-<theme>.mahmoud-s-darwish.workers.dev)
-- sign in through QA auth with the QA videos web client. /authorize matches
-- redirect_uri exactly, so register the same four callback variants the web app
-- uses (see 0010) for each demo host.
--
-- Appends without rewriting the existing list: the merged array keeps every URI
-- already registered and adds each demo URI once, so re-running is a no-op.
-- Remove these entries with a follow-up migration when the demos are torn down.
UPDATE oauth_clients
SET redirect_uris = (
      SELECT json_group_array(value) FROM (
        SELECT value FROM json_each(oauth_clients.redirect_uris)
        UNION
        SELECT value FROM json_each('[
          "https://theme-demo-lantern.mahmoud-s-darwish.workers.dev/api/callback",
          "https://theme-demo-lantern.mahmoud-s-darwish.workers.dev/api/callback?locale=en",
          "https://theme-demo-lantern.mahmoud-s-darwish.workers.dev/api/callback?locale=ar",
          "https://theme-demo-lantern.mahmoud-s-darwish.workers.dev/api/callback/multi-account",
          "https://theme-demo-zujaj.mahmoud-s-darwish.workers.dev/api/callback",
          "https://theme-demo-zujaj.mahmoud-s-darwish.workers.dev/api/callback?locale=en",
          "https://theme-demo-zujaj.mahmoud-s-darwish.workers.dev/api/callback?locale=ar",
          "https://theme-demo-zujaj.mahmoud-s-darwish.workers.dev/api/callback/multi-account",
          "https://theme-demo-nahas.mahmoud-s-darwish.workers.dev/api/callback",
          "https://theme-demo-nahas.mahmoud-s-darwish.workers.dev/api/callback?locale=en",
          "https://theme-demo-nahas.mahmoud-s-darwish.workers.dev/api/callback?locale=ar",
          "https://theme-demo-nahas.mahmoud-s-darwish.workers.dev/api/callback/multi-account",
          "https://theme-demo-fawanees.mahmoud-s-darwish.workers.dev/api/callback",
          "https://theme-demo-fawanees.mahmoud-s-darwish.workers.dev/api/callback?locale=en",
          "https://theme-demo-fawanees.mahmoud-s-darwish.workers.dev/api/callback?locale=ar",
          "https://theme-demo-fawanees.mahmoud-s-darwish.workers.dev/api/callback/multi-account"
        ]')
      )
    ),
    updated_at = unixepoch() * 1000
WHERE id = 'e0de3c30-0304-4ac4-86d6-1e185dec0439';
