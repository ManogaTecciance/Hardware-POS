/**
 * D104 / D104a — the tenant option library (Phase 5, `5.1` / `5.2`).
 *
 * Every field here is REQUIRED on the in-process type, even where the server
 * could conceivably omit it. That is the standing rule from Phase 4: `4.15` and
 * `4.21` were the same defect twice — an optional field dropped by a mapper,
 * invisible to the compiler — and making the field required turns the omission
 * into a compile error at the exact line rather than a blank on a screen.
 *
 * The `code` and `swatchHex` rules are imported from `@hardware-pos/shared`,
 * the same functions the API validates with, so the live preview in the form
 * and the server's refusal cannot disagree.
 */

import { api } from '../api';
import type { Session } from '../auth';

export interface AttributeOption {
  id: string;
  code: string;
  name: string;
  position: number;
  swatchHex: string | null;
}

export interface AttributeDefinition {
  id: string;
  name: string;
  position: number;
  categoryId: string | null;
  categoryName: string | null;
  options: AttributeOption[];
  /** How many product dimensions point at this definition. Gates deletion. */
  linkedDimensionCount: number;
}

export interface AttributeOptionInput {
  name: string;
  code: string;
  position?: number;
  swatchHex?: string | null;
}

export interface CreateAttributeDefinitionInput {
  name: string;
  position?: number;
  categoryId?: string | null;
  options: AttributeOptionInput[];
}

export interface UpdateAttributeDefinitionInput {
  name?: string;
  position?: number;
  categoryId?: string | null;
  options?: AttributeOptionInput[];
}

function auth(session: Session) {
  return { token: session.token, tenantId: session.user.tenantId };
}

export async function fetchAttributeLibrary(session: Session): Promise<AttributeDefinition[]> {
  const response = await api.get<{ definitions: AttributeDefinition[] }>(
    '/attribute-library',
    auth(session),
  );
  return response.definitions;
}

export function createAttributeDefinition(
  session: Session,
  input: CreateAttributeDefinitionInput,
): Promise<AttributeDefinition> {
  return api.post<AttributeDefinition>('/attribute-library', input, auth(session));
}

export function updateAttributeDefinition(
  session: Session,
  definitionId: string,
  input: UpdateAttributeDefinitionInput,
): Promise<AttributeDefinition> {
  return api.patch<AttributeDefinition>(
    `/attribute-library/${definitionId}`,
    input,
    auth(session),
  );
}

export function deleteAttributeDefinition(
  session: Session,
  definitionId: string,
): Promise<void> {
  return api.del<void>(`/attribute-library/${definitionId}`, auth(session));
}
