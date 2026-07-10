# VPS + Cloudflare Dual Deployment Plan

## Overview
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

## VPS Stack

| Component | Cloudflare | VPS Equivalent |
|-----------|------------|----------------|
| Runtime | Workers | **workerd** (same engine) |
| D1 | Cloudflare D1 | **SQLite file** |
| KV | Cloudflare KV | **Redis** |
| Queues | CF Queues | **Redis Streams / BullMQ** |
| Secrets | CF Secrets | **Environment variables** |
| TLS | Automatic | **Caddy** (auto-certs) |

## Implementation Files Needed

### 1. VPS Setup Script (`scripts/setup-vps-cf-runtime.sh`)

```bash
#!/bin/bash
# Installs workerd, Redis, SQLite, Caddy on VPS

# Install workerd
curl -fsSL https://github.com/cloudflare/workerd/releases/latest/download/workerd-linux-64.gz | gunzip > /usr/local/bin/workerd
chmod +x /usr/local/bin/workerd

# Install Redis (for KV)
apt-get install -y redis-server

# Install SQLite (for D1)
apt-get install -y sqlite3

# Install Caddy (reverse proxy + auto TLS)
apt-get install -y caddy

# Create directory structure
mkdir -p /opt/workers/{auth,admin,profile}
mkdir -p /var/lib/workers/{kv,d1,queues}
```

### 2. Workerd Config (`deploy/vps/config.capnp`)

```capnp
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "auth", worker = .authWorker),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:8787", http = (), service = "auth"),
  ]
);

const authWorker :Workerd.Worker = (
  modules = [
    (name = "worker", esModule = embed "dist/index.js"),
  ],
  compatibilityDate = "2024-12-30",
  bindings = [
    (name = "AUTH_DB", wrapped = (moduleName = "d1-shim", innerBindings = [
      (name = "db", sqliteDatabase = "/var/lib/workers/d1/auth.sqlite")
    ])),
    (name = "AUTH_STORAGE", kvNamespace = "/var/lib/workers/kv/auth"),
  ],
);
```

### 3. CI/CD Pipeline (`.github/workflows/deploy.yml`)

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

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install
      - run: pnpm build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: apps/*/dist

  deploy-cloudflare:
    needs: build
    if: inputs.target == 'cloudflare' || inputs.target == 'both' || github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
      - run: pnpm install
      - run: pnpm deploy:all
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}

  deploy-vps:
    needs: build
    if: inputs.target == 'vps' || inputs.target == 'both'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
      
      - name: Deploy to VPS
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            systemctl stop workerd
            rsync -avz dist/ /opt/workers/
            sqlite3 /var/lib/workers/d1/auth.sqlite < migrations/*.sql
            systemctl start workerd
```

### 4. Systemd Service (`deploy/vps/workerd.service`)

```ini
[Unit]
Description=Cloudflare Workers Runtime
After=network.target redis.target

[Service]
Type=simple
ExecStart=/usr/local/bin/workerd serve /opt/workers/config.capnp
Restart=always
User=workers
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### 5. Caddy Config (`deploy/vps/Caddyfile`)

```caddyfile
auth.yourdomain.com {
    reverse_proxy localhost:8787
}

admin.yourdomain.com {
    reverse_proxy localhost:8788
}

profile.yourdomain.com {
    reverse_proxy localhost:8789
}
```

### 6. Storage Adapter Package (`packages/storage-adapter/`)

Create abstraction layer so KV/D1 work identically on both platforms:

```typescript
// packages/storage-adapter/src/kv.ts
export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

// Redis-backed implementation for VPS
export function createRedisKV(redis: Redis): KVNamespace {
  return {
    async get(key) { return redis.get(key); },
    async put(key, value, opts) { 
      if (opts?.expirationTtl) {
        await redis.setex(key, opts.expirationTtl, value);
      } else {
        await redis.set(key, value);
      }
    },
    async delete(key) { await redis.del(key); }
  };
}
```

## What Stays the Same (No Changes Needed)

- ✅ All application TypeScript code
- ✅ D1 SQL queries (same SQLite syntax)
- ✅ KV operations (same API)
- ✅ Build process (`pnpm build`)
- ✅ Database migrations (same SQL files)
- ✅ OpenAuth configuration

## What Differs Per Environment

| Aspect | Cloudflare | VPS |
|--------|------------|-----|
| Deploy command | `wrangler deploy` | `rsync + systemctl restart` |
| Runtime management | Managed | systemd |
| KV backend | CF KV | Redis |
| TLS certificates | Automatic | Caddy auto-certs |
| Scaling | Global edge (automatic) | Manual (single server) |
| Cost | Usage-based | Fixed VPS cost |

## Implementation Order

1. **Phase 1: Infrastructure**
   - [ ] Create `scripts/setup-vps-cf-runtime.sh`
   - [ ] Create `deploy/vps/` directory with configs
   - [ ] Test workerd locally with current build output

2. **Phase 2: Storage Adapters**
   - [ ] Create `packages/storage-adapter/` package
   - [ ] Implement Redis KV adapter
   - [ ] Implement D1 shim for local SQLite
   - [ ] Test with existing app code

3. **Phase 3: CI/CD**
   - [ ] Update `.github/workflows/deploy.yml`
   - [ ] Add VPS secrets to GitHub
   - [ ] Test dual deployment

4. **Phase 4: Queue Adapter (if needed)**
   - [ ] Implement Redis Streams adapter for AUDIT_QUEUE
   - [ ] Or use BullMQ for more features

## Notes

- **workerd** is the actual Cloudflare Workers runtime (open-source)
- D1 is just SQLite, so it works identically with a local file
- KV needs Redis adapter (or use Miniflare's file-backed KV for low traffic)
- The application code remains 100% unchanged
