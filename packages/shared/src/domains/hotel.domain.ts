/**
 * The hotel domain (D55/D56, open decision Q7).
 *
 * Today a hotel workspace is food service under another name — this file
 * re-declares the food-service values rather than aliasing the descriptor,
 * deliberately: a file that looks redundant today is a one-file edit the day
 * hotels need room-nights, folios and a STAY fulfilment provider, whereas an
 * alias would be a refactor. `capabilities-parity.spec` asserts the values
 * stay `deepEqual` to food service until a divergence is a visible,
 * deliberate edit here.
 */
import { HOTEL_WORKSPACE_ROLE_TEMPLATES } from '../types/role-templates.js';
import { FOOD_SERVICE_CAPABILITIES } from './capabilities.js';
import type { DomainDescriptor } from './domain.types.js';
import { FOOD_SERVICE_MODULES, SHARED_CORE_MODULES } from './modules.js';
import { FOOD_SERVICE_NAVIGATION } from './navigation.js';

export const HOTEL_DOMAIN: DomainDescriptor = {
  businessTypes: ['HOTEL'],
  label: 'Hotel',
  template: {
    key: 'HOTEL',
    name: 'Hotel',
    description:
      'Mirrors the restaurant workspace today — food and beverage service for a hotel. ' +
      'Its own workspace type so it can diverge later without moving live tenants.',
    order: 3,
  },
  profile: { inventoryMode: 'LOCAL', accountingProvider: 'NONE' },
  modules: [...SHARED_CORE_MODULES, ...FOOD_SERVICE_MODULES],
  navigation: FOOD_SERVICE_NAVIGATION,
  // PO decision 2026-08-17: Owner, Waiter and Receptionist.
  roleTemplates: HOTEL_WORKSPACE_ROLE_TEMPLATES,
  capabilities: FOOD_SERVICE_CAPABILITIES,
  catalogue: {
    /**
     * The plan's §4.6 worked example, live (D64). All OPTIONAL for now,
     * deliberately: the same wizard authors a hotel's food and beverage
     * products, and a required `bedCount` would block every burger. The
     * required flags arrive with STAY_UNIT authoring, when requiredness can
     * hang off the sellable kind instead of the whole domain.
     */
    attributeSchema: [
      { key: 'bedCount', label: 'Beds', type: 'integer', min: 1, max: 12 },
      { key: 'maxOccupancy', label: 'Sleeps', type: 'integer', min: 1, max: 20 },
      { key: 'viewType', label: 'View', type: 'enum', options: ['Sea', 'Garden', 'City'] },
    ],
  },
};
