'use client';

import * as React from 'react';

import type { PendingOffer } from '@/lib/pos/offer-prompts';

/** What the card knows about the product an offer names. */
export interface OfferRewardInfo {
  /** Null while the product is still being looked up. */
  name: string | null;
  /** D101 — an 86'd reward cannot be added; the card says so instead. */
  soldOut: boolean;
}

interface Props {
  offers: readonly PendingOffer[];
  rewardOf: (productId: string) => OfferRewardInfo;
  onAdd: (offer: PendingOffer) => void;
  onDecline: (offer: PendingOffer) => void;
  /** The button this card is holding up — named so the operator knows why. */
  waitingAction: string;
}

/**
 * D198 — the buy-X-get-Y prompt on the restaurant POS.
 *
 * One card per unfinished offer, each with the two answers a guest can give:
 * **Add** puts the reward in the order (through the same path as tapping its
 * menu card, so a variant or modifier question is still asked), **Customer
 * declined** clears the card for this ask. Neither is a money rule — the
 * server prices whatever it is sent — and the order cannot be placed or sent
 * until every card has an answer, which is the whole point: the offer must be
 * MADE, and the guest may still say no. Retail keeps its own D171 rule (the
 * reward is required, never declined); this card is the restaurant's.
 *
 * Same shape for a cross-product and a same-product offer, deliberately:
 * D171 recorded why presenting one situation two ways teaches nobody
 * anything, and "1 × Kottu — free" is as true of the third kottu as
 * "1 × Garden Salad — free" is of the salad.
 */
export function OfferPromptCard({ offers, rewardOf, onAdd, onDecline, waitingAction }: Props) {
  if (offers.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Offers to answer"
      className="mx-3 mb-2 space-y-2 rounded-xl border border-primary/40 bg-primary/5 px-3 py-2.5"
    >
      {offers.map((offer) => {
        const reward = rewardOf(offer.productId);
        const name = reward.name ?? 'this item';
        return (
          <div
            key={offer.declineKey}
            role="group"
            aria-label={offer.promotionName}
            className="space-y-1.5 text-xs"
          >
            <p className="font-semibold text-primary">🎁 {offer.promotionName}</p>
            <p className="text-muted-foreground">
              <span className="font-semibold text-foreground">
                {offer.needed} × {name}
              </span>{' '}
              — free with this order.
            </p>
            <div className="flex flex-wrap gap-2">
              {reward.soldOut ? (
                <span className="inline-flex h-9 items-center rounded-full bg-muted px-3 text-xs font-medium text-muted-foreground">
                  Sold out
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onAdd(offer)}
                  // Until the product is known there is nothing to add — the
                  // lookup is one request and the button arms when it lands.
                  disabled={reward.name === null}
                  className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Add
                </button>
              )}
              <button
                type="button"
                onClick={() => onDecline(offer)}
                className="inline-flex h-9 items-center rounded-full bg-muted px-4 text-xs font-medium text-foreground transition-colors hover:bg-border"
              >
                Customer declined
              </button>
            </div>
          </div>
        );
      })}
      <p className="pt-0.5 text-[11px] font-medium text-primary/80">
        {waitingAction} waits until every offer above is answered.
      </p>
    </div>
  );
}
