import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { HeartbeatDto } from './print-agent.controller';
import { PrintAgentService } from './print-agent.service';
import type { PrintDispatcherService } from './print-dispatcher.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * D183 — what the agent reports about printers, and how the server keeps it.
 *
 * The store is in memory and per branch; the only subtle rule is the one
 * that lets a 0.1.0 agent (which cannot enumerate its spooler) coexist with a
 * 0.2.0 one: a heartbeat that says nothing about local printers must not
 * erase what the other one said, while one that says "none" must.
 */

const service = () =>
  new PrintAgentService({} as unknown as PrismaService, {} as unknown as PrintDispatcherService);

const HOST = { host: '192.168.123.100', port: 9100, latencyMs: 4 };
const CANON = { name: 'Canon G3010 series', driver: 'Microsoft IPP Class Driver', port: 'WSD-1' };
const XP365 = { name: 'Xprinter XP-365B', driver: 'Xprinter XP-365B', port: 'USB002' };

describe('PrintAgentService discovery store', () => {
  it('returns null for a branch nothing has reported on', () => {
    expect(service().lastDiscovery('brn_x')).toBeNull();
  });

  it('keeps LAN hosts and local printers together, per branch', () => {
    const s = service();
    s.reportDiscovery('brn_a', 'Counter PC', [HOST], [CANON, XP365]);
    s.reportDiscovery('brn_b', 'Other PC', [], []);

    const a = s.lastDiscovery('brn_a');
    expect(a?.agentName).toBe('Counter PC');
    expect(a?.printers).toEqual([HOST]);
    expect(a?.localPrinters).toEqual([CANON, XP365]);
    expect(typeof a?.at).toBe('string');

    expect(s.lastDiscovery('brn_b')).toMatchObject({ printers: [], localPrinters: [] });
  });

  it('a report WITHOUT local printers keeps the previous list (old agent)', () => {
    const s = service();
    s.reportDiscovery('brn_a', 'New PC', [HOST], [CANON]);
    s.reportDiscovery('brn_a', 'Old PC', [HOST]);
    const latest = s.lastDiscovery('brn_a');
    expect(latest?.agentName).toBe('Old PC');
    expect(latest?.localPrinters).toEqual([CANON]);
  });

  it('a report WITH an empty list replaces the previous one (looked, found none)', () => {
    const s = service();
    s.reportDiscovery('brn_a', 'PC', [HOST], [CANON]);
    s.reportDiscovery('brn_a', 'PC', [HOST], []);
    expect(s.lastDiscovery('brn_a')?.localPrinters).toEqual([]);
  });

  it('a first report without local printers yields [] rather than undefined', () => {
    const s = service();
    s.reportDiscovery('brn_a', 'PC', [HOST]);
    expect(s.lastDiscovery('brn_a')?.localPrinters).toEqual([]);
  });
});

describe('PrintAgentService scan requests', () => {
  it('a request is handed out exactly once, to its own branch only', () => {
    const s = service();
    expect(s.takeScanRequest('brn_a')).toBe(false);
    s.requestScan('brn_a');
    expect(s.takeScanRequest('brn_b')).toBe(false);
    expect(s.takeScanRequest('brn_a')).toBe(true);
    expect(s.takeScanRequest('brn_a')).toBe(false);
  });

  it('two presses before a heartbeat collapse into one scan', () => {
    const s = service();
    s.requestScan('brn_a');
    s.requestScan('brn_a');
    expect(s.takeScanRequest('brn_a')).toBe(true);
    expect(s.takeScanRequest('brn_a')).toBe(false);
  });
});

describe('HeartbeatDto', () => {
  const validate = (body: unknown) =>
    validateSync(plainToInstance(HeartbeatDto, body), { whitelist: true, forbidNonWhitelisted: true });

  it('accepts a 0.1.0 heartbeat with no localPrinters', () => {
    expect(validate({ version: '0.1.0', discovered: [HOST] })).toHaveLength(0);
  });

  it('accepts a 0.2.0 heartbeat with local printers, null driver and port included', () => {
    expect(
      validate({
        version: '0.2.0',
        discovered: [],
        localPrinters: [CANON, { name: 'POS-80', driver: null, port: null }],
      }),
    ).toHaveLength(0);
  });

  it('rejects a local printer without a name', () => {
    const errors = validate({ localPrinters: [{ driver: 'x' }] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a name over 200 characters and more than 100 printers', () => {
    expect(validate({ localPrinters: [{ name: 'x'.repeat(201) }] }).length).toBeGreaterThan(0);
    const many = Array.from({ length: 101 }, (_, i) => ({ name: `P${i}` }));
    expect(validate({ localPrinters: many }).length).toBeGreaterThan(0);
    expect(validate({ localPrinters: many.slice(0, 100) })).toHaveLength(0);
  });
});
