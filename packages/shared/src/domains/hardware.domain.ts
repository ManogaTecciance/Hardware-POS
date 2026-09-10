/**
 * The hardware/retail domain — the original product (D56/D57).
 *
 * D57: this is the vertical's ONE descriptor. The pilot tile shop is a
 * hardware-template business (PO decision, 2026-08-14); `TILE_SHOP` and
 * `RETAIL` were removed from `BusinessType` rather than deprecated, because
 * they were ten days old and carried zero data.
 *
 * This is also the only descriptor that names QuickBooks (§4.9 of the
 * convergence plan): every other domain declares `accountingProvider: 'NONE'`
 * and omits the QUICKBOOKS module, and a tripwire enforces that a copy-pasted
 * descriptor cannot silently carry the integration into a new vertical.
 */
import { HARDWARE_ROLE_TEMPLATES } from '../types/role-templates.js';
import { RETAIL_CAPABILITIES } from './capabilities.js';
import type { DomainDescriptor, SampleCatalogueItem } from './domain.types.js';
import { RETAIL_MODULES, SHARED_CORE_MODULES } from './modules.js';
import { RETAIL_NAVIGATION } from './navigation.js';

/**
 * D154 — the goods hardware's document previews are illustrated with.
 *
 * These eight lines were the ONLY sample catalogue in the product, living in
 * `documents.service.ts` and shown to every workspace regardless of trade — so
 * a clothing shop previewing its own quotation saw Portland cement on its
 * letterhead. They are moved here unchanged, character for character, so that
 * hardware's rendered preview is byte-identical before and after the move.
 * A test asserts exactly that.
 *
 * Illustration only: nothing here is provisioned, priced or sold.
 */
const HARDWARE_SAMPLE_ITEMS: readonly SampleCatalogueItem[] = [
  { name: 'Portland Cement 50kg', sku: 'CEM-50', unit: 'BAG', unitPrice: 2650 },
  { name: 'TMT Steel Bar 12mm (per length)', sku: 'STL-12', unit: 'PCS', unitPrice: 1980 },
  { name: 'PVC Pipe 2 inch — 6m', sku: 'PVC-2IN', unit: 'LENGTH', unitPrice: 1450 },
  { name: 'Weathershield Emulsion Paint 4L', sku: 'PNT-WS4', unit: 'CAN', unitPrice: 5400 },
  { name: 'Door Lock Set — Stainless', sku: 'LOCK-STD', unit: 'SET', unitPrice: 4850 },
  { name: 'Electrical Wire 1mm (per metre)', sku: 'WIRE-1MM', unit: 'M', unitPrice: 95, pack: 10 },
  { name: 'Angle Grinder 4 inch 720W', sku: 'GRND-4', unit: 'PCS', unitPrice: 9200 },
  { name: 'Safety Gloves — Nitrile', sku: 'GLOV-STD', unit: 'PAIR', unitPrice: 640 },
];

export const HARDWARE_DOMAIN: DomainDescriptor = {
  businessTypes: ['HARDWARE'],
  label: 'Hardware store',
  template: {
    key: 'HARDWARE',
    // 2.10 — was "Hardware / Retail". D120 puts a real Retail card beside this
    // one, and two cards both claiming "retail" — one of them QuickBooks-backed,
    // the other explicitly not — is a support call waiting to happen. This card
    // now says what it is; the Retail card says what it is.
    //
    // D57's own history is the precedent: TILE_SHOP → HARDWARE was accepted as
    // behaviour-preserving because "the one visible change is the Settings →
    // Business label". A label is exactly what tells an operator which product
    // they are getting. `key` and `businessTypes` are untouched, so nothing
    // stored, seeded or provisioned changes.
    name: 'Hardware store',
    description:
      'Counter sales, stock control, quotations, returns and supplier management. ' +
      'QuickBooks-backed inventory and accounting.',
    order: 1,
  },
  profile: { inventoryMode: 'QUICKBOOKS', accountingProvider: 'QUICKBOOKS' },
  modules: [...SHARED_CORE_MODULES, ...RETAIL_MODULES],
  navigation: RETAIL_NAVIGATION,
  // PO decisions 2026-08-17 and 2026-09-08 (D108): a hardware shop staffs an
  // Owner, an owner-equivalent Salesperson, and Cashiers. The Salesperson is
  // this template's alone.
  roleTemplates: HARDWARE_ROLE_TEMPLATES,
  capabilities: RETAIL_CAPABILITIES,
  // No domain attributes (D64): everything the hardware vertical stores about
  // a product is behaviour, and behaviour lives in typed columns. An empty
  // schema means every `attributes` key is refused — declared, not defaulted.
  catalogue: {
    attributeSchema: [],
    // D154 — declared, not inherited. The fallback for a descriptor that
    // says nothing is a NEUTRAL list, so hardware has to name its own goods
    // to keep the preview it has always had.
    sampleItems: HARDWARE_SAMPLE_ITEMS,
  },
};
