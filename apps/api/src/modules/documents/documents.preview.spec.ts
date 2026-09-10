import { DocumentsService } from './documents.service';
import { BUSINESS_TYPE_VALUES, domainFor, type BusinessType } from '@hardware-pos/shared';

import { SettingsService } from '../settings/settings.service';

/**
 * Prisma stub.
 *
 * D141 — the preview path now makes exactly ONE query: the tenant's own name,
 * used as the letterhead when a workspace has not set a business name. The
 * comment here used to say the path never touches the database, and leaving
 * that in place would have made the next person trust it.
 *
 * `null` deliberately, not a name: it exercises the neutral fallback, so a
 * regression that reintroduced a hard-coded vertical would show up in the
 * assertion below rather than being masked by a stubbed name.
 */
const prismaStub = {
  tenantSettings: { findMany: jest.fn(async () => []) },
  tenant: { findUnique: jest.fn(async () => null) },
} as any;
const pdfStub = { available: true, htmlToPdf: jest.fn(async () => null) } as any;

/**
 * D142 — the tenant's vertical, switchable per test.
 *
 * The preview's sample goods come from the domain registry now, so the
 * business type is an INPUT to what gets rendered. Defaults to HARDWARE,
 * which is what every preview showed before D142.
 */
let businessType: BusinessType = 'HARDWARE';
const profilesStub = {
  getEffectiveProfile: jest.fn(async () => ({ businessType })),
} as any;

function service() {
  const settings = new SettingsService(prismaStub);
  return new DocumentsService(prismaStub, settings, pdfStub, profilesStub);
}

describe('DocumentsService — A4 template preview', () => {
  const TENANT = 'tnt_1';

  beforeEach(() => {
    businessType = 'HARDWARE';
  });

  it('renders LKR (Rs.) amounts, never $', async () => {
    const html = await service().previewHtml(TENANT, 'quotation');
    expect(html).toContain('Rs.');
    expect(html).not.toContain('$');
  });

  it('D141 — falls back to a neutral name, never a vertical', async () => {
    /*
     * The bug this fixes: a retail owner opening Preview saw a quotation
     * headed "Hardware POS", because that literal was the fallback for any
     * workspace that had not filled its business name in — which is every
     * workspace that has not been through Settings yet.
     *
     * Paired: the configured name must still win, or this would pass for a
     * preview that ignored the operator's own letterhead entirely.
     */
    const svc = service();
    const unset = await svc.previewHtml(TENANT, 'quotation');
    expect(unset).not.toContain('Hardware POS');
    expect(unset).toContain('Your Business');

    const named = await svc.previewHtml(TENANT, 'quotation', { companyName: 'Kandy Apparel' });
    expect(named).toContain('Kandy Apparel');
    expect(named).not.toContain('Your Business');
  });

  it('uses the right title/number per document type', async () => {
    const svc = service();
    expect(await svc.previewHtml(TENANT, 'quotation')).toContain('QT-2026-000124');
    expect(await svc.previewHtml(TENANT, 'invoice')).toContain('INV-2026-004821');
    expect(await svc.previewHtml(TENANT, 'return')).toContain('RET-2026-000317');
  });

  it('honours the tax-column toggle', async () => {
    const svc = service();
    const withTax = await svc.previewHtml(TENANT, 'invoice', { showTaxColumn: true });
    const noTax = await svc.previewHtml(TENANT, 'invoice', { showTaxColumn: false });
    expect(withTax).toContain('>Tax<');
    expect(noTax).not.toContain('>Tax<');
  });

  it('applies the configured accent colour', async () => {
    const html = await service().previewHtml(TENANT, 'quotation', { accentColor: '#ff8800' });
    expect(html).toContain('--brand:#ff8800');
  });

  it('emits the page-number CSS only when enabled', async () => {
    const svc = service();
    expect(await svc.previewHtml(TENANT, 'invoice', { showPageNumbers: true })).toContain('counter(pages)');
    expect(await svc.previewHtml(TENANT, 'invoice', { showPageNumbers: false })).not.toContain('counter(pages)');
  });

  it('produces a row per sample line (supports many rows for multi-page)', async () => {
    const html = await service().previewHtml(TENANT, 'invoice', {}, 30);
    const rows = (html.match(/<tr>/g) ?? []).length;
    // 1 header row + 30 body rows
    expect(rows).toBeGreaterThanOrEqual(31);
  });

  it('hides the customer tax number when disabled', async () => {
    const svc = service();
    expect(await svc.previewHtml(TENANT, 'invoice', { showCustomerTaxNumber: true })).toContain('134567890-7000');
    expect(await svc.previewHtml(TENANT, 'invoice', { showCustomerTaxNumber: false })).not.toContain('134567890-7000');
  });

  describe('signature blocks', () => {
    it('renders the full sign-off chain in order', async () => {
      const html = await service().previewHtml(TENANT, 'invoice', { signatureFields: true });
      const labels = ['Authorized signature', 'Checked by', 'Approved by', 'Customer signature'];
      const positions = labels.map((l) => html.indexOf(l));
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect((html.match(/class="sign"/g) ?? []).length).toBe(4);
    });

    it('drops every block when signature fields are disabled', async () => {
      const html = await service().previewHtml(TENANT, 'invoice', { signatureFields: false });
      for (const l of ['Checked by', 'Approved by', 'Customer signature']) {
        expect(html).not.toContain(l);
      }
      expect(html).not.toContain('class="signs"');
    });

    it('applies to every document type', async () => {
      const svc = service();
      for (const type of ['quotation', 'invoice', 'return', 'exchange'] as const) {
        const html = await svc.previewHtml(TENANT, type, { signatureFields: true });
        expect(html).toContain('Checked by');
        expect(html).toContain('Approved by');
      }
    });
  });

  describe('invoice note', () => {
    const NOTE = 'Items need to be returned within 7 days.';

    it('prints below the footer on invoices, and only when set', async () => {
      const svc = service();
      const html = await svc.previewHtml(TENANT, 'invoice', { billNote: NOTE });
      expect(html).toContain(NOTE);
      // Below the footer, not above it.
      expect(html.indexOf('class="billnote"')).toBeGreaterThan(html.indexOf('class="foot"'));
      // The stylesheet always carries the rule; only the div is conditional.
      expect(await svc.previewHtml(TENANT, 'invoice', { billNote: '' })).not.toContain('class="billnote"');
    });

    it('stays off non-invoice documents', async () => {
      const svc = service();
      for (const type of ['quotation', 'return', 'exchange'] as const) {
        expect(await svc.previewHtml(TENANT, type, { billNote: NOTE })).not.toContain(NOTE);
      }
    });

    it('escapes HTML and keeps author line breaks', async () => {
      const html = await service().previewHtml(TENANT, 'invoice', { billNote: 'A & B\n<script>x</script>' });
      expect(html).toContain('A &amp; B');
      expect(html).not.toContain('<script>x</script>');
      expect(html).toMatch(/class="billnote">[^<]*A &amp; B<br/);
    });
  });
});

/**
 * D142 — a document preview is illustrated with the tenant's own trade.
 *
 * ## What makes these assertions non-vacuous
 *
 * The change moves a hard-coded list out of this service and into the domain
 * registry. The risk that matters is not that retail fails to get its own goods
 * — that is the visible half anyone would test — it is that **hardware's
 * preview changes** while nobody is looking, because hardware belongs to
 * another team and its eight lines were relocated rather than rewritten.
 *
 * So hardware is pinned item by item, on the rendered HTML, in the same
 * expectation that proves retail differs. A test that only checked "retail sees
 * clothing" would pass just as happily with hardware's preview destroyed.
 *
 * The registry walk is an exact map over BUSINESS_TYPE_VALUES, so a business
 * type added later arrives here by name rather than silently inheriting
 * whichever list it happens to resolve to.
 */
describe('D142 — sample goods come from the tenant’s vertical', () => {
  const TENANT = 'tnt_1';

  /** Hardware's eight lines, as they were before D142 moved them. */
  const HARDWARE_NAMES = [
    'Portland Cement 50kg',
    'TMT Steel Bar 12mm (per length)',
    'PVC Pipe 2 inch — 6m',
    'Weathershield Emulsion Paint 4L',
    'Door Lock Set — Stainless',
    'Electrical Wire 1mm (per metre)',
    'Angle Grinder 4 inch 720W',
    'Safety Gloves — Nitrile',
  ];

  it('a hardware workspace previews exactly what it always did', async () => {
    businessType = 'HARDWARE';
    // Eight lines so every item is rendered, and the SKU column turned on:
    // `5.10` made it off-by-default, and the SKUs are half of what proves
    // the rows are the original ones rather than same-named replacements.
    const html = await service().previewHtml(TENANT, 'quotation', { showSku: true }, 8);

    for (const name of HARDWARE_NAMES) {
      expect(html).toContain(name);
    }
    // …and their SKUs and a price, so a list that kept the names while losing
    // the rest of each row would still fail.
    expect(html).toContain('CEM-50');
    expect(html).toContain('GLOV-STD');
    expect(html).toContain('2,650.00');
  });

  it('a retail workspace previews clothing and groceries instead', async () => {
    businessType = 'RETAIL';
    const html = await service().previewHtml(TENANT, 'quotation', {}, 8);

    // POSITIVE — both halves of what RETAIL covers.
    expect(html).toContain('Cotton Shirt');
    expect(html).toContain('Basmati Rice');
    // NEGATIVE — and none of the trade it used to show. This is the reported
    // defect, written as an assertion.
    for (const name of HARDWARE_NAMES) {
      expect(html).not.toContain(name);
    }
  });

  it('a vertical that declares nothing gets neutral filler, never another trade', async () => {
    /*
     * GENERAL declares no sample items. The fallback must not be hardware's
     * list — that would rebuild the exact defect one level down, and every
     * future vertical would inherit it too.
     */
    businessType = 'GENERAL';
    const html = await service().previewHtml(TENANT, 'quotation', {}, 6);

    expect(html).toContain('Standard Item 1');
    expect(html).toContain('Standard Item 2');
    for (const name of HARDWARE_NAMES) {
      expect(html).not.toContain(name);
    }
    expect(html).not.toContain('Cotton Shirt');
  });

  it('the whole registry is mapped, so a new business type cannot inherit silently', async () => {
    const svc = service();
    const seen: Record<string, string> = {};

    for (const type of BUSINESS_TYPE_VALUES) {
      businessType = type;
      const html = await svc.previewHtml(TENANT, 'quotation', {}, 6);
      seen[type] = html.includes('Portland Cement 50kg')
        ? 'HARDWARE'
        : html.includes('Cotton Shirt')
          ? 'RETAIL'
          : 'NEUTRAL';
    }

    expect(seen).toEqual({
      HARDWARE: 'HARDWARE',
      RETAIL: 'RETAIL',
      // Food service never renders the A4 preview at all (D96/D140); it is
      // walked here anyway so that changing its descriptor shows up.
      RESTAURANT: 'NEUTRAL',
      CAFE: 'NEUTRAL',
      BAKERY: 'NEUTRAL',
      HOTEL: 'NEUTRAL',
      GENERAL: 'NEUTRAL',
    });
    expect(Object.keys(seen)).toHaveLength(BUSINESS_TYPE_VALUES.length);
  });

  it('the descriptor is the source, not a copy that happens to agree', async () => {
    // Compared against the registry itself, so a list edited in the descriptor
    // and forgotten here fails rather than drifting.
    for (const type of ['HARDWARE', 'RETAIL'] as const) {
      businessType = type;
      const declared = domainFor(type).catalogue.sampleItems;
      expect(declared).toBeDefined();
      const html = await service().previewHtml(TENANT, 'quotation', { showSku: true }, 8);
      for (const item of declared!) {
        expect(html).toContain(item.sku);
      }
    }
  });

  describe('the resolution can actually fail', () => {
    it('M1: pointing retail at hardware’s list is caught', async () => {
      /*
       * The mutation: retail resolves to hardware's goods — which is the state
       * of the world before D142. Written out rather than described, and the
       * shipped resolver asserted to differ from it.
       */
      const hardwareList = domainFor('HARDWARE').catalogue.sampleItems!;
      const retailList = domainFor('RETAIL').catalogue.sampleItems!;

      expect(retailList.map((i) => i.name)).not.toEqual(hardwareList.map((i) => i.name));
      expect(hardwareList.map((i) => i.name)).toEqual(HARDWARE_NAMES);
    });

    it('M2: a hardware fallback would reach every undeclared vertical', async () => {
      /*
       * The tempting simplification — keep the old list as the default instead
       * of a neutral one. It looks harmless because hardware and retail both
       * declare their own; it bites GENERAL and every vertical added later.
       */
      businessType = 'GENERAL';
      const html = await service().previewHtml(TENANT, 'quotation', {}, 6);
      expect(domainFor('GENERAL').catalogue.sampleItems).toBeUndefined();
      expect(html).not.toContain('Portland Cement 50kg');
      expect(html).toContain('Standard Item 1');
    });
  });
});
