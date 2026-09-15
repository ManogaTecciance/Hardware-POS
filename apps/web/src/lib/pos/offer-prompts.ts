import {
  incompleteOffers,
  type IncompleteOffer,
  type PromotionCartLine,
  type PromotionRule,
} from '@hardware-pos/shared';

import type { SessionDetail } from '@/lib/restaurant/types';

/**
 * D198 — the buy-X-get-Y prompt on the restaurant POS: what to ask, and what
 * has already been answered.
 *
 * A pure resolver, in the shape D28/D31 asks for: the counter workspace reads
 * a list and renders a card per entry. The arithmetic of "which offers are
 * unfinished" is the shared applier's (`incompleteOffers`, D171) and is not
 * repeated here — this file only adds the two things the retail till does not
 * need: a table's SENT rounds count towards the offer, and a guest may say no.
 *
 * ## Why a decline is keyed on the ask, not on the promotion
 *
 * "Customer declined" answers one question: *do you want the salad this tea
 * has earned?* If the same order later earns a second salad, that is a new
 * question and the card comes back. If it never does, the decline holds for
 * the rest of the order. Keying on the promotion alone would silence the
 * second ask; keying on nothing would repeat the first on every render.
 *
 * The shared `IncompleteOffer` has no "earned" field, but `needed` moves with
 * it (earned − held for a cross-product reward, the group's remainder for a
 * same-product one), so `promotionId:needed` names an ask precisely enough.
 */

export type OfferDeclineKey = string;

export function offerDeclineKey(offer: Pick<IncompleteOffer, 'promotionId' | 'needed'>): OfferDeclineKey {
  return `${offer.promotionId}:${offer.needed}`;
}

/** An unfinished offer the operator has not yet answered. */
export type PendingOffer = IncompleteOffer & { declineKey: OfferDeclineKey };

/**
 * The offers to put in front of the operator right now.
 *
 * `lines` is everything that counts — the draft, plus (dine-in) what the
 * table already has — and `declined` is what this order has already said no
 * to. No rules, no lines, or nothing near a threshold all yield an empty list,
 * so a basket that has qualified for nothing is never asked anything.
 */
export function pendingOffers(input: {
  lines: readonly PromotionCartLine[];
  promotions: readonly PromotionRule[];
  declined: ReadonlySet<OfferDeclineKey>;
}): PendingOffer[] {
  if (input.promotions.length === 0 || input.lines.length === 0) return [];
  return incompleteOffers({ lines: input.lines, promotions: input.promotions })
    .map((offer) => ({ ...offer, declineKey: offerDeclineKey(offer) }))
    .filter((offer) => !input.declined.has(offer.declineKey));
}

/**
 * What the table already holds, as lines the applier can count.
 *
 * Only rounds that reached the kitchen and items that were not voided: a
 * DRAFT round is the cart being typed (counted separately, as the draft), and
 * a voided salad is not a salad the guest has. A legacy MENU_ITEM line carries
 * no product and so can never satisfy a promotion — it is skipped rather than
 * given an empty id that would match nothing anyway.
 *
 * `manualDiscountAmount` is 0 for every sent line: the detail read carries no
 * discount, and this list feeds the PROMPT, not the bill. The bill is priced
 * by the server over the whole session (D71) and stays the authority.
 */
export function sentLinesForOffers(detail: SessionDetail | null): PromotionCartLine[] {
  if (!detail) return [];
  const out: PromotionCartLine[] = [];
  for (const bundle of detail.orders) {
    for (const round of bundle.rounds) {
      if (round.round.status === 'DRAFT') continue;
      for (const item of round.items) {
        if (item.status === 'VOIDED' || !item.productId) continue;
        const quantity = Number(item.quantity);
        const unitPrice = round2(Number(item.unitPrice) + Number(item.modifierTotal));
        if (!(quantity > 0)) continue;
        out.push({
          id: `sent:${item.id}`,
          productId: item.productId,
          unitPrice,
          quantity,
          lineSubtotal: round2(quantity * unitPrice),
          manualDiscountAmount: 0,
        });
      }
    }
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
