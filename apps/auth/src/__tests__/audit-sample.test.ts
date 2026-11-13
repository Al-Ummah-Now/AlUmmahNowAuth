import { describe, expect, it } from 'vitest';
import { AuditEmitter, auditSampleRate, parseAuditSample, type AuditEventSink } from '../audit-emitter';
import { AuditEventSeverity, type AuditEvent } from '../audit-events';

const event = (eventType: string, extra: Partial<AuditEvent> = {}): AuditEvent =>
  ({
    timestamp: '2026-11-13T00:00:00.000Z',
    eventType,
    severity: AuditEventSeverity.INFO,
    userId: 'u1',
    ipAddress: null,
    userAgent: null,
    requestId: null,
    metadata: {},
    success: true,
    ...extra,
  }) as AuditEvent;

const sink = (name: string, seen: string[]): AuditEventSink => ({
  name,
  async emit(e) {
    seen.push(`${name}:${e.eventType}`);
  },
});

describe('AUDIT_SAMPLE', () => {
  const rules = parseAuditSample('auth.login.success=0.1, admin.item.*=0.25, bad, x=2');

  it('parses exact and prefix rules and drops invalid ones', () => {
    expect(rules).toEqual([
      { pattern: 'auth.login.success', rate: 0.1 },
      { pattern: 'admin.item.*', rate: 0.25 },
    ]);
    expect(parseAuditSample(undefined)).toEqual([]);
  });

  it('rates matching info events and never samples warnings or failures', () => {
    expect(auditSampleRate(event('auth.login.success'), rules)).toBe(0.1);
    expect(auditSampleRate(event('admin.item.purged'), rules)).toBe(0.25);
    expect(auditSampleRate(event('rbac.role.assigned'), rules)).toBe(1);
    expect(auditSampleRate(event('admin.item.purged', { severity: AuditEventSeverity.WARNING }), rules)).toBe(1);
    expect(auditSampleRate(event('auth.login.success', { success: false }), rules)).toBe(1);
  });

  it('sends a sampled-out event to stdout only', async () => {
    const seen: string[] = [];
    const emitter = new AuditEmitter();
    emitter.addSink(sink('stdout', seen));
    emitter.addSink(sink('queue', seen));
    let roll = 0.5;
    emitter.setSampling(rules, () => roll);
    await emitter.emit(event('auth.login.success')); // 0.5 >= 0.1: stdout only
    roll = 0.05;
    await emitter.emit(event('auth.login.success')); // kept
    await emitter.emit(event('rbac.role.assigned')); // no rule: kept
    expect(seen).toEqual(['stdout:auth.login.success', 'stdout:auth.login.success', 'queue:auth.login.success', 'stdout:rbac.role.assigned', 'queue:rbac.role.assigned']);
  });
});
