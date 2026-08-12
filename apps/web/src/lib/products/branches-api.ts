/**
 * Minimal branches client — the wizard needs a Branch select for opening stock
 * (D44) and this is the first place on the web side to consume `GET /branches`.
 *
 * Kept here rather than in `restaurant/api.ts` (which nests everything under
 * `/restaurant/branches/:id/...`) because Hardware-POS products are `SHARED_
 * CORE` and must not depend on a restaurant-scoped module.
 */

import { api } from '../api';
import type { Session } from '../auth';

export interface BranchRegisterSummary {
  id: string;
  name: string;
  code: string;
}

export interface BranchSummary {
  id: string;
  name: string;
  code: string;
  address: string | null;
  phone: string | null;
  registers: BranchRegisterSummary[];
}

export async function fetchBranches(session: Session): Promise<BranchSummary[]> {
  return api.get<BranchSummary[]>('/branches', {
    token: session.token,
    tenantId: session.user.tenantId,
  });
}
