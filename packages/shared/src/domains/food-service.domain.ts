/**
 * The food-service domain: restaurants, cafés, bakeries (D56).
 *
 * Three business types, one behaviour. They stay separate values (not one
 * `FOOD_SERVICE`) because they are distinguishable in data from day one and a
 * future divergence — a bakery without table service, say — is then a new
 * descriptor rather than a migration across live tenants. The same reasoning
 * D55 applied to HOTEL.
 */
import { ALL_ROLE_TEMPLATES } from '../types/role-templates.js';
import { FOOD_SERVICE_CAPABILITIES } from './capabilities.js';
import type { DomainDescriptor } from './domain.types.js';
import { FOOD_SERVICE_MODULES, SHARED_CORE_MODULES } from './modules.js';
import { FOOD_SERVICE_NAVIGATION } from './navigation.js';

export const FOOD_SERVICE_DOMAIN: DomainDescriptor = {
  businessTypes: ['RESTAURANT', 'CAFE', 'BAKERY'],
  label: 'Restaurant',
  template: {
    key: 'RESTAURANT',
    name: 'Restaurant',
    description:
      'Dining areas and tables, table sessions, kitchen tickets, takeaway and ' +
      'per-table billing. Local inventory, no accounting provider.',
    order: 2,
  },
  profile: { inventoryMode: 'LOCAL', accountingProvider: 'NONE' },
  modules: [...SHARED_CORE_MODULES, ...FOOD_SERVICE_MODULES],
  navigation: FOOD_SERVICE_NAVIGATION,
  // Built-ins plus the restaurant operational roles (Waiter, Kitchen Staff, …).
  roleTemplates: ALL_ROLE_TEMPLATES,
  capabilities: FOOD_SERVICE_CAPABILITIES,
  // No domain attributes (D64): a dish's descriptive fields (prepMinutes,
  // dietaryTags, foodType) predate the attributes column and stay typed —
  // moving them would be a demotion for no gain.
  catalogue: { attributeSchema: [] },
};
