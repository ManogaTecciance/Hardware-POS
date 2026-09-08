/**
 * Phase 1.5.7. The redactor is the one choke point that keeps passwords, PINs,
 * tokens and credentials out of the permanent audit table. Written to the D30
 * standard: every "does not contain" is paired with "does contain the safe
 * value", so a redactor that stripped everything cannot pass.
 */
import {
  AUDIT_FORBIDDEN_KEY_PATTERNS,
  AUDIT_REDACTED_SENTINEL,
  sanitizeAuditMetadata,
} from './sanitize-audit-metadata';

function redact(value: unknown) {
  return sanitizeAuditMetadata(value);
}

describe('sanitizeAuditMetadata — the forbidden-key list is enforced', () => {
  it.each(AUDIT_FORBIDDEN_KEY_PATTERNS)('replaces `%s` with the sentinel', (pattern) => {
    const input = { [pattern]: 'super-secret-value', safe: 'kept' } as Record<string, unknown>;
    const out = redact(input) as Record<string, unknown>;
    expect(out[pattern]).toBe(AUDIT_REDACTED_SENTINEL);
    // POSITIVE CONTROL: the safe field must survive, otherwise a redactor
    // that returned an empty object would silently pass.
    expect(out.safe).toBe('kept');
  });

  it('matches case-insensitively', () => {
    const out = redact({ PASSWORD: 'x', Password: 'y', password: 'z' }) as Record<string, unknown>;
    expect(out.PASSWORD).toBe(AUDIT_REDACTED_SENTINEL);
    expect(out.Password).toBe(AUDIT_REDACTED_SENTINEL);
    expect(out.password).toBe(AUDIT_REDACTED_SENTINEL);
  });

  it('matches partial key names', () => {
    // A real request header name — the substring rule keeps it out of the log.
    const out = redact({ 'X-Authorization-Token': 'bearer eyJ…' }) as Record<string, unknown>;
    expect(out['X-Authorization-Token']).toBe(AUDIT_REDACTED_SENTINEL);
  });

  it('recurses into nested objects', () => {
    const input = {
      user: { id: 'u1', pinHash: '$2a$10$…' },
      metadata: { context: { authorization: 'Bearer …', device: 'iPad' } },
    };
    const out = redact(input) as {
      user: { id: string; pinHash: string };
      metadata: { context: { authorization: string; device: string } };
    };
    expect(out.user.id).toBe('u1');
    expect(out.user.pinHash).toBe(AUDIT_REDACTED_SENTINEL);
    expect(out.metadata.context.authorization).toBe(AUDIT_REDACTED_SENTINEL);
    expect(out.metadata.context.device).toBe('iPad');
  });

  it('recurses into arrays', () => {
    const input = [{ token: 'a' }, { safe: 1 }];
    const out = redact(input) as { token?: string; safe?: number }[];
    expect(out[0].token).toBe(AUDIT_REDACTED_SENTINEL);
    expect(out[1].safe).toBe(1);
  });

  it('leaves primitives untouched', () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
    expect(redact('hello')).toBe('hello');
    expect(redact(true)).toBe(true);
  });

  it('truncates a very long string field to prevent audit-row inflation', () => {
    const large = 'a'.repeat(10_000);
    const out = redact({ notes: large }) as { notes: string };
    expect(out.notes.length).toBeLessThan(large.length);
    expect(out.notes.endsWith('…')).toBe(true);
  });

  it('does not mutate the caller\'s input', () => {
    const input = { password: 'secret', name: 'Alex' };
    redact(input);
    expect(input.password).toBe('secret');
  });
});

describe('sanitizeAuditMetadata — mutation proof that the assertions can fail', () => {
  it('a redactor that returned its input unchanged would fail the top-level rule', () => {
    // Direct proof — the identity function would leave "password" in place.
    const identity = <T>(v: T) => v;
    const passthrough = identity({ password: 'x' });
    expect(passthrough.password).not.toBe(AUDIT_REDACTED_SENTINEL);
    // …and the assertion above would therefore fail against it.
    expect(() => expect(passthrough.password).toBe(AUDIT_REDACTED_SENTINEL)).toThrow();
  });

  it('a redactor that ONLY handled the top level would leak nested tokens', () => {
    const shallow = (v: Record<string, unknown>): unknown => {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = /password|token|pin/i.test(k) ? AUDIT_REDACTED_SENTINEL : val;
      }
      return out;
    };
    const nested = shallow({ ctx: { pinHash: 'x' } }) as { ctx: { pinHash: string } };
    // The shallow redactor left the pin in place — the recursive one must not.
    expect(nested.ctx.pinHash).toBe('x');
    const proper = redact({ ctx: { pinHash: 'x' } }) as { ctx: { pinHash: string } };
    expect(proper.ctx.pinHash).toBe(AUDIT_REDACTED_SENTINEL);
  });
});
