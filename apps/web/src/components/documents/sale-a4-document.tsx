'use client';

import * as React from 'react';

import type { DocumentProfile, SaleDocumentMeta } from '@/lib/document-template-service';
import { resolveImageUrl } from '@/lib/products-api';
import type { SaleDetail } from '@/lib/sales';
import { formatMoney } from '@/lib/utils';

/**
 * Native React A4 sale invoice / final bill. Sized 210mm and print-safe:
 * `@page` A4 portrait, repeating table header, break-safe rows, totals kept
 * together, page counter, and print CSS that hides everything except the sheet.
 * LKR only (`Rs.`). Data comes from `SaleDetail` + the document profile; branch/
 * register/cashier come from `meta` (session) — see documentTemplateService TODO.
 */

const MARGIN_PADDING: Record<DocumentProfile['marginStyle'], string> = {
  COMPACT: '10mm 10mm',
  STANDARD: '16mm 15mm',
  SPACIOUS: '22mm 20mm',
};
const LOGO_HEIGHT: Record<DocumentProfile['logoSize'], number> = { SMALL: 40, MEDIUM: 56, LARGE: 78 };

const PAYMENT_LABELS: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank Transfer',
  QR_PAYMENT: 'QR Payment',
  CHECK: 'Cheque',
  STORE_CREDIT: 'Store Credit',
  OTHER: 'Other',
};

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SaleA4Document({
  sale,
  profile,
  meta,
}: {
  sale: SaleDetail;
  profile: DocumentProfile;
  meta: SaleDocumentMeta;
}) {
  // Axlo brand accent (Kinetic Teal) when the profile doesn't override it.
  const accent = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(profile.accentColor)
    ? profile.accentColor
    : '#006c68';
  const logo = resolveImageUrl(profile.logoUrl);
  const signature = resolveImageUrl(profile.signatureUrl);
  const stamp = resolveImageUrl(profile.stampUrl);
  const change = Math.max(0, Math.round((sale.paidAmount - sale.total) * 100) / 100);
  const headAlign =
    profile.logoAlignment === 'CENTER' ? 'center' : profile.logoAlignment === 'RIGHT' ? 'right' : 'left';

  const sellerLines = [
    profile.addressLine,
    profile.phone ? `Tel: ${profile.phone}` : null,
    profile.email,
    profile.taxNumber ? `Tax/VAT: ${profile.taxNumber}` : null,
  ].filter(Boolean) as string[];

  const paymentMethods = sale.payments.map((p) => PAYMENT_LABELS[p.method] ?? p.method).join(', ');
  const paymentRefs = sale.payments.map((p) => p.reference).filter(Boolean).join(', ');

  return (
    <>
      <style>{css(accent, MARGIN_PADDING[profile.marginStyle], headAlign)}</style>
      <div className="a4-sheet">
        {/* Header */}
        <div className={`a4-head a4-head-${headAlign}`}>
          <div className="a4-seller">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt={meta.businessName} style={{ maxHeight: LOGO_HEIGHT[profile.logoSize] }} />
            ) : null}
            <div>
              <h1 className="a4-biz">{profile.companyName || meta.businessName}</h1>
              <div className="a4-muted">
                {sellerLines.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            </div>
          </div>
          <div className="a4-doc-title">
            <h2>Invoice</h2>
            <div className="a4-num">{sale.saleNumber}</div>
            <div className="a4-badge">{sale.paymentStatus}</div>
          </div>
        </div>

        {/* Meta + customer */}
        <div className="a4-meta-parties">
          <div className="a4-party">
            <h3>Bill to</h3>
            <div className="a4-name">{sale.customer?.name ?? 'Walk-in customer'}</div>
            {sale.customer?.companyName ? <div>{sale.customer.companyName}</div> : null}
            {sale.customer?.billingAddress ? <div>{sale.customer.billingAddress}</div> : null}
            {sale.customer?.phone ? <div>{sale.customer.phone}</div> : null}
            {sale.customer?.email ? <div>{sale.customer.email}</div> : null}
          </div>
          <div className="a4-meta-list">
            <div>
              <span className="a4-k">Date</span>
              {formatDateTime(sale.completedAt ?? sale.createdAt)}
            </div>
            <div>
              <span className="a4-k">Branch</span>
              {meta.branchName}
            </div>
            <div>
              <span className="a4-k">Register</span>
              {meta.registerName}
            </div>
            <div>
              <span className="a4-k">Cashier</span>
              {meta.cashierName}
            </div>
          </div>
        </div>

        {/* Item table */}
        <table className="a4-items">
          <thead>
            <tr>
              <th style={{ width: '28px' }}>#</th>
              <th>Product</th>
              {profile.showSku ? <th>SKU</th> : null}
              <th className="r">Qty</th>
              <th className="r">Unit price</th>
              {profile.showDiscountColumn ? <th className="r">Discount</th> : null}
              <th className="r">Line total</th>
            </tr>
          </thead>
          <tbody>
            {sale.items.map((it, i) => (
              <tr key={it.id}>
                <td>{i + 1}</td>
                <td>{it.productName}</td>
                {profile.showSku ? <td>{it.sku ?? '—'}</td> : null}
                <td className="r">{it.quantity}</td>
                <td className="r">{formatMoney(it.unitPrice)}</td>
                {profile.showDiscountColumn ? (
                  <td className="r">{it.discountAmount > 0 ? `- ${formatMoney(it.discountAmount)}` : '—'}</td>
                ) : null}
                <td className="r">{formatMoney(it.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div className="a4-totals">
          <table>
            <tbody>
              <SumRow k="Subtotal" v={formatMoney(sale.subtotal)} />
              {sale.totalDiscount > 0 ? <SumRow k="Product discount" v={`- ${formatMoney(sale.totalDiscount)}`} muted /> : null}
              {sale.orderDiscountAmount > 0 ? <SumRow k="Order discount" v={`- ${formatMoney(sale.orderDiscountAmount)}`} muted /> : null}
              {sale.taxAmount > 0 ? <SumRow k="Tax / VAT" v={formatMoney(sale.taxAmount)} /> : null}
              <SumRow k="Grand total" v={formatMoney(sale.total)} grand />
              <SumRow k="Paid" v={formatMoney(sale.paidAmount)} />
              {sale.balanceAmount > 0 ? <SumRow k="Balance due" v={formatMoney(sale.balanceAmount)} /> : null}
              {change > 0 ? <SumRow k="Change" v={formatMoney(change)} /> : null}
            </tbody>
          </table>
        </div>

        {/* Payment details */}
        <div className="a4-blocks">
          <div className="a4-block">
            <h4>Payment</h4>
            <p>
              Method: {paymentMethods || '—'}
              {paymentRefs ? ` · Ref: ${paymentRefs}` : ''} · Status: {sale.paymentStatus}
            </p>
          </div>
          {profile.footerText ? (
            <div className="a4-block">
              <h4>Notes</h4>
              <p>{profile.footerText}</p>
            </div>
          ) : null}
        </div>

        {/* Signatures */}
        {profile.signatureFields ? (
          <div className="a4-signs">
            <div className="a4-sign">
              {signature ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={signature} alt="Authorized signature" />
              ) : null}
              {stamp ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={stamp} alt="Company stamp" />
              ) : null}
              Authorized signature
            </div>
            <div className="a4-sign">Checked by</div>
            <div className="a4-sign">Approved by</div>
            <div className="a4-sign">Customer signature</div>
          </div>
        ) : null}

        {/* Footer */}
        <div className="a4-foot">
          {profile.footerText || 'Thank you for your business!'}
          <span className="a4-gen">Generated {formatDateTime(new Date().toISOString())}</span>
        </div>
        {profile.billNote ? <div className="a4-billnote">{profile.billNote}</div> : null}
      </div>
    </>
  );
}

function SumRow({ k, v, grand, muted }: { k: string; v: string; grand?: boolean; muted?: boolean }) {
  return (
    <tr className={grand ? 'a4-grand' : undefined}>
      <td className="a4-k" style={muted ? { color: '#94a3b8' } : undefined}>
        {k}
      </td>
      <td className="a4-v">{v}</td>
    </tr>
  );
}

function css(accent: string, padding: string, align: string): string {
  return `
  .a4-sheet { --a4-accent:${accent}; width:210mm; min-height:297mm; margin:0 auto; background:#fff; color:#0f172a;
    padding:${padding}; font-family:Arial,Helvetica,sans-serif; font-size:12px; box-sizing:border-box; }
  .a4-sheet * { box-sizing:border-box; }
  .a4-head { display:flex; justify-content:space-between; align-items:flex-start; gap:20px;
    border-bottom:2px solid var(--a4-accent); padding-bottom:12px; }
  .a4-head-center { flex-direction:column; align-items:center; text-align:center; }
  .a4-head-right { flex-direction:row-reverse; }
  .a4-seller { display:flex; gap:12px; align-items:flex-start; }
  .a4-head-center .a4-seller { flex-direction:column; align-items:center; text-align:center; }
  .a4-seller img { max-width:200px; object-fit:contain; }
  .a4-biz { font-size:18px; margin:0 0 2px; }
  .a4-muted { color:#64748b; font-size:11px; line-height:1.5; }
  .a4-doc-title { text-align:right; }
  .a4-head-center .a4-doc-title { text-align:center; }
  .a4-doc-title h2 { margin:0; font-size:22px; letter-spacing:1px; color:var(--a4-accent); text-transform:uppercase; }
  .a4-num { font-size:13px; font-weight:700; margin-top:4px; }
  .a4-badge { display:inline-block; margin-top:6px; padding:2px 8px; border-radius:999px; background:#eff6ff;
    color:var(--a4-accent); font-size:10px; font-weight:700; text-transform:uppercase; }
  .a4-meta-parties { display:flex; justify-content:space-between; gap:24px; margin-top:14px; }
  .a4-party h3 { margin:0 0 4px; font-size:11px; text-transform:uppercase; color:#64748b; letter-spacing:.5px; }
  .a4-party .a4-name { font-weight:700; font-size:13px; }
  .a4-meta-list { text-align:right; font-size:11px; }
  .a4-meta-list div { margin-bottom:2px; }
  .a4-meta-list .a4-k { color:#64748b; margin-right:6px; }
  table.a4-items { width:100%; border-collapse:collapse; margin-top:16px; }
  table.a4-items thead th { background:#f8fafc; border-bottom:1.5px solid #e2e8f0; text-align:left; padding:8px;
    font-size:10.5px; text-transform:uppercase; color:#64748b; letter-spacing:.3px; }
  table.a4-items tbody td { padding:8px; border-bottom:1px solid #e2e8f0; vertical-align:top; }
  table.a4-items tbody tr { break-inside:avoid; page-break-inside:avoid; }
  .a4-items .r, .a4-totals .a4-v { text-align:right; }
  .a4-totals { display:flex; justify-content:flex-end; margin-top:14px; break-inside:avoid; page-break-inside:avoid; }
  .a4-totals table { width:300px; border-collapse:collapse; }
  .a4-totals td { padding:4px 8px; font-size:12px; }
  .a4-totals td.a4-k { color:#64748b; }
  .a4-totals tr.a4-grand td { border-top:2px solid var(--a4-accent); font-size:15px; font-weight:800; padding-top:8px; }
  .a4-blocks { margin-top:18px; display:grid; gap:12px; }
  .a4-block h4 { margin:0 0 3px; font-size:11px; text-transform:uppercase; color:#64748b; }
  .a4-block p { margin:0; font-size:11px; line-height:1.55; }
  .a4-signs { display:flex; justify-content:space-between; gap:18px; margin-top:40px; break-inside:avoid; }
  .a4-sign { flex:1; border-top:1px solid #0f172a; padding-top:6px; font-size:11px; color:#64748b; }
  .a4-sign img { display:block; max-height:52px; max-width:100%; object-fit:contain; margin-bottom:4px; }
  .a4-foot { margin-top:22px; text-align:center; color:#64748b; font-size:11px; border-top:1px solid #e2e8f0; padding-top:10px; }
  .a4-foot .a4-gen { display:block; margin-top:3px; font-size:9.5px; color:#94a3b8; }
  .a4-billnote { margin-top:10px; text-align:center; color:#0f172a; font-size:11px; line-height:1.5; white-space:pre-line; }
  @page { size: A4 portrait; margin: 12mm; }
  @media print {
    html, body { background:#fff !important; margin:0; }
    .a4-toolbar { display:none !important; }
    .a4-sheet { width:auto; min-height:auto; margin:0; padding:0; box-shadow:none; }
    table.a4-items thead { display:table-header-group; }
  }
  `;
}
