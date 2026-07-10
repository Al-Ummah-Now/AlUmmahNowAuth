# VPS + Cloudflare Dual Deployment Plan

This plan enables deploying the same codebase to both Cloudflare Workers and a self-hosted VPS using workerd (Cloudflare's open-source runtime).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CI/CD Pipeline                           │
├─────────────────────────────────────────────────────────────────┤
│   ┌─────────┐    ┌──────────┐    ┌─────────────────────────┐   │
│   │  Build  │───►│  Test    │───►│     Deploy Target       │   │
│   └─────────┘    └──────────┘    │  ┌─────┐    ┌─────┐     │   │
│                                  │  │ CF  │ or │ VPS │     │   │
│                                  │  └─────┘    └─────┘     │   │
│                                  └─────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## VPS Stack Mapping

| Component | Cloudflare | VPS Equivalent |
|-----------|------------|----------------|
| Runtime | Workers | **workerd** (same engine) |
| D1 | Cloudflare D1 | **SQLite file** |
| KV | Cloudflare KV | **Redis** |
| Queues | CF Queues | **Redis Streams / BullMQ** |
| Secrets | CF Secrets | **Environment variables** |
| TLS | Automatic | **Caddy** (auto-certs) |

## Implementation Files

### 1. VPS Setup Script

**File:** `scripts/setup-vps-cf-runtime.sh`

```bash
#!/bin/bash
set -e

echo "=== Setting up Cloudflare-compatible VPS runtime ==="

# Install workerd (Cloudflare's open-source Workers runtime)
echo "Installing workerd..."
curl -fsSL https://github.com/cloudflare/workerd/releases/latest/download/workerd-linux-64.gz | gunzip > /usr/local/bin/workerd
chmod +x /usr/local/bin/workerd

# Install Redis (for KV storage)
echo "Installing Redis..."
apt-get update
apt-get install -y redis-server
systemctl enable redis-server
systemctl start redis-server

# Install SQLite (for D1)
echo "Installing SQLite..."
apt-get install -y sqlite3

# Install Caddy (reverse proxy + automatic TLS)
echo "Installing Caddy..."
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# Create directory structure
echo "Creating directory structure..."
mkdir -p /opt/workers/{auth,admin,profile,audit-consumer}
mkdir -p /var/lib/workers/{kv,d1,queues}
mkdir -p /var/log/workers

# Create workers user
useradd -r -s /bin/false workers || true
chown -R workers:workers /opt/workers /var/lib/workers /var/log/workers

echo "=== VPS setup complete ==="
echo "Next steps:"
echo "1. Copy workerd config to /opt/workers/config.capnp"
echo "2. Copy Caddyfile to /etc/caddy/Caddyfile"
echo "3. Copy systemd service to /etc/systemd/system/workerd.service"
echo "4. Run: systemctl daemon-reload && systemctl enable workerd"
```

### 2. Workerd Configuration

**File:** `deploy/vps/config.capnp`

```capnp
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "auth", worker = .authWorker),
    (name = "admin", worker = .adminWorker),
    (name = "profile", worker = .profileWorker),
  ],
  sockets = [
    (name = "auth-http", address = "127.0.0.1:8787", http = (), service = "auth"),
    (name = "admin-http", address = "127.0.0.1:8788", http = (), service = "admin"),
    (name = "profile-http", address = "127.0.0.1:8789", http = (), service = "profile"),
  ]
);

const authWorker :Workerd.Worker = (
  modules = [
    (name = "worker", esModule = embed "/opt/workers/auth/index.js"),
  ],
  compatibilityDate = "2024-12-30",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [
    (name = "AUTH_DB", wrapped = (moduleName = "d1-shim", innerBindings = [
      (name = "db", sqliteDatabase = "/var/lib/workers/d1/auth.sqlite")
    ])),
    (name = "AUTH_STORAGE", kvNamespace = "/var/lib/workers/kv/auth"),
    # Environment variables
    (name = "ENVIRONMENT", text = "production"),
    (name = "OPENAUTH_ISSUER", text = "https://auth.yourdomain.com"),
  ],
);

const adminWorker :Workerd.Worker = (
  modules = [
    (name = "worker", esModule = embed "/opt/workers/admin/index.js"),
  ],
  compatibilityDate = "2024-12-30",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [
    (name = "AUTH_STORAGE", kvNamespace = "/var/lib/workers/kv/auth"),
    (name = "AUTH_SERVER_URL", text = "https://auth.yourdomain.com"),
    (name = "APP_URL", text = "https://admin.yourdomain.com"),
  ],
);

const profileWorker :Workerd.Worker = (
  modules = [
    (name = "worker", esModule = embed "/opt/workers/profile/index.js"),
  ],
  compatibilityDate = "2024-12-30",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [
    (name = "AUTH_STORAGE", kvNamespace = "/var/lib/workers/kv/auth"),
    (name = "AUTH_SERVER_URL", text = "https://auth.yourdomain.com"),
    (name = "APP_URL", text = "https://profile.yourdomain.com"),
  ],
);
```

### 3. Systemd Service

**File:** `deploy/vps/workerd.service`

```ini
[Unit]
Description=Cloudflare Workers Runtime (workerd)
Documentation=https://github.com/cloudflare/workerd
After=network.target redis.service
Requires=redis.service

[Service]
Type=simple
User=workers
Group=workers
ExecStart=/usr/local/bin/workerd serve /opt/workers/config.capnp
Restart=always
RestartSec=5
StandardOutput=append:/var/log/workers/workerd.log
StandardError=append:/var/log/workers/workerd.error.log

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/workers /var/log/workers

# Environment
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### 4. Caddy Configuration

**File:** `deploy/vps/Caddyfile`

```caddyfile
# Auth server
auth.yourdomain.com {
    reverse_proxy localhost:8787

    header {
        # Security headers
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
    }

    log {
        output file /var/log/caddy/auth.log
    }
}

# Admin dashboard
admin.yourdomain.com {
    reverse_proxy localhost:8788

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "SAMEORIGIN"
    }

    log {
        output file /var/log/caddy/admin.log
    }
}

# Profile app
profile.yourdomain.com {
    reverse_proxy localhost:8789

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
    }

    log {
        output file /var/log/caddy/profile.log
    }
}
```

### 5. CI/CD Pipeline

**File:** `.github/workflows/deploy.yml`

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      target:
        description: 'Deploy target'
        required: true
        default: 'cloudflare'
        type: choice
        options:
          - cloudflare
          - vps
          - both

env:
  NODE_VERSION: '20'
  PNPM_VERSION: '9'

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: ${{ env.PNPM_VERSION }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build all apps
        run: pnpm build

      - name: Upload build artifacts
        uses: actions/upload-artifact@v4
        with:
          name: dist
          path: |
            apps/auth/dist
            apps/admin/build
            apps/profile/dist
            apps/audit-consumer/dist
          retention-days: 1

  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm test

  deploy-cloudflare:
    needs: [build, test]
    if: >
      github.event_name == 'push' ||
      inputs.target == 'cloudflare' ||
      inputs.target == 'both'
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: ${{ env.PNPM_VERSION }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Download build artifacts
        uses: actions/download-artifact@v4
        with:
          name: dist
          path: apps/

      - name: Deploy to Cloudflare
        run: pnpm deploy:all
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}

  deploy-vps:
    needs: [build, test]
    if: inputs.target == 'vps' || inputs.target == 'both'
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Download build artifacts
        uses: actions/download-artifact@v4
        with:
          name: dist
          path: dist/

      - name: Deploy to VPS
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            set -e

            echo "Stopping workerd..."
            sudo systemctl stop workerd || true

            echo "Backing up current deployment..."
            sudo cp -r /opt/workers /opt/workers.backup.$(date +%Y%m%d%H%M%S) || true

            echo "Deploying new build..."
            sudo rsync -avz --delete dist/auth/ /opt/workers/auth/
            sudo rsync -avz --delete dist/admin/ /opt/workers/admin/
            sudo rsync -avz --delete dist/profile/ /opt/workers/profile/

            echo "Running database migrations..."
            for migration in migrations/*.sql; do
              sudo sqlite3 /var/lib/workers/d1/auth.sqlite < "$migration"
            done

            echo "Setting permissions..."
            sudo chown -R workers:workers /opt/workers

            echo "Starting workerd..."
            sudo systemctl start workerd

            echo "Checking service status..."
            sudo systemctl status workerd --no-pager

            echo "Deployment complete!"

      - name: Health check
        run: |
          sleep 10
          curl -f https://auth.${{ secrets.VPS_DOMAIN }}/health || exit 1
```

### 6. Storage Adapter (Optional Enhancement)

**File:** `packages/storage-adapter/src/kv.ts`

```typescript
/**
 * KV Namespace interface compatible with Cloudflare KV
 */
export interface KVNamespace {
  get(key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number }): Promise<{ keys: { name: string }[] }>;
}

/**
 * Redis-backed KV implementation for VPS deployment
 */
export function createRedisKV(redis: RedisClient): KVNamespace {
  return {
    async get(key, options) {
      const value = await redis.get(key);
      if (value === null) return null;
      if (options?.type === 'json') return JSON.parse(value);
      return value;
    },

    async put(key, value, options) {
      if (options?.expirationTtl) {
        await redis.setex(key, options.expirationTtl, value);
      } else {
        await redis.set(key, value);
      }
    },

    async delete(key) {
      await redis.del(key);
    },

    async list(options) {
      const pattern = options?.prefix ? `${options.prefix}*` : '*';
      const keys = await redis.keys(pattern);
      const limited = options?.limit ? keys.slice(0, options.limit) : keys;
      return { keys: limited.map(name => ({ name })) };
    }
  };
}
```

## What Stays the Same

| Aspect | Changes Needed? | Notes |
|--------|-----------------|-------|
| Application TypeScript code | ❌ None | Identical |
| D1 SQL queries | ❌ None | Same SQLite syntax |
| KV operations | ❌ None | Same API |
| Build process | ❌ None | Same `pnpm build` |
| Database migrations | ❌ None | Same SQL files |
| OpenAuth configuration | ❌ None | Same setup |

## What Differs Per Environment

| Aspect | Cloudflare | VPS |
|--------|------------|-----|
| Deploy command | `wrangler deploy` | `rsync + systemctl restart` |
| Runtime management | Managed by CF | systemd service |
| KV backend | Cloudflare KV | Redis / file-backed |
| TLS certificates | Automatic | Caddy auto-certs |
| Scaling | Global edge (automatic) | Manual (single server) |
| Cost model | Usage-based | Fixed VPS cost |
| Latency | Edge (global) | Single region |

## Implementation Phases

### Phase 1: Infrastructure Setup
- [ ] Create `scripts/setup-vps-cf-runtime.sh`
- [ ] Create `deploy/vps/` directory with all configs
- [ ] Provision VPS and run setup script
- [ ] Test workerd locally with current build output

### Phase 2: Storage Configuration
- [ ] Configure Redis for KV storage
- [ ] Initialize SQLite database with schema
- [ ] Test D1 compatibility with local SQLite
- [ ] Verify KV operations work with Redis

### Phase 3: CI/CD Pipeline
- [ ] Update `.github/workflows/deploy.yml`
- [ ] Add VPS secrets to GitHub repository:
  - `VPS_HOST`
  - `VPS_USER`
  - `VPS_SSH_KEY`
  - `VPS_DOMAIN`
- [ ] Test Cloudflare deployment still works
- [ ] Test VPS deployment
- [ ] Test dual deployment (`both` option)

### Phase 4: Production Hardening
- [ ] Set up monitoring (health checks)
- [ ] Configure log rotation
- [ ] Set up backup for SQLite database
- [ ] Document rollback procedure

## VPS Requirements

**Minimum specifications:**
- 1 CPU core
- 1 GB RAM
- 20 GB SSD
- Ubuntu 22.04 LTS or Debian 12

**Recommended for production:**
- 2+ CPU cores
- 2+ GB RAM
- 40+ GB SSD
- Dedicated IP address

## Security Considerations

1. **Firewall:** Only expose ports 80, 443, and SSH
2. **SSH:** Use key-based authentication only
3. **Redis:** Bind to localhost only, no external access
4. **SQLite:** Store in protected directory with restricted permissions
5. **Secrets:** Use environment variables, never commit to git
6. **Updates:** Keep workerd, Redis, and Caddy updated

## Rollback Procedure

```bash
# On VPS, if deployment fails:
sudo systemctl stop workerd
sudo rm -rf /opt/workers
sudo mv /opt/workers.backup.TIMESTAMP /opt/workers
sudo systemctl start workerd
```

## Monitoring

Add health check endpoint to auth app:

```typescript
// Already exists at /health
app.get('/health', (c) => c.json({ status: 'ok', timestamp: Date.now() }));
```

Monitor with:
- Uptime robot / Pingdom for external checks
- systemd watchdog for process health
- Caddy access logs for request metrics
