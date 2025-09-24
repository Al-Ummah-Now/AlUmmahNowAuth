# CI/CD and Preview Deployments

This document explains the continuous integration and deployment setup for the Al Ummah Now Auth application using Cloudflare Workers and GitHub Actions.

## Overview

The project now includes automated CI/CD workflows that:
- Run tests on every push and pull request
- Deploy preview environments for pull requests
- Deploy to production when code is merged to main
- Provide testing URLs for each environment

## Environments

### Production
- **URL**: `https://al-ummah-now-auth.alummahnow.workers.dev`
- **Admin Panel**: `https://al-ummah-now-auth.alummahnow.workers.dev/admin`
- **Triggers**: Automatically deployed when code is pushed to `main` branch
- **Database**: Uses production D1 database with all migrations applied

### Preview
- **URL**: `https://al-ummah-now-auth-pr-{PR-NUMBER}.mahmoud-s-darwish.workers.dev/`
- **Admin Panel**: Preview URL + `/admin`
- **Example**: For PR #22: `https://al-ummah-now-auth-pr-22.mahmoud-s-darwish.workers.dev/`
- **Triggers**: Automatically deployed for every pull request using Cloudflare Workers preview system
- **Database**: Uses the same database as production but with isolated preview functionality

## GitHub Actions Workflow

The `.github/workflows/deploy.yml` file defines three main jobs:

### 1. Test Job
Runs on every push and pull request:
- Checks out the code
- Sets up Node.js environment
- Installs dependencies
- Runs TypeScript compilation and validation (`npm run check`)

### 2. Deploy Preview Job
Runs only for pull requests:
- Waits for tests to pass
- Deploys to preview environment
- Posts a comment on the PR with preview URL
- Updates the comment on subsequent commits

### 3. Deploy Production Job
Runs only when pushing to main branch:
- Waits for tests to pass
- Applies database migrations to production
- Deploys to production environment

## Required Secrets

To enable the CI/CD workflow, add these secrets to your GitHub repository:

1. **CLOUDFLARE_API_TOKEN**: Your Cloudflare API token with Workers permissions
2. **CLOUDFLARE_ACCOUNT_ID**: Your Cloudflare account ID

### Setting up secrets:
1. Go to your repository settings
2. Navigate to "Secrets and variables" → "Actions"
3. Click "New repository secret"
4. Add both secrets with their respective values

## Local Development Commands

```bash
# Deploy to production
npm run deploy

# Run migrations on production database (automatic before deploy)
npm run predeploy

# Local development
npm run dev
```

## Environment Configuration

The `wrangler.json` file includes preview configurations that work with Cloudflare's standard preview system. Preview deployments automatically use preview resources configured in your Cloudflare account.

## Database Migrations

Database migrations are automatically applied:
- **Preview**: Uses the same database as production with preview isolation
- **Production**: Automatically run before deployment via `predeploy` script

## Testing Workflow

1. **Create PR**: When you create a pull request, GitHub Actions will:
   - Run tests
   - Deploy a preview environment
   - Comment on the PR with the preview URL

2. **Test Changes**: Use the preview URL to test:
   - Authentication flows
   - User management features
   - Admin panel functionality
   - API endpoints

3. **Merge PR**: When merged to main:
   - Tests run again
   - Production deployment happens automatically
   - Database migrations are applied

## Preview URL Format

Preview deployments follow the format: `https://al-ummah-now-auth-pr-{PR-NUMBER}.mahmoud-s-darwish.workers.dev/`

Preview deployment comments include helpful information:
- 📱 **Preview URL**: Direct link to the preview deployment (e.g., `https://al-ummah-now-auth-pr-22.mahmoud-s-darwish.workers.dev/`)
- 🔧 **Admin Panel**: Direct link to the admin interface (e.g., `https://al-ummah-now-auth-pr-22.mahmoud-s-darwish.workers.dev/admin`)
- **Testing instructions**: Guidance on what to test

## Rollback Strategy

If issues are detected after production deployment:

1. **Quick fix**: Create a hotfix PR and merge after testing in preview
2. **Rollback**: Revert the problematic commit and push to main
3. **Manual deploy**: Use `npm run deploy` locally if immediate action is needed

## Monitoring

The deployment includes:
- **Observability**: Enabled for both environments
- **Tail consumers**: For log monitoring
- **Upload source maps**: For better debugging

## Security

- Secrets are stored securely in GitHub repository secrets
- Preview environments use isolated databases
- No production data is exposed in preview environments
- All deployments require passing tests

## Troubleshooting

### Deployment Fails
1. Check the GitHub Actions logs
2. Verify secrets are properly set
3. Ensure Cloudflare account has proper permissions
4. Check wrangler.json configuration

### Preview Not Working
1. Verify the preview environment exists in Cloudflare
2. Check if database migrations need to be applied
3. Review the GitHub Actions logs for errors

### Database Issues
1. Ensure migrations are up to date
2. Check database bindings in wrangler.json
3. Verify D1 database exists in Cloudflare dashboard

## Related Documentation

- [Roadmap](./ROADMAP.md) - CI/CD improvements planned for future phases
- [Architecture](./ARCHITECTURE.md) - Deployment architecture and infrastructure details
- [Authentication Flows](./AUTHENTICATION_FLOWS.md) - Testing authentication in CI/CD environments
- [User Management](./USER_MANAGEMENT.md) - Database migrations for user management features