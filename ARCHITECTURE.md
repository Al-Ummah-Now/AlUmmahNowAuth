# Al Ummah Now Auth - Architecture Documentation

This document provides a comprehensive technical overview of the Al Ummah Now Authentication service architecture, built on Cloudflare Workers with OpenAuth.

## 🏗️ System Architecture Overview

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Client Apps   │    │   Load Balancer  │    │  Cloudflare     │
│                 │◄──►│   (Cloudflare)   │◄──►│  Workers        │
│ - Web Apps      │    │                  │    │  Runtime        │
│ - Mobile Apps   │    └──────────────────┘    └─────────────────┘
│ - APIs          │                                      │
└─────────────────┘                                      ▼
                                              ┌─────────────────┐
┌─────────────────┐    ┌──────────────────┐    │   OpenAuth      │
│   Admin Panel   │    │   Email Service  │    │   Core          │
│                 │◄──►│   (Resend API)   │◄──►│                 │
│ - User CRUD     │    │                  │    │ - Auth Flows    │
│ - Role Mgmt     │    └──────────────────┘    │ - Session Mgmt  │
│ - Analytics     │                            │ - Provider API  │
└─────────────────┘                            └─────────────────┘
                                                        │
                                                        ▼
                                              ┌─────────────────┐
                                              │   Data Layer    │
                                              │                 │
                                              │ ┌─────────────┐ │
                                              │ │ D1 Database │ │
                                              │ │ (SQLite)    │ │
                                              │ └─────────────┘ │
                                              │ ┌─────────────┐ │
                                              │ │ KV Storage  │ │
                                              │ │ (Sessions)  │ │
                                              │ └─────────────┘ │
                                              │ ┌─────────────┐ │
                                              │ │ Secrets     │ │
                                              │ │ Store       │ │
                                              │ └─────────────┘ │
                                              └─────────────────┘
```

## 🧩 Core Components

### 1. OpenAuth Core
**Technology**: OpenAuth library on Cloudflare Workers  
**Purpose**: Handles authentication flows, session management, and OAuth protocols

**Key Features**:
- Email-based authentication with verification codes
- OAuth 2.0 / OpenID Connect compliance
- Session state management
- Provider abstraction layer

**Configuration**:
```typescript
// Core OpenAuth setup
const auth = OpenAuth({
  storage: KVStorage({
    namespace: env.AUTH_STORAGE,
  }),
  providers: {
    password: PasswordProvider(/* ... */),
  },
  theme: {
    title: "Al Ummah Now",
    primary: "#0891b2",
    favicon: "https://al-ummah-now-images.b-cdn.net/favicon_io/favicon.ico",
  },
});
```

### 2. Data Layer

#### D1 Database (SQLite)
**Purpose**: Persistent storage for user data and application state

**Schema**:
```sql
-- Users table
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  role TEXT DEFAULT 'user'
);

-- Clients table  
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### KV Storage
**Purpose**: High-performance session and state management

**Data Types**:
- Session tokens and state
- Temporary verification codes
- Rate limiting counters
- Cache data

#### Secrets Store
**Purpose**: Secure storage of sensitive configuration

**Stored Secrets**:
- `RESEND_API_KEY`: Email service authentication
- Database encryption keys (future)
- Third-party API credentials

### 3. User Management System

#### Admin Panel
**Technology**: Server-rendered HTML with vanilla JavaScript  
**Purpose**: Administrative interface for user and system management

**Features**:
- User CRUD operations
- Role assignment and management
- Password reset functionality
- System monitoring dashboard

#### REST API
**Endpoints**:
```
GET    /admin/users           # List all users
POST   /admin/users           # Create new user
GET    /admin/users/:id       # Get user details
PUT    /admin/users/:id       # Update user
DELETE /admin/users/:id       # Delete user
POST   /admin/users/:id/reset-password  # Reset password
```

**Authentication**: Bearer token (admin email for current implementation)

### 4. Email Service Integration

#### Resend API Integration
**Purpose**: Reliable email delivery for authentication codes

**Implementation**:
```typescript
async function sendCode(email: string, code: string) {
  const key = await env.RESEND_API_KEY.get();
  await SendEmail(
    key,
    "login@alummahnow.net",
    email,
    "Your login code",
    `Your login code is ${code}`
  );
}
```

## 🔐 Security Architecture

### Authentication Flow Security
1. **Email Verification**: Time-limited codes sent via secure email
2. **Session Management**: Secure tokens stored in KV with TTL
3. **HTTPS Only**: All communications encrypted in transit
4. **CSRF Protection**: Built into OpenAuth flows

### Authorization Model
```
┌─────────────┐
│    Admin    │ ── Can manage all users and system settings
└─────────────┘
       │
       ▼
┌─────────────┐
│    User     │ ── Can authenticate and access personal data
└─────────────┘
```

### Data Security
- **Encryption at Rest**: D1 database encryption
- **Secrets Management**: Cloudflare Secrets Store
- **Network Security**: Cloudflare's global network protection
- **Access Control**: Role-based permissions

## 🚀 Deployment Architecture

### Environment Strategy
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Development   │    │    Preview      │    │   Production    │
│                 │    │                 │    │                 │
│ - Local Workers │    │ - PR Deployments│    │ - Main Branch   │
│ - Miniflare     │    │ - Isolated DB   │    │ - Full Resources│
│ - Mock Services │    │ - Real Services │    │ - Monitoring    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### CI/CD Pipeline
1. **Test Stage**: TypeScript compilation, linting, unit tests
2. **Preview Stage**: Deploy to preview environment for PRs
3. **Production Stage**: Deploy to production on main branch merge
4. **Migration Stage**: Apply database migrations automatically

### Infrastructure as Code
**Configuration**: `wrangler.json`
```json
{
  "name": "al-ummah-now-auth",
  "main": "src/index.ts",
  "compatibility_date": "2024-01-15",
  "kv_namespaces": [
    { "binding": "AUTH_STORAGE", "id": "..." }
  ],
  "d1_databases": [
    { "binding": "AUTH_DB", "database_name": "al-ummah-now-d1" }
  ]
}
```

## 📊 Performance Characteristics

### Response Times
- **Authentication**: <100ms (target)
- **User Management**: <200ms (CRUD operations)
- **Session Validation**: <50ms (KV lookup)

### Scalability
- **Concurrent Users**: 100k+ supported
- **Global Deployment**: Cloudflare's edge network
- **Auto-scaling**: Serverless architecture

### Availability
- **Target Uptime**: 99.9%
- **Failover**: Automatic via Cloudflare
- **Monitoring**: Built-in observability

## 🔧 Development Architecture

### TypeScript Configuration
**File**: `tsconfig.json`
- Strict type checking enabled
- Cloudflare Workers types included
- ES2022 target for modern features

### Build Process
1. **TypeScript Compilation**: `npx wrangler deploy --dry-run`
2. **Type Generation**: `npm run types`
3. **Bundle Creation**: Wrangler builds optimized bundle
4. **Deployment**: Direct to Cloudflare Workers

### Local Development
**Tool**: Miniflare for local simulation
- Simulates all Cloudflare bindings locally
- Hot reload for rapid development
- Full debugging capabilities

## 🔄 Data Flow Diagrams

### Authentication Flow
```
Client App → Auth Service → Email Service → User
    ↓            ↓             ↓            ↓
Redirect ←── Session ←── Code Sent ←── Verify
    ↓            ↓                         ↓
Callback ←── Token ←──────────────────── Success
```

### User Management Flow
```
Admin Panel → API Endpoint → Database → Response
     ↓             ↓            ↓          ↓
  Request ──→ Validation ──→ Update ──→ Success
     ↓             ↓            ↓          ↓
 Interface ←── Error/Success ←─ Result ←─ JSON
```

## 📈 Monitoring & Observability

### Logging Strategy
- **Structured Logging**: JSON format for parsing
- **Log Levels**: Error, Warn, Info, Debug
- **Retention**: 30 days via Cloudflare

### Metrics Collection
- **Performance Metrics**: Response times, error rates
- **Business Metrics**: User registrations, login success
- **System Metrics**: Database queries, KV operations

### Alerting
- **Error Rate Thresholds**: >1% error rate
- **Performance Degradation**: >500ms response time
- **Security Events**: Multiple failed authentication attempts

## 🔮 Future Architecture Considerations

### Planned Enhancements
1. **Multi-region Database**: For improved global performance
2. **GraphQL API**: For more flexible data queries
3. **Microservices**: Split into focused services
4. **Advanced Caching**: Redis or similar for high-frequency data

### Scalability Roadmap
1. **Database Sharding**: For handling millions of users
2. **Event-Driven Architecture**: For real-time updates
3. **CDN Integration**: For static asset optimization
4. **Service Mesh**: For inter-service communication

---

*This architecture documentation is maintained alongside code changes and reviewed quarterly for accuracy and relevance.*

## Related Documentation

- [Roadmap](./ROADMAP.md)
- [Authentication Flows](./AUTHENTICATION_FLOWS.md)
- [User Management Guide](./USER_MANAGEMENT.md)
- [CI/CD Documentation](./CICD.md)