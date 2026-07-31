import { DocumentsService } from './documents.service';
import { SettingsService } from '../settings/settings.service';

/** Prisma stub — the sample/preview path never touches the database. */
const prismaStub = {
  tenantSettings: { findMany: jest.fn(async () => []) },
} as any;
const pdfStub = { available: true, htmlToPdf: jest.fn(async () => null) } as any;

function service() {
  const settings = new SettingsService(prismaStub);
  return new DocumentsService(prismaStub, settings, pdfStub);
}

describe('DocumentsService — A4 template preview', () => {
  const TENANT = 'tnt_1';

  it('renders LKR (Rs.) amounts, never $', () => {
    const html = service().previewHtml(TENANT, 'quotation');
    expect(html).toContain('Rs.');
    expect(html).not.toContain('$');
  });

  it('uses the right title/number per document type', () => {
    const svc = service();
    expect(svc.previewHtml(TENANT, 'quotation')).toContain('QT-2026-000124');
    expect(svc.previewHtml(TENANT, 'invoice')).toContain('INV-2026-004821');
    expect(svc.previewHtml(TENANT, 'return')).toContain('RET-2026-000317');
  });

  it('honours the tax-column toggle', () => {
    const svc = service();
    const withTax = svc.previewHtml(TENANT, 'invoice', { showTaxColumn: true });
    const noTax = svc.previewHtml(TENANT, 'invoice', { showTaxColumn: false });
    expect(withTax).toContain('>Tax<');
    expect(noTax).not.toContain('>Tax<');
  });

  it('applies the configured accent colour', () => {
    const html = service().previewHtml(TENANT, 'quotation', { accentColor: '#ff8800' });
    expect(html).toContain('--brand:#ff8800');
  });

  it('emits the page-number CSS only when enabled', () => {
    const svc = service();
    expect(svc.previewHtml(TENANT, 'invoice', { showPageNumbers: true })).toContain('counter(pages)');
    expect(svc.previewHtml(TENANT, 'invoice', { showPageNumbers: false })).not.toContain('counter(pages)');
  });

  it('produces a row per sample line (supports many rows for multi-page)', () => {
    const html = service().previewHtml(TENANT, 'invoice', {}, 30);
    const rows = (html.match(/<tr>/g) ?? []).length;
    // 1 header row + 30 body rows
    expect(rows).toBeGreaterThanOrEqual(31);
  });

  it('hides the customer tax number when disabled', () => {
    const svc = service();
    expect(svc.previewHtml(TENANT, 'invoice', { showCustomerTaxNumber: true })).toContain('134567890-7000');
    expect(svc.previewHtml(TENANT, 'invoice', { showCustomerTaxNumber: false })).not.toContain('134567890-7000');
  });

  describe('signature blocks', () => {
    it('renders the full sign-off chain in order', () => {
      const html = service().previewHtml(TENANT, 'invoice', { signatureFields: true });
      const labels = ['Authorized signature', 'Checked by', 'Approved by', 'Customer signature'];
      const positions = labels.map((l) => html.indexOf(l));
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect((html.match(/class="sign"/g) ?? []).length).toBe(4);
    });

    it('drops every block when signature fields are disabled', () => {
      const html = service().previewHtml(TENANT, 'invoice', { signatureFields: false });
      for (const l of ['Checked by', 'Approved by', 'Customer signature']) {
        expect(html).not.toContain(l);
      }
      expect(html).not.toContain('class="signs"');
    });

    it('applies to every document type', () => {
      const svc = service();
      for (const type of ['quotation', 'invoice', 'return', 'exchange'] as const) {
        const html = svc.previewHtml(TENANT, type, { signatureFields: true });
        expect(html).toContain('Checked by');
        expect(html).toContain('Approved by');
      }
    });
  });

  describe('invoice note', () => {
    const NOTE = 'Items need to be returned within 7 days.';

    it('prints below the footer on invoices, and only when set', () => {
      const svc = service();
      const html = svc.previewHtml(TENANT, 'invoice', { billNote: NOTE });
      expect(html).toContain(NOTE);
      // Below the footer, not above it.
      expect(html.indexOf('class="billnote"')).toBeGreaterThan(html.indexOf('class="foot"'));
      // The stylesheet always carries the rule; only the div is conditional.
      expect(svc.previewHtml(TENANT, 'invoice', { billNote: '' })).not.toContain('class="billnote"');
    });

    it('stays off non-invoice documents', () => {
      const svc = service();
      for (const type of ['quotation', 'return', 'exchange'] as const) {
        expect(svc.previewHtml(TENANT, type, { billNote: NOTE })).not.toContain(NOTE);
      }
    });

    it('escapes HTML and keeps author line breaks', () => {
      const html = service().previewHtml(TENANT, 'invoice', { billNote: 'A & B\n<script>x</script>' });
      expect(html).toContain('A &amp; B');
      expect(html).not.toContain('<script>x</script>');
      expect(html).toMatch(/class="billnote">[^<]*A &amp; B<br/);
    });
  });
});
