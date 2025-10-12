# Claude Code Agents for Al Ummah Now

This directory contains specialized AI agents for different aspects of software development. Each agent has specific expertise and responsibilities.

## Available Agents

### 🏗️ Architecture & Design

#### **architect** (Purple, Opus)
Lead architect for system design and architecture decisions.
- Analyzes codebase and designs solutions
- Creates Architecture Decision Records (ADRs)
- Defines data models and API contracts
- Considers scalability, performance, and security

**When to use:** Complex features requiring architectural decisions

#### **api-designer** (Teal)
RESTful API design specialist.
- Designs clean, RESTful APIs
- Creates comprehensive OpenAPI 3.1 specifications
- Ensures API consistency and best practices

**When to use:** Designing new API endpoints or refactoring existing APIs

#### **ux-designer** (Pink, Opus)
UX/UI design specialist with accessibility expertise and mobile-first approach.
- **Mobile-first design (starts at 375px viewport)**
- Designs accessible, user-centered interfaces
- Ensures WCAG 2.1 compliance
- Implements Nielsen's usability heuristics
- Creates inclusive, bilingual (EN/AR) designs
- Tailwind CSS responsive patterns

**When to use:** Designing new UI features, improving UX, accessibility audits, mobile-first layouts

### 💻 Development & Implementation

#### **developer** (Blue)
Precise implementation specialist.
- Implements specs with tests
- Zero linting violations
- Comprehensive error handling
- Follows project conventions exactly

**When to use:** Implementing features from specifications

#### **ui-engineer** (Blue)
Frontend specialist for Next.js and React with mobile-first approach.
- **Mobile-first with Tailwind CSS (mandatory approach)**
- Builds responsive UIs (375px → desktop)
- Progressive enhancement with Tailwind breakpoints
- Implements bilingual support (EN/AR with RTL)
- Uses shadcn/ui components
- Ensures accessibility

**When to use:** Building frontend components and pages, mobile-first implementations

### 🔍 Quality Assurance

#### **debugger** (Cyan, Opus)
Systematic bug investigator.
- Gathers evidence through debug statements (minimum 10)
- Identifies root causes
- NEVER implements fixes (only investigates)
- Creates comprehensive bug reports

**When to use:** Complex bugs requiring systematic investigation

#### **quality-reviewer** (Orange)
Code quality and critical issues reviewer.
- Reviews for security, data loss, performance issues
- Focuses on measurable, production-impacting problems
- Ignores style preferences
- Provides actionable feedback

**When to use:** Code review before merge or deployment

#### **test-engineer** (Yellow)
Test automation specialist.
- Generates comprehensive test suites
- Creates unit, integration, and E2E tests
- Ensures test coverage
- Automates testing

**When to use:** After feature completion for test coverage

### 🔒 Security & Performance

#### **security-auditor** (Purple)
Security vulnerability specialist.
- Identifies security vulnerabilities
- Assesses risks and compliance
- Recommends fixes
- Creates audit reports

**When to use:** Security review before production deployment

#### **performance-optimizer** (Red)
Performance optimization expert.
- Profiles code and identifies bottlenecks
- Optimizes algorithms and queries
- Improves system performance
- Measures improvements

**When to use:** Performance issues or optimization needs

### 📝 Documentation

#### **technical-writer** (Green, Sonnet)
Documentation specialist.
- Creates comprehensive documentation
- Writes API docs, user guides, developer guides
- Maintains clarity and consistency

**When to use:** After feature completion for documentation

## Agent Workflow Patterns

### Feature Development Flow
```
1. architect → Design solution, create ADR
2. ux-designer → Design user interface and experience (if UI feature)
3. api-designer → Design API endpoints (if backend feature)
4. developer → Implement backend
5. ui-engineer → Implement frontend based on UX designs
6. test-engineer → Create test suite (including accessibility tests)
7. quality-reviewer → Review implementation
8. technical-writer → Document feature
```

### Bug Fix Flow
```
1. debugger → Investigate bug, gather evidence
2. developer → Implement fix based on report
3. test-engineer → Add regression tests
4. quality-reviewer → Verify fix doesn't introduce issues
```

### Security Review Flow
```
1. security-auditor → Identify vulnerabilities
2. quality-reviewer → Verify critical issues
3. developer → Implement security fixes
4. security-auditor → Re-audit and verify
```

### Performance Optimization Flow
```
1. performance-optimizer → Profile and identify bottlenecks
2. architect → Design optimization strategy (if architectural)
3. developer → Implement optimizations
4. performance-optimizer → Measure improvements
5. quality-reviewer → Ensure no regressions
```

### Accessibility Audit Flow
```
1. ux-designer → Audit accessibility (WCAG compliance)
2. ui-engineer → Fix accessibility issues
3. test-engineer → Add accessibility tests
4. ux-designer → Verify with assistive technologies
```

## How to Use Agents

### In Claude Code

Agents can be invoked by mentioning them in your prompts:

```
@architect Design a caching layer for video analytics
@developer Implement the video upload endpoint
@debugger Investigate why WebSocket connections are dropping
@quality-reviewer Review PR #42 for critical issues
@security-auditor Audit authentication implementation
@technical-writer Document the WebSocket server API
```

### Agent Properties

Each agent has:
- **name**: Unique identifier
- **description**: Brief purpose summary
- **model**: Preferred model (opus/sonnet/inherit)
- **color**: Visual categorization

## Project-Specific Context

All agents are aware of the Al Ummah Now technology stack:

**Monorepo Structure:**
- Turborepo with pnpm workspaces
- Apps: web (Next.js 15), api-videos (Hono), processor (Queue), websocket-server (Durable Objects)
- Shared: @al-ummah/shared-types

**Runtime & Infrastructure:**
- Cloudflare Workers (no Node.js APIs)
- R2 (object storage), KV (key-value), Durable Objects
- OpenAuth (JWT/OAuth2)
- Bunny.net (CDN/streaming)

**Development Standards:**
- TypeScript strict mode
- Zod validation
- OpenAPI 3.1 with chanfana
- Bilingual support (EN/AR with RTL)
- pnpm package manager

## Best Practices

1. **Use the right agent for the task** - Each agent has specific expertise
2. **Follow the workflow patterns** - Agents work best in sequence
3. **Provide context** - Reference files, PRs, or issues when invoking agents
4. **Review agent outputs** - Agents provide recommendations, you make decisions
5. **Iterate** - Use multiple agents for complex tasks

## Adding New Agents

To add a new agent:

1. Create `[agent-name].md` in this directory
2. Follow the YAML frontmatter format:
```yaml
---
name: agent-name
description: Brief description of agent's purpose
model: opus|sonnet|inherit
color: color-name
---
```
3. Include detailed instructions, patterns, and examples
4. Update this README with the new agent

## References

- [Claude Code Agents Best Practices](https://superprompt.com/blog/best-claude-code-agents-and-use-cases)
- [Agent Configuration Examples](https://github.com/solatis/claude-config/tree/main/agents)
- [Project Documentation](../CLAUDE.md)
