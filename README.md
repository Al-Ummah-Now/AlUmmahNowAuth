# Al Ummah Now Auth

![OpenAuth Template Preview](https://imagedelivery.net/wSMYJvS3Xw-n339CbDyDIA/b2ff10c6-8f7c-419f-8757-e2ccf1c84500/public)

<!-- dash-content-start -->

[OpenAuth](https://openauth.js.org/) is a universal provider for managing user authentication. This monorepo contains two Cloudflare Workers applications:
- **Auth Server**: OpenAuth-based authentication service
- **Admin Dashboard**: React-based user management interface

<!-- dash-content-end -->

## ✨ Features

- **🔐 Authentication**: Secure email-based authentication using OpenAuth
- **👥 Admin Dashboard**: Modern React Router v7 app with shadcn/ui
- **🛡️ Role-Based Access**: Support for admin and user roles
- **🔄 Password Reset**: Admin-initiated password reset functionality
- **🚀 CI/CD**: Automated deployments with preview environments
- **📊 Monitoring**: Built-in observability and logging
- **🎨 Modern UI**: Dark theme with Slate/Blue color scheme

## 🏗️ Architecture

This is a **pnpm monorepo** with the following structure:

```
AlUmmahNowAuth/
├── apps/
│   ├── auth/              # OpenAuth server (Cloudflare Worker)
│   │   ├── src/
│   │   ├── migrations/    # D1 database migrations
│   │   └── wrangler.json
│   │
│   └── admin/             # Admin dashboard (React Router v7)
│       ├── app/
│       │   ├── routes/    # React Router routes
│       │   ├── components/ui/  # shadcn/ui components
│       │   └── lib/       # Utilities and DB functions
│       ├── server.ts      # Cloudflare Worker entry
│       └── wrangler.json
│
├── pnpm-workspace.yaml
└── package.json
```

### Apps Overview

#### Auth App (`apps/auth`)
- Deploys to: `al-ummah-now-auth` worker
- OpenAuth server handling authentication flows
- Email-based passwordless authentication
- JWT token generation
- Shared D1 database access

#### Admin App (`apps/admin`)
- Deploys to: `al-ummah-now-auth-admin` worker
- React Router v7 with Server-Side Rendering
- shadcn/ui components with dark theme
- User management CRUD operations
- Real-time stats and analytics
- Shares D1 database with auth app

## 🌐 Live Deployments

- **Auth Server**: [https://al-ummah-now-auth.alummahnow.workers.dev](https://al-ummah-now-auth.alummahnow.workers.dev)
- **Admin Dashboard**: [https://al-ummah-now-auth-admin.alummahnow.workers.dev](https://al-ummah-now-auth-admin.alummahnow.workers.dev)
- **Preview Deployments**: Auto-generated for each PR
  - Auth: `https://al-ummah-now-auth-pr-{PR-NUMBER}.mahmoud-s-darwish.workers.dev/`
  - Admin: `https://al-ummah-now-auth-admin-pr-{PR-NUMBER}.mahmoud-s-darwish.workers.dev/`

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- Cloudflare account with Workers and D1 access

### Installation

```bash
# Install pnpm if you haven't
npm install -g pnpm@9

# Install all dependencies
pnpm install
```

### Development

Run both apps concurrently:
```bash
pnpm dev
```

Run individual apps:
```bash
# Auth server only
pnpm dev:auth

# Admin dashboard only
pnpm dev:admin
```

The auth server will be available at `http://localhost:8787` and the admin dashboard at `http://localhost:5174`.

### Database Setup

Apply migrations to your local D1 database:
```bash
cd apps/auth
pnpm run migrations:local
```

Apply migrations to production:
```bash
cd apps/auth
pnpm run migrations:remote
```

### Deployment

Deploy both apps:
```bash
pnpm deploy
```

Deploy individual apps:
```bash
# Auth server
pnpm deploy:auth

# Admin dashboard
pnpm deploy:admin
```

## 📝 Configuration

### Auth App (`apps/auth/wrangler.json`)

```json
{
  "name": "al-ummah-now-auth",
  "main": "src/index.ts",
  "kv_namespaces": [...],
  "d1_databases": [
    {
      "binding": "AUTH_DB",
      "database_name": "al-ummah-now-d1",
      "database_id": "your-database-id"
    }
  ]
}
```

### Admin App (`apps/admin/wrangler.json`)

```json
{
  "name": "al-ummah-now-auth-admin",
  "main": ".react-router/worker.js",
  "d1_databases": [
    {
      "binding": "AUTH_DB",
      "database_name": "al-ummah-now-d1",
      "database_id": "same-database-id"
    }
  ]
}
```

**Important**: Both apps share the same D1 database.

## 🎨 Admin Dashboard Features

- **Dashboard**: User statistics and system overview
- **User Management**:
  - View all users in a searchable table
  - Create new users with role assignment
  - Edit user details and roles
  - Delete users
- **Dark Theme**: Professional Slate/Blue color scheme
- **Responsive Design**: Works on all device sizes
- **Server-Side Rendering**: Fast initial page loads

## 🗺️ Project Roadmap

**Current Status:** Phase 1 Complete ✅ | Phase 2 In Progress 🚧

**Next Milestone:** Alpha v0.8.0 - February 15, 2025

This project follows a structured roadmap toward v1.0 release (March 31, 2025). We track progress through GitHub issues organized into major epics:

### 🎯 V1.0 Epics & Progress
- **🔐 Authentication & Tokens** - Enhanced security, MFA, rate limiting
- **🔑 OAuth & External Auth** - Full OAuth 2.0/OIDC compliance, social logins
- **🛡️ RBAC & User Management** - Advanced roles, multi-tenant support
- **📚 Documentation & DX** - OpenAPI docs, SDKs, integration guides
- **🚀 CI/CD & Infrastructure** - Monitoring, release automation, testing
- **📦 Release & Distribution** - Security audit, performance optimization

### 📋 How to Contribute to Roadmap
1. **View the [📋 Full Roadmap](./ROADMAP.md)** for detailed v1.0 planning
2. **Create [🗺️ Epic Issues](https://github.com/meywd/AlUmmahNowAuth/issues/new?template=roadmap_epic.md)** for major features
3. **Create [📋 Child Issues](https://github.com/meywd/AlUmmahNowAuth/issues/new?template=v1_child_issue.md)** for specific tasks
4. **Track Progress** via [GitHub Milestones](https://github.com/meywd/AlUmmahNowAuth/milestones)

## 🛠️ Technology Stack

### Auth App
- OpenAuth.js - Authentication framework
- Cloudflare Workers - Serverless runtime
- D1 Database - SQLite database
- KV Storage - Key-value storage
- Resend - Email delivery

### Admin App
- React 19 - UI library
- React Router v7 - Routing and SSR
- shadcn/ui - UI components
- Tailwind CSS v4 - Styling
- Lucide Icons - Icon library
- Cloudflare Workers - Serverless runtime
- D1 Database - Shared database access

## 📚 Documentation

- [User Management Guide](./USER_MANAGEMENT.md)
- [CI/CD Documentation](./CICD.md)
- [Authentication Flows](./AUTHENTICATION_FLOWS.md)
- [Architecture Overview](./ARCHITECTURE.md)

## 🔒 Security

- Email-based passwordless authentication
- JWT tokens with secure signing
- Role-based access control
- Admin-initiated password reset
- Secure secrets management via Cloudflare

## 🧪 Testing

```bash
# Type check all apps
pnpm type-check

# Type check individual apps
pnpm --filter auth type-check
pnpm --filter admin type-check
```

## 📦 Scripts Reference

### Root Level
- `pnpm dev` - Run all apps in development
- `pnpm build` - Build all apps
- `pnpm deploy` - Deploy all apps
- `pnpm type-check` - Type check all apps

### Per-App
- `pnpm dev:auth` / `pnpm dev:admin` - Run specific app
- `pnpm build:auth` / `pnpm build:admin` - Build specific app
- `pnpm deploy:auth` / `pnpm deploy:admin` - Deploy specific app

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and type checks
5. Submit a pull request

Preview deployments will be automatically created for your PR!

## 📄 License

This project is part of the Al Ummah Now ecosystem.

## 🙏 Acknowledgments

- [OpenAuth.js](https://openauth.js.org/) - Authentication framework
- [React Router](https://reactrouter.com/) - Routing library
- [shadcn/ui](https://ui.shadcn.com/) - UI components
- [Cloudflare Workers](https://workers.cloudflare.com/) - Serverless platform
