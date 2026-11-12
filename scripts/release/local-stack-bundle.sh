#!/usr/bin/env bash
# Assembles the local-stack bundle of this commit into dist/local-stack (AlUmmahNow's local E2E
# stack, AlUmmahNow scripts/local-stack): prebuilt workers, their wrangler configs and every
# migration, at the same paths as in this repo, so the stack runs a released Auth without checking
# out or installing this repo. Needs the install and `pnpm --filter admin run build` done.
set -euo pipefail
OUT=dist/local-stack
rm -rf "$OUT" && mkdir -p "$OUT/bundles" "$OUT/apps/auth" "$OUT/apps/profile" "$OUT/apps/admin"
(cd apps/auth && npx wrangler deploy --dry-run -c wrangler.json --outdir "../../$OUT/bundles/auth" >/dev/null)
(cd apps/profile && npx wrangler deploy --dry-run -c wrangler.json --outdir "../../$OUT/bundles/profile" >/dev/null)
(cd apps/admin/build/server && npx wrangler deploy --dry-run -c wrangler.json --outdir "../../../../$OUT/bundles/auth-admin" >/dev/null)
cp apps/auth/wrangler.json "$OUT/apps/auth/"
cp -R apps/auth/migrations "$OUT/apps/auth/"
mkdir -p "$OUT/apps/auth/node_modules/@al-ummah-now/openauth/src"
cp -R apps/auth/node_modules/@al-ummah-now/openauth/src/migrations "$OUT/apps/auth/node_modules/@al-ummah-now/openauth/src/"
cp apps/profile/wrangler.json "$OUT/apps/profile/"
cp -R apps/admin/build "$OUT/apps/admin/"
printf '{"sha":"%s","built":"%s"}\n' "$(git rev-parse HEAD)" "$(date -u +%FT%TZ)" > "$OUT/local-stack.json"
echo "local-stack bundle: $(du -sh "$OUT" | cut -f1)"
