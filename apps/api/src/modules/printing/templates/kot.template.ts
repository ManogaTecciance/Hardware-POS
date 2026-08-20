import { EscPosBuilder } from '../escpos';

/**
 * D67 — the Kitchen Order Ticket, as bytes.
 *
 * Everything printed here is already snapshotted on `KitchenTicketItem` at
 * round-submit time (name, variant, quantity, modifiers, instructions), so
 * a reprint two hours later prints what was ordered, not what the menu says
 * now.
 *
 * Layout choices are kitchen-ergonomic, not decorative: the station name and
 * the quantity are double-size because a line cook reads this from a rail at
 * arm's length; modifiers are indented under their item so they cannot be
 * mistaken for separate dishes; special instructions carry a `!` marker
 * because they are the line that most often gets missed.
 */
export interface KotTicketData {
  ticketNumber: string;
  stationName: string;
  orderNumber: string | null;
  /** "T4 · Main Hall" for dine-in, "Takeaway" for a counter order. */
  placeLabel: string | null;
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

export function renderKotTicket(data: KotTicketData, columns = 48): Buffer {
  const b = new EscPosBuilder(columns);
  b.init();

  if (data.isReprint) {
    b.align('center').bold(true).line('*** REPRINT ***').bold(false).line();
  }

  b.align('center').doubleSize(true).bold(true);
  b.line(data.stationName.toUpperCase());
  b.doubleSize(false).bold(false);

  b.align('left').hr();
  b.row(data.ticketNumber, data.orderNumber ?? '');
  b.row(data.placeLabel ?? '', formatClock(data.createdAt));
  b.hr();

  for (const item of data.items) {
    // Quantity + name double-size: the line the cook actually reads.
    b.doubleSize(true).bold(true);
    b.line(`${trimQty(item.quantity)}x ${item.name}`);
    b.doubleSize(false).bold(false);
    if (item.variantName) b.line(`   [${item.variantName}]`);
    for (const mod of item.modifierNames) b.line(`   + ${mod}`);
    if (item.specialInstructions) {
      b.bold(true).line(`   ! ${item.specialInstructions}`).bold(false);
    }
  }

  b.hr();
  const footer = [
    data.roundNumber !== null ? `Round ${data.roundNumber}` : null,
    data.waiterName ? `Staff: ${data.waiterName}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (footer) b.line(footer);
  b.cut();
  return b.build();
}

/** "2.000" → "2"; "1.500" → "1.5". Kitchen tickets never show trailing zeros. */
export function trimQty(quantity: string): string {
  if (!quantity.includes('.')) return quantity;
  return quantity.replace(/0+$/, '').replace(/\.$/, '');
}

function formatClock(at: Date): string {
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
