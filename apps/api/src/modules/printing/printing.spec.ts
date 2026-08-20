import { EscPosBuilder, encode, wrap } from './escpos';
import { parseAddress } from './printer-drivers';
import { hostsOf, isPrivateV4 } from './printer-discovery.service';
import { renderKotTicket, trimQty } from './templates/kot.template';
import { renderBill } from './templates/bill.template';

/**
 * D67 — the bytes that reach a printer, and the address maths around them.
 *
 * These are asserted as REAL BYTES, not as a rendered string: a template
 * that silently stopped emitting the double-size command would still read
 * fine as text, and the kitchen would get a ticket nobody can see from the
 * pass. Every positive is paired with a negative that would catch the
 * cheapest wrong implementation.
 */

const text = (buf: Buffer) => buf.toString('latin1');

describe('EscPosBuilder', () => {
  it('emits the ESC/POS control bytes each command is defined as', () => {
    const bytes = [...new EscPosBuilder(48).init().bold(true).doubleSize(true).cut().build()];
    // ESC @ | ESC E 1 | GS ! 0x11 | ESC d 3 | GS V B 0
    expect(bytes).toEqual([
      0x1b, 0x40, 0x1b, 0x45, 0x01, 0x1d, 0x21, 0x11, 0x1b, 0x64, 0x03, 0x1d, 0x56, 0x42, 0x00,
    ]);
  });

  it('row() right-aligns the value to the paper width', () => {
    const line = text(new EscPosBuilder(24).row('Subtotal', '1,200.00').build()).replace('\n', '');
    expect(line).toHaveLength(24);
    expect(line.endsWith('1,200.00')).toBe(true);
    expect(line.startsWith('Subtotal')).toBe(true);
  });

  it('row() sacrifices the LABEL, never the money, when they cannot both fit', () => {
    const line = text(
      new EscPosBuilder(16).row('An extremely long item label', '9,999.00').build(),
    ).trim();
    expect(line.endsWith('9,999.00')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(16);
  });

  it('wraps long text instead of truncating it', () => {
    // A dropped modifier is a wrong order; the line must survive in full.
    const lines = wrap('Grilled chicken with extra cheese and no onions please', 20);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toContain('no onions please');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
  });

  it('transliterates accents and marks the truly unprintable, never dropping silently', () => {
    expect(String.fromCharCode(...encode('Crème'))).toBe('Creme');
    // A glyph with no CP437 equivalent becomes '?' — visible on paper.
    expect(String.fromCharCode(...encode('අ'))).toBe('?');
  });
});

describe('renderKotTicket', () => {
  const base = {
    ticketNumber: 'KOT-000123',
    stationName: 'Grill',
    orderNumber: 'RO-000045',
    placeLabel: 'T4 · Main Hall',
    roundNumber: 2,
    waiterName: 'Nimal',
    createdAt: new Date('2026-08-18T18:42:00'),
    isReprint: false,
    items: [
      {
        name: 'Beef Steak',
        variantName: 'MEDIUM',
        quantity: '2.000',
        modifierNames: ['Extra cheese'],
        specialInstructions: 'No onions',
      },
    ],
  };

  it('prints station, ticket, place, item, variant, modifier and instruction', () => {
    const out = text(renderKotTicket(base));
    for (const fragment of [
      'GRILL',
      'KOT-000123',
      'RO-000045',
      'T4',
      'Main Hall',
      '2x Beef Steak',
      '[MEDIUM]',
      '+ Extra cheese',
      '! No onions',
      'Round 2',
      'Nimal',
    ]) {
      expect(out).toContain(fragment);
    }
    // Quantity is trimmed for the kitchen: "2", never "2.000".
    expect(out).not.toContain('2.000x');
  });

  it('marks a reprint, and does NOT mark a first print', () => {
    expect(text(renderKotTicket({ ...base, isReprint: true }))).toContain('*** REPRINT ***');
    expect(text(renderKotTicket(base))).not.toContain('REPRINT');
  });

  it('trimQty keeps meaningful decimals', () => {
    expect(trimQty('2.000')).toBe('2');
    expect(trimQty('1.500')).toBe('1.5');
    expect(trimQty('3')).toBe('3');
  });
});

describe('renderBill', () => {
  const base = {
    companyName: 'Axlo Restaurant',
    addressLine: '12 Marine Drive',
    phone: '011 555 0100',
    taxNumber: 'VAT-9',
    currency: 'LKR',
    footer: 'Thank you',
    saleNumber: 'S-000021',
    placeLabel: 'Table T4',
    staffName: 'Nimal',
    closedAt: new Date('2026-08-18T20:10:00'),
    copyLabel: null,
    items: [
      { name: 'Beef Steak', variantName: 'MEDIUM', quantity: '2.000', lineTotal: '6400.00' },
    ],
    subtotal: '6400.00',
    serviceCharge: '640.00',
    packagingCharge: '0.00',
    tax: '0.00',
    total: '7040.00',
    paid: '7040.00',
    balance: '0.00',
    payments: [{ method: 'CASH', amount: '7040.00' }],
  };

  it('prints the settled document: header, line, charged totals and payment', () => {
    const out = text(renderBill(base));
    for (const fragment of [
      'Axlo Restaurant',
      'S-000021',
      'Beef Steak (MEDIUM)',
      'LKR 6400.00',
      'Service charge',
      'TOTAL',
      'LKR 7040.00',
      'CASH',
      'Thank you',
    ]) {
      expect(out).toContain(fragment);
    }
  });

  it('omits zero charge rows but SHOWS an outstanding balance', () => {
    const out = text(renderBill(base));
    expect(out).not.toContain('Packaging');
    expect(out).not.toContain('BALANCE DUE');

    const unpaid = text(renderBill({ ...base, paid: '0.00', balance: '7040.00', payments: [] }));
    expect(unpaid).toContain('BALANCE DUE');
  });

  it('never invents money — it prints exactly the figures it is given', () => {
    // The settlement document owns the maths (D52/D59). A template that
    // recomputed anything would drift from the screen; this pins that the
    // total is passed through verbatim rather than derived from the lines.
    const odd = text(renderBill({ ...base, total: '1.23' }));
    expect(odd).toContain('LKR 1.23');
  });
});

describe('address + network helpers', () => {
  it('parses host:port and defaults to the 9100 raw ESC/POS port', () => {
    expect(parseAddress('192.168.1.50:9100')).toEqual({ host: '192.168.1.50', port: 9100 });
    expect(parseAddress('192.168.1.50')).toEqual({ host: '192.168.1.50', port: 9100 });
    expect(parseAddress('printer.local:6001')).toEqual({ host: 'printer.local', port: 6001 });
    // Garbage port falls back rather than producing NaN and a hung connect.
    expect(parseAddress('192.168.1.50:abc')).toEqual({ host: '192.168.1.50:abc', port: 9100 });
  });

  it('only ever scans private ranges', () => {
    for (const ip of ['10.0.0.4', '172.16.5.9', '192.168.8.20']) {
      expect({ ip, private: isPrivateV4(ip) }).toEqual({ ip, private: true });
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '203.0.113.7']) {
      expect({ ip, private: isPrivateV4(ip) }).toEqual({ ip, private: false });
    }
  });

  it('enumerates .1–.254 of a /24 — never the network or broadcast address', () => {
    const hosts = hostsOf('192.168.8.0/24');
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe('192.168.8.1');
    expect(hosts[253]).toBe('192.168.8.254');
    expect(hosts).not.toContain('192.168.8.0');
    expect(hosts).not.toContain('192.168.8.255');
  });
});
