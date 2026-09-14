/**
 * D197 — how a restaurant order is NAMED, on every surface.
 *
 * An order carries two numbers. `orderNumber` (`RO-000120`) is the permanent,
 * tenant-wide identifier — what a sale points back at, what the audit log
 * records, what a search for last month's order finds. `callNumber` (`47`) is
 * the call-out: it restarts per branch every business day, so the counter can
 * say it, the guest can remember it and the pass can shout it without six
 * digits getting in the way.
 *
 * ## Why this lives in `shared`
 *
 * The number is rendered on the queue card, the order drawer, the kitchen
 * board, the ticket dialog, the session sheet, the printed KOT, the printed
 * bill and the on-screen bill — across both apps. The last time one label was
 * spelled in eight places (the sale line, D120 2.12) they drifted, and the
 * drift was found on a customer's invoice. One function here, and every
 * renderer calls it.
 *
 * ## The format
 *
 * `#47` — the call tag, with the `#` the PO asked to keep. An order minted
 * before D197 has no call number and reads `#RO-000120`, exactly as it did:
 * history is not renumbered.
 *
 * `#47 · RO-000120` — the full reference, for a detail view or a document
 * where the permanent identifier belongs beside the call-out.
 */
export interface OrderCallRef {
  callNumber: number | null | undefined;
  orderNumber: string | null | undefined;
}

/** `#47`, or `#RO-000120` before D197. Null when the order has neither. */
export function orderCallTag(ref: OrderCallRef): string | null {
  if (ref.callNumber !== null && ref.callNumber !== undefined) return `#${ref.callNumber}`;
  return ref.orderNumber ? `#${ref.orderNumber}` : null;
}

/** `#47 · RO-000120`; collapses to the tag alone when the two would repeat. */
export function orderFullRef(ref: OrderCallRef): string | null {
  const tag = orderCallTag(ref);
  if (!tag) return null;
  if (ref.callNumber === null || ref.callNumber === undefined || !ref.orderNumber) return tag;
  return `${tag} \u00b7 ${ref.orderNumber}`;
}
