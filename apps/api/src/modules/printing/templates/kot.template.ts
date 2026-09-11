import { EscPosBuilder, wrap, type BuilderOptions } from '../escpos';

/**
 * The Kitchen Order Ticket, as bytes — laid out the way the mainstream POS
 * kitchen printers lay it out (D174, on the owner's instruction: "industry
 * standard"), because a cook who has worked anywhere else should read this
 * one without being taught it.
 *
 * Everything printed here is already snapshotted on `KitchenTicketItem` at
 * round-submit time (name, variant, quantity, modifiers, instructions), so a
 * reprint two hours later prints what was ordered, not what the menu says
 * now.
 *
 * ## The conventions, and why each one is there
 *
 * - **Order type first, then the destination, both as the biggest text.** A
 *   kitchen ticket is read from the rail at arm's length, and the two things
 *   it must answer at that distance are "dine in or packed?" (it changes the
 *   plating) and "where does it go?" — the table, or the order the counter
 *   will call. Everything else is smaller.
 * - **Quantity first, then the item, in double HEIGHT.** Double height keeps
 *   the roll's full width (48 columns), so a long dish name wraps at our word
 *   boundaries; D67's double WIDTH halved the width without telling the
 *   wrapper, and the printer broke names mid-word at its own 24th column.
 * - **What sits under an item is indented and typed.** A variant plain, a
 *   modifier with `+`, an instruction with `>>` in bold capitals — a choice
 *   and an order look alike on paper until one is labelled, and the
 *   instruction is the line most often missed.
 * - **A blank line between items**, so a six-line ticket does not read as one
 *   block. **An item count at the foot**, which is how the pass checks it has
 *   plated everything before the runner takes it.
 */
export type KotOrderType = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';

export interface KotTicketData {
  ticketNumber: string;
  /** NULL for a D147-window ticket that belonged to every station at once. */
  stationName: string | null;
  orderNumber: string | null;
  orderType: KotOrderType;
  /** The table's code ("T4") and its area, for a dine-in ticket. */
  tableCode: string | null;
  areaName: string | null;
  /** Who the counter will call, on a takeaway or delivery ticket. */
  customerName: string | null;
  roundNumber: number | null;
  waiterName: string | null;
  createdAt: Date;
  isReprint: boolean;
  items: {
    name: string;
    variantName: string | null;
    quantity: string;
    modifierNames: string[];
    specialInstructions: string | null;
  }[];
}

const ORDER_TYPE_LABEL: Record<KotOrderType, string> = {
  DINE_IN: 'DINE IN',
  TAKEAWAY: 'TAKEAWAY',
  DELIVERY: 'DELIVERY',
};

/** Width of the quantity column: "12 " — three characters, then the name. */
const QTY_COLUMN = 4;

export function renderKotTicket(data: KotTicketData, columns = 48, options?: BuilderOptions): Buffer {
  const b = new EscPosBuilder(columns, options);
  b.init();

  if (data.isReprint) {
    b.align('center').bold(true).line('*** REPRINT ***').bold(false).line();
  }

  // ── Where it is going: the biggest text on the paper ────────────────────
  b.hr('=');
  b.align('center').doubleSize(true).bold(true);
  b.line(ORDER_TYPE_LABEL[data.orderType]);
  if (data.orderType === 'DINE_IN' && data.tableCode) {
    b.line(`TABLE ${data.tableCode}`);
  } else if (data.orderNumber) {
    // The counter calls the order by its number; the customer, when the
    // order has one, is what the runner shouts.
    b.line(`#${data.orderNumber}`);
  }
  b.doubleSize(false).bold(false);
  if (data.orderType === 'DINE_IN' && data.areaName) b.line(data.areaName);
  if (data.orderType !== 'DINE_IN' && data.customerName) b.line(data.customerName);
  b.align('left').hr('=');

  // ── The ticket's identity ───────────────────────────────────────────────
  b.bold(true).row(data.ticketNumber, formatStamp(data.createdAt)).bold(false);
  const meta = [
    data.orderType === 'DINE_IN' && data.orderNumber ? `Order ${data.orderNumber}` : null,
    data.roundNumber !== null ? `Round ${data.roundNumber}` : null,
  ].filter((part): part is string => part !== null);
  if (meta.length > 0) b.line(meta.join('  ·  '));
  // Names are long and the roll is not: the server gets a line of their own.
  if (data.waiterName) b.line(`Server: ${data.waiterName}`);
  if (data.stationName) b.line(`Station: ${data.stationName}`);
  b.hr();

  // ── The items ───────────────────────────────────────────────────────────
  data.items.forEach((item, index) => {
    if (index > 0) b.line();
    const qty = trimQty(item.quantity).padEnd(QTY_COLUMN);
    const nameLines = wrap(item.name, columns - QTY_COLUMN);
    b.bold(true).doubleHeight(true);
    b.line(`${qty}${nameLines[0] ?? ''}`);
    for (const rest of nameLines.slice(1)) b.line(`${' '.repeat(QTY_COLUMN)}${rest}`);
    b.doubleHeight(false).bold(false);
    const indent = ' '.repeat(QTY_COLUMN + 2);
    if (item.variantName) b.line(`${indent}${item.variantName.toUpperCase()}`);
    for (const mod of item.modifierNames) b.line(`${indent}+ ${mod}`);
    if (item.specialInstructions) {
      b.bold(true).line(`${indent}>> ${item.specialInstructions.toUpperCase()}`).bold(false);
    }
  });

  // ── The foot ────────────────────────────────────────────────────────────
  b.hr();
  const total = data.items.reduce((sum, item) => sum + Number(item.quantity), 0);
  const count = trimQty(total.toFixed(3));
  b.bold(true).line(`${count} ${count === '1' ? 'ITEM' : 'ITEMS'}`).bold(false);
  b.cut();
  return b.build();
}

/** "2.000" → "2"; "1.500" → "1.5". Kitchen tickets never show trailing zeros. */
export function trimQty(quantity: string): string {
  if (!quantity.includes('.')) return quantity;
  return quantity.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * "11/09/2026 03:32 PM" — the same stamp the on-screen ticket carries
 * (D153's `formatKotStamp`), so the two papers a kitchen may hold for one
 * order read the same time the same way.
 */
export function formatStamp(at: Date): string {
  const dd = String(at.getDate()).padStart(2, '0');
  const mm = String(at.getMonth() + 1).padStart(2, '0');
  const yyyy = at.getFullYear();
  const h24 = at.getHours();
  const hh = String(h24 % 12 === 0 ? 12 : h24 % 12).padStart(2, '0');
  const min = String(at.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min} ${h24 < 12 ? 'AM' : 'PM'}`;
}
