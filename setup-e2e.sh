#!/bin/bash

# E2E Testing Setup Script
# This script sets up local development environment variables for E2E testing

echo "Setting up E2E testing environment..."

# Copy .dev.vars.example files to .dev.vars if they don't exist
for app in auth admin profile; do
  if [ ! -f "apps/$app/.dev.vars" ]; then
    echo "Creating apps/$app/.dev.vars from example..."
    cp "apps/$app/.dev.vars.example" "apps/$app/.dev.vars"
  else
    echo "apps/$app/.dev.vars already exists, skipping..."
  fi
done

echo ""
echo "✅ E2E testing environment setup complete!"
echo ""
echo "The .dev.vars files configure the apps to use localhost URLs for local development."
echo "You can now run E2E tests with: pnpm test:e2e"
