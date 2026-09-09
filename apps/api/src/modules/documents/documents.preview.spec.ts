import { DocumentsService } from './documents.service';
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

function service() {
  const settings = new SettingsService(prismaStub);
  return new DocumentsService(prismaStub, settings, pdfStub);
}

describe('DocumentsService — A4 template preview', () => {
  const TENANT = 'tnt_1';

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
