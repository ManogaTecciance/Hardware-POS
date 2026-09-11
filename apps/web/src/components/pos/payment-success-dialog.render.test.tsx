import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SuccessView } from './payment-success-dialog';
import type { CompletedSale } from '@/lib/sales';

/**
 * D166 — the payment-complete dialog offers the bill this workspace issues.
 *
 * ## What was reported
 *
 * On a RETAIL till, completing a sale opened a dialog whose primary action was
 * **Print A4 Bill**, beside **Preview A4 Bill** — for a document D152 removed
 * from retail — with the receipt demoted to a text link between them.
 *
 * ## Why nothing caught it
 *
 * D152 gated the Settings screen, the sale page and the "print after payment"
 * toggle on `showA4SaleDocument`. This dialog never consulted it: the page
 * computed `canPrintA4` on line 140 and did not pass it in. Nothing rendered
 * this page, so no test could see it — the component was extracted from
 * `page.tsx` to make this file possible at all.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Both workspaces are asserted against the SAME component, each with the
 * buttons the other must not have. A dialog that had simply lost its A4 pair
 * would pass the retail case and fail the hardware one; a dialog that ignored
 * the flag would fail retail. Neither case can pass alone.
 *
 * The retail case also pins that the receipt is the PRIMARY action rather than
 * merely present — it was present before, as a text link, which is the defect.
 */

const sale = {
  id: 'sale_1',
  saleNumber: 'S-000028',
  paidAmount: 4000,
  balanceAmount: 0,
} as unknown as CompletedSale;

function mount(canPrintA4: boolean) {
  render(
    <SuccessView
      sale={sale}
      currency="LKR"
      printing={false}
      canPrintA4={canPrintA4}
      onPreviewA4={vi.fn()}
      onPrintA4={vi.fn()}
      onPrintThermal={vi.fn()}
      onViewSale={vi.fn()}
      onNewSale={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe('D166 — the bill the payment dialog offers', () => {
  it('a retail till offers the receipt, and no A4 at all', () => {
    mount(false);

    // POSITIVE — one print button, and it is the receipt.
    expect(screen.getByRole('button', { name: /Print receipt/i })).toBeTruthy();

    // NEGATIVE — the two buttons for a document this workspace does not issue.
    expect(screen.queryByRole('button', { name: /Print A4 Bill/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Preview A4 Bill/i })).toBeNull();

    // …and the dialog is otherwise intact, so this cannot pass on an empty
    // render.
    expect(screen.getByRole('button', { name: /New sale/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /View sale/i })).toBeTruthy();
  });

  it('a hardware till keeps both A4 actions, against the same component', () => {
    /*
     * The paired half. D152 took the A4 from RETAIL only; hardware still
     * issues one, and removing it there would be a regression in another
     * workspace's core flow.
     */
    mount(true);

    expect(screen.getByRole('button', { name: /Print A4 Bill/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Preview A4 Bill/i })).toBeTruthy();
    // Its receipt is still reachable, as the secondary action it always was.
    expect(screen.getByRole('button', { name: /Thermal receipt/i })).toBeTruthy();
  });

  it('the receipt is the PRIMARY action on retail, not a text link', () => {
    /*
     * The distinction the report turned on. The receipt was always reachable —
     * it was a small link between two A4 buttons. Being present was never the
     * problem; being subordinate to a document the workspace cannot print was.
     */
    mount(false);

    const receipt = screen.getByRole('button', { name: /Print receipt/i });
    const newSale = screen.getByRole('button', { name: /New sale/i });

    /*
     * Asserted through the shared primitive's own classes rather than a
     * vague "is a button": `size="lg"` renders `h-14 px-8`, and the text
     * link this replaced carried `hover:underline` and no height at all.
     * So the receipt must match the weight of New sale beside it, and must
     * NOT be styled as a link.
     */
    expect(receipt.className).toContain('h-14');
    expect(newSale.className).toContain('h-14');
    expect(receipt.className).not.toContain('underline');
  });
});
