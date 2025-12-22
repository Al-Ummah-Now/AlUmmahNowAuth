#!/bin/bash
# Clear D1 Database and KV Storage for different environments
# Usage:
#   ./scripts/clear-env.sh --qa        (remote QA - wrangler.qa.json)
#   ./scripts/clear-env.sh --preview   (remote preview - wrangler.json)
#   ./scripts/clear-env.sh --prod      (remote production - requires confirmation)

cd "$(dirname "$0")/.."

# Environment configs
# QA: D1=28590f3c-dd92-4c26-a803-d73a9bbe2b58, KV=14fd32ab385b496c88b5dba88c2492ea (wrangler.qa.json)
# Preview/Prod: D1=af76f007-e21e-43aa-88de-ebfefe46fb56, KV=c3f796d40db8420c920aef1ce10a7f13 (wrangler.json)

show_usage() {
  echo "Usage: $0 [--qa|--preview|--prod]"
  echo ""
  echo "  --qa        Clear remote QA environment (wrangler.qa.json)"
  echo "  --preview   Clear remote preview environment (wrangler.json)"
  echo "  --prod      Clear remote production environment (requires confirmation)"
  exit 1
}

if [ $# -eq 0 ]; then
  show_usage
fi

case "$1" in
  --qa)
    ENV_NAME="QA"
    WRANGLER_CONFIG="-c wrangler.qa.json"
    KV_NAMESPACE="14fd32ab385b496c88b5dba88c2492ea"
    ;;
  --preview)
    ENV_NAME="Remote Preview"
    WRANGLER_CONFIG=""
    KV_NAMESPACE="c3f796d40db8420c920aef1ce10a7f13"
    ;;
  --prod)
    ENV_NAME="PRODUCTION"
    WRANGLER_CONFIG=""
    KV_NAMESPACE="c3f796d40db8420c920aef1ce10a7f13"
    echo ""
    echo "⚠️  WARNING: You are about to clear PRODUCTION data!"
    echo ""
    read -p "Type 'DELETE PRODUCTION' to confirm: " confirm
    if [ "$confirm" != "DELETE PRODUCTION" ]; then
      echo "Aborted."
      exit 1
    fi
    ;;
  *)
    show_usage
    ;;
esac

echo ""
echo "=== Clearing $ENV_NAME Environment ==="
echo ""

echo "Step 1: Dropping all tables in D1 database..."

# Get user tables (exclude sqlite internal and cloudflare internal tables)
tables_json=$(npx wrangler d1 execute AUTH_DB $WRANGLER_CONFIG --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'" \
  2>&1)

# Extract table names
tables=$(echo "$tables_json" | grep -o '"name": "[^"]*"' | sed 's/"name": "//g; s/"//g' || echo "")

if [ -z "$tables" ]; then
  echo "No user tables found (database already empty)."
else
  echo "Found tables to drop:"
  echo "$tables"
  echo ""

  # Disable FK checks first
  npx wrangler d1 execute AUTH_DB $WRANGLER_CONFIG --remote \
    --command "PRAGMA foreign_keys = OFF" 2>/dev/null || true

  # Drop each table
  while IFS= read -r table; do
    if [ -n "$table" ]; then
      echo "  Dropping: $table"
      npx wrangler d1 execute AUTH_DB $WRANGLER_CONFIG --remote \
        --command "DROP TABLE IF EXISTS \"$table\"" 2>/dev/null || true
    fi
  done <<< "$tables"

  echo "All tables dropped."
fi

echo ""
echo "Step 2: Clearing KV storage..."

temp_file=$(mktemp)
npx wrangler kv key list --namespace-id="$KV_NAMESPACE" --remote 2>/dev/null | jq '[.[].name]' > "$temp_file"

key_count=$(jq 'length' "$temp_file" 2>/dev/null || echo "0")

if [ "$key_count" = "0" ] || [ -z "$key_count" ]; then
  echo "No keys found in KV storage."
else
  echo "Found $key_count keys to delete..."
  echo "Running bulk delete..."
  npx wrangler kv bulk delete --namespace-id="$KV_NAMESPACE" --remote --force "$temp_file" 2>&1
  echo "KV storage cleared."
fi

rm -f "$temp_file"

echo ""
echo "=== $ENV_NAME Environment Cleared ==="
echo ""

case "$1" in
  --qa)
    echo "Next steps:"
    echo "  1. Run OpenAuth migrations: npx openauth migrate AUTH_DB -c wrangler.qa.json --remote"
    echo "  2. Run Wrangler migrations: npx wrangler d1 migrations apply AUTH_DB -c wrangler.qa.json --remote"
    echo "  3. Bootstrap secrets: npx openauth bootstrap-secrets AUTH_DB -c wrangler.qa.json --remote"
    echo "  4. Deploy: npx wrangler deploy -c wrangler.qa.json"
    ;;
  --preview|--prod)
    echo "Next steps:"
    echo "  1. Run OpenAuth migrations: npx openauth migrate AUTH_DB --remote"
    echo "  2. Run Wrangler migrations: npx wrangler d1 migrations apply AUTH_DB --remote"
    echo "  3. Bootstrap secrets: npx openauth bootstrap-secrets AUTH_DB --remote"
    echo "  4. Deploy: npx wrangler deploy"
    ;;
esac
