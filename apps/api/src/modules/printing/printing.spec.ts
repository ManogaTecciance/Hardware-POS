import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KitchenPrinterKind } from '@hardware-pos/database';

import { EscPosBuilder, encode, wrap } from './escpos';
import { createServer, type Server } from 'node:net';

import { parseAddress, probeEscPos, sendToPrinter } from './printer-drivers';
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

  it('keeps an indent on every wrapped line — a long note stays under its dish', () => {
    const lines = wrap('      + extra cheese and no onions and extra sauce please', 30);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith('      ')).toBe(true);
      expect(line.length).toBeLessThanOrEqual(30);
    }
    expect(lines.join(' ').replace(/\s+/g, ' ').trim()).toBe(
      '+ extra cheese and no onions and extra sauce please',
    );
    // NEGATIVE — an unindented line gains no indent.
    expect(wrap('plain', 30)).toEqual(['plain']);
  });

  it('transliterates accents and marks the truly unprintable, never dropping silently', () => {
    expect(String.fromCharCode(...encode('Crème'))).toBe('Creme');
    // A glyph with no CP437 equivalent becomes '?' — visible on paper.
    expect(String.fromCharCode(...encode('අ'))).toBe('?');
  });
});

describe('renderKotTicket — the industry layout (D174)', () => {
  const base = {
    ticketNumber: 'KOT-000123',
    stationName: 'Grill',
    orderNumber: 'RO-000045',
    orderType: 'DINE_IN' as const,
    tableCode: 'T4',
    areaName: 'Main Hall',
    customerName: null,
    roundNumber: 2,
    waiterName: 'Nimal',
    createdAt: new Date('2026-08-18T18:42:00'),
    isReprint: false,
    items: [
      {
        name: 'Beef Steak',
        variantName: 'Medium',
        quantity: '2.000',
        modifierNames: ['Extra cheese'],
        specialInstructions: 'No onions',
      },
      { name: 'Fried Rice', variantName: null, quantity: '1.000', modifierNames: [], specialInstructions: null },
    ],
  };
  const DOUBLE_SIZE = Buffer.from([0x1d, 0x21, 0x11]);
  const DOUBLE_HEIGHT = Buffer.from([0x1d, 0x21, 0x01]);
  const SIZE_OFF = Buffer.from([0x1d, 0x21, 0x00]);
  const BOLD_ON = Buffer.from([0x1b, 0x45, 0x01]);

  it('leads with the order type and the table as the biggest text, then the rest smaller', () => {
    const buf = renderKotTicket(base);
    const out = text(buf);
    // Order type and table come first, and they are the ONLY double-size text.
    const big = out.slice(out.indexOf(text(DOUBLE_SIZE)) + 3, out.indexOf(text(SIZE_OFF)));
    expect(big).toContain('DINE IN');
    expect(big).toContain('TABLE T4');
    expect(big).not.toContain('Beef Steak');
    expect(out.indexOf('DINE IN')).toBeLessThan(out.indexOf('KOT-000123'));
    // The area, the ticket, the stamp, the order, the round, the server, the station.
    for (const fragment of [
      'Main Hall',
      'KOT-000123',
      '18/08/2026 06:42 PM',
      'Order RO-000045',
      'Round 2',
      'Server: Nimal',
      'Station: Grill',
    ]) {
      expect(out).toContain(fragment);
    }
  });

  it('prints quantity first and the item in double HEIGHT — never double width', () => {
    const buf = renderKotTicket(base);
    const out = text(buf);
    expect(out).toContain('2   Beef Steak');
    expect(out).toContain('1   Fried Rice');
    // Double height wraps at the roll's full width; double width would halve
    // it without telling the wrapper. Each item line is preceded by the
    // height command, and the size command never appears after the header.
    const afterHeader = out.slice(out.indexOf('KOT-000123'));
    expect(afterHeader).toContain(text(DOUBLE_HEIGHT));
    expect(afterHeader).not.toContain(text(DOUBLE_SIZE));
    expect(out).not.toContain('2.000');
  });

  it('types what sits under an item: variant plain in capitals, modifier with +, instruction >> in bold capitals', () => {
    const out = text(renderKotTicket(base));
    expect(out).toContain('      MEDIUM');
    expect(out).toContain('      + Extra cheese');
    expect(out).toContain(`${text(BOLD_ON)}      >> NO ONIONS`);
  });

  it('separates items with a blank line and counts them at the foot', () => {
    const out = text(renderKotTicket(base));
    // The blank line sits between the first item's last note and the second item.
    expect(out).toMatch(/>> NO ONIONS\n\x1b\x45\x00\n/);
    expect(out).toContain('3 ITEMS');
    const one = renderKotTicket({ ...base, items: [base.items[1]!] });
    expect(text(one)).toContain('1 ITEM');
    expect(text(one)).not.toContain('1 ITEMS');
  });

  it('a takeaway leads with TAKEAWAY and the order number, and names the customer', () => {
    const out = text(
      renderKotTicket({
        ...base,
        orderType: 'TAKEAWAY',
        tableCode: null,
        areaName: null,
        customerName: 'Nimal Perera',
      }),
    );
    expect(out).toContain('TAKEAWAY');
    expect(out).toContain('#RO-000045');
    expect(out).toContain('Nimal Perera');
    expect(out).not.toContain('TABLE');
    expect(out).not.toContain('DINE IN');
    // On a takeaway the order number is the headline, so the meta line does not repeat it.
    expect(out).not.toContain('Order RO-000045');
  });

  it('wraps a long dish name at our word boundary, continuation lines under the name', () => {
    const out = text(
      renderKotTicket({
        ...base,
        items: [{ ...base.items[0]!, name: 'Chicken Fried Rice With Extra Cheese And Peppers' }],
      }),
    );
    expect(out).toContain('2   Chicken Fried Rice With Extra Cheese And');
    expect(out).toContain('    Peppers');
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

describe('sendToPrinter — ESC_POS_USB', () => {
  const target = (address: string) => ({
    id: 'p1',
    name: 'USB printer',
    kind: KitchenPrinterKind.ESC_POS_USB,
    address,
    columns: 48,
  });

  /**
   * A USB printer is a device node, and a device node is opened for APPEND:
   * two documents sent in a row must both arrive, in order. Asserted against
   * a real file rather than a mocked `fs`, so a change of flags to 'w' —
   * which would silently discard the first ticket of every pair — fails here.
   */
  it('appends each document, so a second print does not erase the first', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'axlo-usb-')), 'lp0');

    expect(await sendToPrinter(target(path), Buffer.from('TICKET-ONE'))).toEqual({ ok: true });
    expect(await sendToPrinter(target(path), Buffer.from('TICKET-TWO'))).toEqual({ ok: true });

    expect(readFileSync(path, 'latin1')).toBe('TICKET-ONETICKET-TWO');
  });

  it('reports an unreachable device as a failure instead of throwing', async () => {
    const outcome = await sendToPrinter(target('/definitely/not/a/device/lp0'), Buffer.from('x'));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('/definitely/not/a/device/lp0');
  });
});

/**
 * D174 — the test print asks whether the thing on port 9100 is a receipt
 * printer at all. Two real listeners on loopback stand in for the two kinds
 * of device: one answers DLE EOT with a status byte the way an ESC/POS
 * printer does; one accepts the bytes and says nothing, the way the Canon
 * inkjet that prompted this did. The third case is nothing listening.
 */
describe('probeEscPos (D174)', () => {
  const listen = (onData: (socket: import('node:net').Socket) => void): Promise<{ server: Server; port: number }> =>
    new Promise((resolve) => {
      const server = createServer((socket) => {
        socket.on('data', () => onData(socket));
      });
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: (server.address() as { port: number }).port });
      });
    });

  it('reports ESC_POS when the device answers the status request', async () => {
    const { server, port } = await listen((socket) => socket.write(Buffer.from([0x16])));
    try {
      expect(await probeEscPos(`127.0.0.1:${port}`)).toBe('ESC_POS');
    } finally {
      server.close();
    }
  });

  it('reports SILENT when the device swallows the bytes — an office printer on 9100', async () => {
    const { server, port } = await listen(() => undefined);
    try {
      expect(await probeEscPos(`127.0.0.1:${port}`, 400)).toBe('SILENT');
    } finally {
      server.close();
    }
  });

  it('reports UNREACHABLE when nothing listens', async () => {
    // Port 9 (discard) is closed on every developer machine and CI runner.
    expect(await probeEscPos('127.0.0.1:9', 400)).toBe('UNREACHABLE');
  });

  it('MUTATION PROOF — a probe that never sent the request would still hear an answer', async () => {
    // The silent listener answers ONLY if it receives the DLE EOT bytes: a
    // probe that connected without sending them is indistinguishable from
    // the office-printer case, and this listener makes that distinction.
    let received = Buffer.alloc(0);
    const { server, port } = await listen(() => undefined);
    server.removeAllListeners('connection');
    server.on('connection', (socket) => {
      socket.on('data', (d) => {
        received = Buffer.concat([received, d]);
        if (received.equals(Buffer.from([0x10, 0x04, 0x01]))) socket.write(Buffer.from([0x16]));
      });
    });
    try {
      expect(await probeEscPos(`127.0.0.1:${port}`)).toBe('ESC_POS');
      expect([...received]).toEqual([0x10, 0x04, 0x01]);
    } finally {
      server.close();
    }
  });
});

/**
 * D174 — plain-text mode, for an office printer fed through the Windows
 * spooler as a text document. The SAME template, so the negative here is the
 * whole point: not one ESC or GS byte may reach a printer that would print
 * them as punctuation, while every word of the ticket still must.
 */
describe('plain-text rendering (D174, A4_NETWORK)', () => {
  const kot = {
    ticketNumber: 'KOT-000042',
    stationName: 'Grill',
    orderNumber: 'RO-000007',
    orderType: 'DINE_IN' as const,
    tableCode: 'T4',
    areaName: 'Terrace',
    customerName: null,
    roundNumber: 2,
    waiterName: 'Nimal',
    createdAt: new Date('2026-09-11T12:34:00'),
    isReprint: false,
    items: [
      { name: 'Chicken Kottu', variantName: 'LARGE', quantity: '2.000', modifierNames: ['Extra egg'], specialInstructions: 'no chilli' },
    ],
  };

  it('carries every word of the ticket and not one control byte', () => {
    const plain = renderKotTicket(kot, 48, { plainText: true });
    const out = text(plain);
    for (const word of ['DINE IN', 'TABLE T4', 'Terrace', 'KOT-000042', 'Order RO-000007', '2   Chicken Kottu', 'LARGE', '+ Extra egg', '>> NO CHILLI', 'Round 2', 'Server: Nimal', 'Station: Grill', '2 ITEMS']) {
      expect(out).toContain(word);
    }
    // NEGATIVE — no ESC (0x1b), no GS (0x1d), no cut; the page ends with a form feed.
    expect([...plain].some((b) => b === 0x1b || b === 0x1d)).toBe(false);
    expect(plain[plain.length - 1]).toBe(0x0c);
    // POSITIVE CONTROL — the same data as ESC/POS DOES carry them, so the
    // negative above is not passing because the template stopped emitting.
    const escpos = renderKotTicket(kot, 48);
    expect([...escpos].some((b) => b === 0x1b)).toBe(true);
    expect([...escpos].some((b) => b === 0x1d)).toBe(true);
  });

  it('centres with spaces where ESC/POS would have sent an alignment command', () => {
    const b = new EscPosBuilder(20, { plainText: true });
    b.align('center').line('MENU').align('left').line('x');
    expect(text(b.build()).split(String.fromCharCode(10))).toEqual(['        MENU', 'x', '']);
  });

  it('transliterates to ASCII only — CP437 extras would be other glyphs on a Windows printer', () => {
    const b = new EscPosBuilder(48, { plainText: true });
    b.line('café · £5 — “ok”…');
    const out = text(b.build());
    expect(out.trimEnd()).toBe('cafe - ?5 - "ok"...');
    expect([...b.build()].every((c) => c === 0x0a || (c >= 0x20 && c <= 0x7e))).toBe(true);
  });
});
