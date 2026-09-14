/**
 * D194 — what an exchange basket is, decided away from the screen.
 *
 * The exchange page used to hold one returned line and one replacement in two
 * strings, and built the request inline. Multi-line turns that into real
 * decisions — which lines are in, how many of each, whether every one has an
 * answer, what the customer pays — and a decision made inside JSX is a decision
 * nobody can test without a browser.
 *
 * So the rules live here as pure functions over plain data, the same shape
 * `product-presentation.ts` and `catalogue-labels.ts` keep. The page reads
 * them; it does not restate them.
 */

/** One line of the original sale, as the returns API describes it. */
export interface ExchangeLine {
  saleItemId: string;
  productId: string;
  productName: string;
  /** How many of this line have not already been returned. */
  availableReturnQuantity: number;
}

/** What the operator has said about one line. */
export interface LineChoice {
  quantity: number;
  replacementVariantId: string;
}

/** The replacement the customer is taking, priced. */
export interface ReplacementVariant {
  id: string;
  unitPrice: number;
  isActive?: boolean;
}

export interface SelectedLine {
  line: ExchangeLine;
  quantity: number;
  replacementVariantId: string;
}

/**
 * The lines actually coming back.
 *
 * Driven by `lines`, never by the keys of `choices`: a choice for a line that
 * is no longer returnable — because the sale was refetched, or the operator
 * returned it in another tab — must not survive as a phantom row. The screen
 * shows what the sale says, annotated by what the operator said about it.
 *
 * `quantity: 0` is how a line is DESELECTED rather than deleted, so ticking a
 * line off and back on does not lose the replacement already chosen for it.
 */
export function selectedLines(
  lines: readonly ExchangeLine[],
  choices: Readonly<Record<string, LineChoice>>,
): SelectedLine[] {
  const out: SelectedLine[] = [];
  for (const line of lines) {
    const choice = choices[line.saleItemId];
    if (!choice || choice.quantity <= 0) continue;
    out.push({
      line,
      // Clamped on the way out as well as at the input. A stale choice held
      // over a refetched sale could otherwise ask for more than the line can
      // still give back, and the server would refuse a number this screen
      // offered.
      quantity: Math.min(choice.quantity, line.availableReturnQuantity),
      replacementVariantId: choice.replacementVariantId,
    });
  }
  return out;
}

/** The replacement chosen for a line, if it is a variant we actually know. */
export function replacementFor(
  selected: SelectedLine,
  variantsByProduct: Readonly<Record<string, readonly ReplacementVariant[]>>,
): ReplacementVariant | null {
  const list = variantsByProduct[selected.line.productId] ?? [];
  return list.find((v) => v.id === selected.replacementVariantId) ?? null;
}

/**
 * Every selected line has a replacement the catalogue recognises.
 *
 * An empty basket is NOT answered. Without that, a screen with nothing ticked
 * would satisfy "every line has an answer" vacuously and offer a Complete
 * button that submits an exchange of nothing.
 */
export function everyLineAnswered(
  selected: readonly SelectedLine[],
  variantsByProduct: Readonly<Record<string, readonly ReplacementVariant[]>>,
): boolean {
  return selected.length > 0 && selected.every((s) => replacementFor(s, variantsByProduct) !== null);
}

/**
 * What the customer pays for what they take away.
 *
 * The chosen variant's own price × the quantity of the line it replaces: a swap
 * is one-for-one, so two Mediums coming back is two Larges going out.
 *
 * Lines still missing a replacement contribute NOTHING rather than falling back
 * to the returned line's price. A half-filled basket showing a plausible total
 * is how an operator takes the wrong money; `everyLineAnswered` is what gates
 * the button, and this figure is only complete when that is true.
 */
export function replacementTotal(
  selected: readonly SelectedLine[],
  variantsByProduct: Readonly<Record<string, readonly ReplacementVariant[]>>,
): number {
  return selected.reduce((sum, s) => {
    const variant = replacementFor(s, variantsByProduct);
    return variant ? sum + variant.unitPrice * s.quantity : sum;
  }, 0);
}

/** Stable identity of the selection, for deciding when to re-preview. */
export function selectionKey(selected: readonly SelectedLine[]): string {
  return selected.map((s) => `${s.line.saleItemId}:${s.quantity}`).join('|');
}

export interface ReturnItemPayload {
  saleItemId: string;
  returnQuantity: number;
  returnReason: 'NOT_SUITABLE';
  itemCondition: 'GOOD';
  stockDisposition: 'RETURN_TO_STOCK';
}

export interface ReplacementItemPayload {
  productId: string;
  productVariantId: string;
  quantity: number;
}

/**
 * The returning leg, one entry per selected line.
 *
 * A size swap is "not suitable": the shop sent what was ordered and it did not
 * fit, so the goods come back in good condition and go straight to stock. That
 * is a property of an EXCHANGE, not of a line, which is why it is constant here
 * rather than a per-line control the operator can get wrong.
 */
export function toReturnItems(selected: readonly SelectedLine[]): ReturnItemPayload[] {
  return selected.map((s) => ({
    saleItemId: s.line.saleItemId,
    returnQuantity: s.quantity,
    returnReason: 'NOT_SUITABLE',
    itemCondition: 'GOOD',
    stockDisposition: 'RETURN_TO_STOCK',
  }));
}

/**
 * The replacement leg, one entry per selected line, in the SAME order.
 *
 * Throws if a line has no replacement. That cannot happen behind
 * `everyLineAnswered`, and the alternative — silently dropping the line —
 * would send a basket that refunds three things and sells two, which balances
 * on the screen and not at the till.
 */
export function toReplacementItems(
  selected: readonly SelectedLine[],
  variantsByProduct: Readonly<Record<string, readonly ReplacementVariant[]>>,
): ReplacementItemPayload[] {
  return selected.map((s) => {
    const variant = replacementFor(s, variantsByProduct);
    if (!variant) {
      throw new Error(`No replacement chosen for ${s.line.productName}`);
    }
    return {
      productId: s.line.productId,
      productVariantId: variant.id,
      quantity: s.quantity,
    };
  });
}

/**
 * Clamp a typed quantity to what the line can still give back.
 *
 * Done here rather than trusting the `max` attribute: a number input accepts
 * anything typed or pasted, and the server refusing a value this screen
 * displayed is a worse experience than the screen not displaying it.
 */
export function clampQuantity(value: number, available: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(available, Math.floor(value)));
}
