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
import { BUILT_IN_ROLE_TEMPLATES } from '../types/role-templates.js';
import { RETAIL_CAPABILITIES } from './capabilities.js';
import type { DomainDescriptor } from './domain.types.js';
import { RETAIL_MODULES, SHARED_CORE_MODULES } from './modules.js';
import { RETAIL_NAVIGATION } from './navigation.js';

export const HARDWARE_DOMAIN: DomainDescriptor = {
  businessTypes: ['HARDWARE'],
  label: 'Hardware store',
  template: {
    key: 'HARDWARE',
    name: 'Hardware / Retail',
    description:
      'Counter sales, stock control, quotations, returns and supplier management. ' +
      'QuickBooks-backed inventory and accounting.',
    order: 1,
  },
  profile: { inventoryMode: 'QUICKBOOKS', accountingProvider: 'QUICKBOOKS' },
  modules: [...SHARED_CORE_MODULES, ...RETAIL_MODULES],
  navigation: RETAIL_NAVIGATION,
  roleTemplates: BUILT_IN_ROLE_TEMPLATES,
  capabilities: RETAIL_CAPABILITIES,
  // No domain attributes (D64): everything the hardware vertical stores about
  // a product is behaviour, and behaviour lives in typed columns. An empty
  // schema means every `attributes` key is refused — declared, not defaulted.
  catalogue: { attributeSchema: [] },
};
