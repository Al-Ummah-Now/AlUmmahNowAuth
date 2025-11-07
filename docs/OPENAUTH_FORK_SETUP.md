# OpenAuth Fork Setup

This project uses a forked version of OpenAuth with enterprise features from [PR #1](https://github.com/meywd/openauth/pull/1).

## Current Dependency Configuration

```json
"@openauthjs/openauth": "git+https://github.com/meywd/openauth.git#feat/enterprise-features"
```

## ⚠️ Known Issue: Git Install Requires Build

The git URL dependency **will fail** on fresh `pnpm install` because:
- GitHub git tarballs include source code only
- The `dist/` directory is not in git (it's in `.gitignore`)
- The fork's `package.json` lacks a `prepare` script to build after install

### Workaround (Until Fork is Published)

You need to manually build and link the fork:

```bash
# 1. Clone the fork
cd /tmp
git clone https://github.com/meywd/openauth.git openauth-fork
cd openauth-fork
git checkout feat/enterprise-features

# 2. Install dependencies and build
bun install
cd packages/openauth
bun run build

# 3. Update package.json in your project
# Change to:
"@openauthjs/openauth": "file:/tmp/openauth-fork/packages/openauth"

# 4. Install in your project
cd /path/to/AlUmmahNowAuth
pnpm install
```

### Long-Term Solutions

#### Option 1: Add Prepare Script to Fork (Recommended)

Add this to `packages/openauth/package.json` in the fork:

```json
{
  "scripts": {
    "build": "bun run script/build.ts",
    "prepare": "bun run build",
    "test": "bun test"
  }
}
```

Then the git URL will work: `git+https://github.com/meywd/openauth.git#feat/enterprise-features`

#### Option 2: Create a Release with Built Files

1. Build the package: `cd packages/openauth && bun run build`
2. Create a tarball: `npm pack`
3. Upload to GitHub Releases
4. Update dependency: `"@openauthjs/openauth": "https://github.com/meywd/openauth/releases/download/v0.4.3-enterprise/openauth-0.4.3-enterprise.tgz"`

#### Option 3: Publish to npm (When PR Merges)

When PR #1 is merged and published to npm:

```json
"@openauthjs/openauth": "^0.5.0"
```

## CI/CD Considerations

### GitHub Actions

The CI workflow needs the built package. Current solutions:

1. **Use prepare script** (Option 1 above) - CI will build automatically
2. **Cache the built package** - Add build step to CI:

```yaml
- name: Build OpenAuth fork
  run: |
    cd /tmp
    git clone https://github.com/meywd/openauth.git openauth-fork
    cd openauth-fork
    git checkout feat/enterprise-features
    bun install
    cd packages/openauth
    bun run build

- name: Install dependencies
  run: |
    # Update package.json to use file: path
    pnpm install
```

## Enterprise Features Included

The fork adds:

1. **Client Authentication** - OAuth 2.0 confidential clients with PBKDF2
2. **Token Introspection** - RFC 7662 compliant `/token/introspect`
3. **Token Revocation** - RFC 7009 compliant `/token/revoke`
4. **Audit Logging** - Queue-based audit events for compliance
5. **CORS Configuration** - Environment-based origin whitelisting
6. **D1 Integration** - Client credentials and audit logs in D1

See [OPENAUTH_FORK_PLAN.md](./OPENAUTH_FORK_PLAN.md) for architecture details.
