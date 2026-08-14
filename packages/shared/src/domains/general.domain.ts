/**
 * The general domain: a catalogue without stock tracking (D56).
 *
 * The third supported profile combination — `DISABLED` inventory, no
 * accounting. Uses the retail navigation and roles; sells over the counter.
 * Not offered as a workspace template yet: `template.order` places it LAST
 * and `WORKSPACE_TEMPLATES` (registry.ts) filters on the offered set, so
 * offering it later is a data change here, not code elsewhere.
 */
import { BUILT_IN_ROLE_TEMPLATES } from '../types/role-templates.js';
import { GENERAL_CAPABILITIES } from './capabilities.js';
import type { DomainDescriptor } from './domain.types.js';
import { SHARED_CORE_MODULES } from './modules.js';
import { RETAIL_NAVIGATION } from './navigation.js';

export const GENERAL_DOMAIN: DomainDescriptor = {
  businessTypes: ['GENERAL'],
  label: 'General',
  template: {
    key: 'GENERAL',
    name: 'General business',
    description: 'A product catalogue and counter sales with no stock tracking.',
    // Not offered in the console picker today — see OFFERED_TEMPLATE_KEYS.
    order: 99,
  },
  profile: { inventoryMode: 'DISABLED', accountingProvider: 'NONE' },
  modules: [...SHARED_CORE_MODULES],
  navigation: RETAIL_NAVIGATION,
  roleTemplates: BUILT_IN_ROLE_TEMPLATES,
  capabilities: GENERAL_CAPABILITIES,
};
