import { BusinessType } from '@hardware-pos/database';
import { WORKSPACE_TEMPLATES as REGISTRY_TEMPLATES } from '@hardware-pos/shared';

/**
 * D55/D56 — the workspace templates a platform admin can choose from.
 *
 * Derived from the domain registry rather than hand-written: a template is a
 * named `DomainDescriptor`, and a new vertical appears in the console picker
 * by existing in the registry (unless deliberately withheld there). The cast
 * from the shared business-type union to the Prisma enum is sound because
 * `platform-vocabulary.spec.ts` proves the two vocabularies equal at runtime.
 */
export interface WorkspaceTemplate {
  key: string;
  name: string;
  description: string;
  businessType: BusinessType;
}

export const WORKSPACE_TEMPLATES: readonly WorkspaceTemplate[] = REGISTRY_TEMPLATES.map((t) => ({
  key: t.key,
  name: t.name,
  description: t.description,
  businessType: t.businessType as BusinessType,
}));

export function templateByKey(key: string): WorkspaceTemplate | undefined {
  return WORKSPACE_TEMPLATES.find((t) => t.key === key);
}
