# Al Ummah Now Auth

![OpenAuth Template Preview](https://imagedelivery.net/wSMYJvS3Xw-n339CbDyDIA/b2ff10c6-8f7c-419f-8757-e2ccf1c84500/public)

<!-- dash-content-start -->

[OpenAuth](https://openauth.js.org/) is a universal provider for managing user authentication. By deploying OpenAuth on Cloudflare Workers, you can add scalable authentication to your application. This implementation includes advanced user management capabilities with admin roles, CRUD operations, and automated CI/CD workflows.

<!-- dash-content-end -->

## ✨ Features

- **🔐 Authentication**: Secure email-based authentication using OpenAuth
- **👥 User Management**: Complete admin panel for user CRUD operations
- **🛡️ Role-Based Access**: Support for admin and user roles
- **🔄 Password Reset**: Admin-initiated password reset functionality
- **🚀 CI/CD**: Automated deployments with preview environments
- **📊 Monitoring**: Built-in observability and logging

## 🗺️ Project Roadmap & V1.0

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

## 🌐 Live Deployments

- **Production**: [https://al-ummah-now-auth.alummahnow.workers.dev](https://al-ummah-now-auth.alummahnow.workers.dev)
- **Admin Panel**: [https://al-ummah-now-auth.alummahnow.workers.dev/admin](https://al-ummah-now-auth.alummahnow.workers.dev/admin)
- **Preview**: Available for each pull request (auto-generated)

## 🚀 Quick Start

### Using the Development Script

```bash
# Make the script executable and install dependencies
chmod +x dev.sh
./dev.sh install

# Start local development
./dev.sh dev

# Run tests
./dev.sh test

# Deploy to preview
./dev.sh deploy:preview
```

### Manual Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Create D1 database**:
   ```bash
   npx wrangler d1 create al-ummah-now-d1
   ```
   Update the `database_id` in `wrangler.json`

3. **Create KV namespace**:
   ```bash
   npx wrangler kv namespace create AUTH_STORAGE
   ```
   Update the `id` in `wrangler.json`

4. **Run migrations**:
   ```bash
   npx wrangler d1 migrations apply AUTH_DB --remote
   ```

5. **Deploy**:
   ```bash
   npm run deploy
   ```

## 🔧 Development

### Local Development
```bash
npm run dev                 # Start local server
npm run dev:preview        # Start with preview config
```

### Testing
```bash
npm run test               # Run all tests
npm run check              # TypeScript + dry-run
```

### Deployment
```bash
npm run deploy:preview     # Deploy to preview
npm run deploy             # Deploy to production
```

## 🏗️ CI/CD Workflow

The project includes automated GitHub Actions workflows:

### 🔄 Continuous Integration
- **Triggers**: Every push and pull request
- **Actions**: TypeScript validation, dependency audit, security checks
- **Tests**: API validation, migration checks, documentation validation

### 🚀 Preview Deployments
- **Triggers**: Pull requests
- **Environment**: Isolated preview environment
- **URL**: Auto-posted as PR comment
- **Database**: Separate preview database

### 📦 Production Deployments
- **Triggers**: Merges to main branch
- **Environment**: Production environment
- **Migrations**: Automatically applied before deployment
- **Monitoring**: Full observability enabled

### Setup CI/CD
1. **Add GitHub Secrets**:
   - `CLOUDFLARE_API_TOKEN`: Your Cloudflare API token
   - `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID

2. **Push code**: CI/CD will automatically trigger

See [CICD.md](./CICD.md) for detailed CI/CD documentation.

## 👥 User Management

### Admin Features
- **User CRUD**: Create, read, update, delete users
- **Role Management**: Assign admin/user roles
- **Password Reset**: Send reset emails to users
- **User Overview**: View all users with details

### Access the Admin Panel
1. **Login** with your email (first user becomes admin)
2. **Navigate** to `/admin`
3. **Authenticate** with your admin email
4. **Manage** users through the interface

See [USER_MANAGEMENT.md](./USER_MANAGEMENT.md) for detailed documentation.

## 🔒 Security

- **Role-based authorization** for admin endpoints
- **Email-based authentication** for admin access
- **Isolated preview environments** for testing
- **Dependency auditing** in CI/CD
- **Secret scanning** to prevent credential leaks

## 📚 Documentation

### Core Documentation
- [**🗺️ Roadmap**](./ROADMAP.md) - Strategic roadmap and feature planning
- [**🏗️ Architecture**](./ARCHITECTURE.md) - Technical architecture and system design
- [**🔐 Authentication Flows**](./AUTHENTICATION_FLOWS.md) - Detailed authentication documentation
- [**👥 User Management**](./USER_MANAGEMENT.md) - Complete user management guide
- [**🚀 CI/CD Setup**](./CICD.md) - Deployment and workflow documentation

### API Reference
- [**API Endpoints**](./USER_MANAGEMENT.md#api-endpoints) - REST API documentation
- [**Live API Docs**](https://al-ummah-now-auth.alummahnow.workers.dev/docs) - Interactive documentation

### Community
- [**Issue Templates**](./.github/ISSUE_TEMPLATE/) - Bug reports, feature requests, and documentation
- [**Contributing Guidelines**](#-contributing) - How to contribute to the project

## 🛠️ Development Scripts

The `dev.sh` script provides convenient commands:

```bash
./dev.sh help              # Show all available commands
./dev.sh install           # Install dependencies
./dev.sh test              # Run tests
./dev.sh dev               # Start development server
./dev.sh deploy:preview    # Deploy to preview
./dev.sh migrate preview   # Run migrations
./dev.sh logs production   # Tail production logs
./dev.sh status            # Show deployment status
```

## 🔍 Monitoring & Debugging

- **Logs**: `wrangler tail` or `./dev.sh logs [env]`
- **Deployments**: GitHub Actions or Cloudflare dashboard
- **Database**: D1 console in Cloudflare dashboard
- **Observability**: Built-in Cloudflare analytics

## 🤝 Contributing

1. **Fork** the repository
2. **Create** a feature branch
3. **Make** your changes
4. **Test** using preview deployment
5. **Submit** a pull request

The CI/CD workflow will automatically:
- Run tests on your changes
- Deploy a preview environment
- Post the preview URL in your PR

## 📄 License

This project is licensed under the MIT License.
