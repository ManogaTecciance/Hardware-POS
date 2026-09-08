/**
 * Product ↔ KitchenStation links (D45 — Restaurant wizard Step 3).
 *
 * `/products/:productId/kitchen-stations` mirrors the modifier-groups link
 * shape: a `GET` hydrates the current link set, a `PUT` replaces it wholesale.
 * The station catalogue itself is loaded via `restaurantApi.kitchenStations`
 * (branch-scoped) — this client only concerns itself with the join rows.
 */

import { api } from '../api';
import type { Session } from '../auth';

export interface KitchenStationLink {
  id: string;
  code: string;
  name: string;
  category: string;
  isActive: boolean;
}

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

export async function fetchProductStations(
  session: Session,
  productId: string,
): Promise<{ stations: KitchenStationLink[] }> {
  return api.get<{ stations: KitchenStationLink[] }>(
    `/products/${productId}/kitchen-stations`,
    auth(session),
  );
}

export async function putProductStations(
  session: Session,
  productId: string,
  stationIds: string[],
): Promise<{ stations: KitchenStationLink[] }> {
  return api.put<{ stations: KitchenStationLink[] }>(
    `/products/${productId}/kitchen-stations`,
    { stationIds },
    auth(session),
  );
}
