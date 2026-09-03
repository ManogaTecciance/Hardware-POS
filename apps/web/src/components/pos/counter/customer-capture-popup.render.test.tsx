/**
 * The POS "Customer details" popup — mobile and name validation.
 *
 * This dialog sits between Place Order and Payment, so whatever it accepts
 * becomes a real customer record mid-sale. It had no validation on either
 * field: `inputMode="tel"` is a soft-keyboard hint that a desktop till
 * ignores, so letters went straight through, and the name had no length rule
 * at all — a 200+ character paste only failed at the server, as a raw 400 at
 * the very end of the order flow.
 *
 * Every case asserts both directions. A dialog that accepted nothing would
 * satisfy the rejection cases alone, so each one is paired with a value that
 * must still be accepted — and the "0771234567" and "+94 77 123 4567" cases
 * exist to prove the filter did not simply eat everything.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session-store';

// ── boundaries ───────────────────────────────────────────────────────────────

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();

class FakeApiError extends Error {
  status: number;
  constructor(status: number) {
    super('api error');
    this.status = status;
  }
}

vi.mock('@/lib/api', () => ({
  ApiError: FakeApiError,
  api: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    patch: (...args: unknown[]) => patch(...args),
  },
}));

const { CustomerCapturePopup } = await import('./customer-capture-popup');

const SESSION = {
  token: 'tok',
  user: {
    id: 'usr_1',
    name: 'Cashier',
    email: 'cashier@example.test',
    role: 'CASHIER',
    tenantId: 'tnt_1',
    permissions: [],
  },
  branchId: 'brn_1',
  registerId: null,
  branchName: 'Main',
  registerName: 'R1',
} as unknown as Session;

function renderPopup(
  // Takeaway: Skip is offered, so the dialog is at its most permissive —
  // if validation holds here it holds in the stricter Delivery mode too.
  // Delivery cases pass THIRD_PARTY explicitly.
  mode: 'TAKEAWAY' | 'THIRD_PARTY' = 'TAKEAWAY',
  onChoose: ReturnType<typeof vi.fn> = vi.fn(),
) {
  return render(
    <CustomerCapturePopup session={SESSION} mode={mode} onChoose={onChoose} onBack={vi.fn()} />,
  );
}

const mobileInput = () => screen.getByLabelText('Mobile number') as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: /Save & Continue/ }) as HTMLButtonElement;

/** Type a mobile and wait for the debounced lookup to reveal the name field. */
async function typeUnknownMobile(value: string) {
  fireEvent.change(mobileInput(), { target: { value } });
  await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy());
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  // No existing customer, so the dialog reveals the New Customer fields.
  get.mockResolvedValue({ items: [] });
  post.mockResolvedValue({ id: 'cus_1', name: 'Nimal Perera' });
  patch.mockResolvedValue({});
});

afterEach(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describe('the mobile field rejects what is not a phone number', () => {
  it('drops letters as they are typed', () => {
    renderPopup();
    fireEvent.change(mobileInput(), { target: { value: 'abc0771234567xyz' } });
    // Filtered on entry, so the letters never reach the customer record.
    expect(mobileInput().value).toBe('0771234567');
  });

  it('keeps the separators the placeholder invites', () => {
    renderPopup();
    // The positive control: a filter that stripped everything would pass the
    // letter case above and fail here.
    fireEvent.change(mobileInput(), { target: { value: '+94 77 123 4567' } });
    expect(mobileInput().value).toBe('+94 77 123 4567');

    fireEvent.change(mobileInput(), { target: { value: '077-123-4567' } });
    expect(mobileInput().value).toBe('077-123-4567');
  });

  it('allows a leading + but not one buried mid-number', () => {
    renderPopup();
    fireEvent.change(mobileInput(), { target: { value: '+94771234567' } });
    expect(mobileInput().value).toBe('+94771234567');

    fireEvent.change(mobileInput(), { target: { value: '077+123+4567' } });
    expect(mobileInput().value).toBe('0771234567');
  });

  it('strips symbols that are not phone punctuation', () => {
    renderPopup();
    fireEvent.change(mobileInput(), { target: { value: '077#123*4567!' } });
    expect(mobileInput().value).toBe('0771234567');
  });
});

describe('the mobile field enforces a length', () => {
  it('refuses a number that is too short, and says so', async () => {
    renderPopup();
    await typeUnknownMobile('07712');

    expect(screen.getByText('Mobile number needs at least 9 digits.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nimal Perera' } });
    expect(saveButton().disabled).toBe(true);
  });

  it('refuses a number that is too long', async () => {
    renderPopup();
    await typeUnknownMobile('0771234567890123456');

    expect(screen.getByText('Mobile number cannot be more than 15 digits.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nimal Perera' } });
    expect(saveButton().disabled).toBe(true);
  });

  it('accepts a real local number, and lets the sale continue', async () => {
    renderPopup();
    await typeUnknownMobile('0771234567');

    // The half that proves the rule is not simply rejecting everything.
    // Scoped to the messages, not the field's own label, which always renders.
    expect(screen.queryByText(/Mobile number needs|Mobile number cannot/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nimal Perera' } });
    expect(saveButton().disabled).toBe(false);
  });

  it('counts digits, so separators do not consume the allowance', async () => {
    renderPopup();
    // Fifteen characters but only ten digits — a character-based rule would
    // wrongly call this too long.
    await typeUnknownMobile('+94 77 123 4567');

    expect(screen.queryByText(/Mobile number cannot be more than/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nimal Perera' } });
    expect(saveButton().disabled).toBe(false);
  });

  it('says nothing while the field is still untouched', () => {
    renderPopup();
    // An error before anything is typed reads as a broken form, and Skip is
    // still a valid way out of this dialog.
    expect(screen.queryByText(/Mobile number needs/)).toBeNull();
  });
});

describe('the name field enforces a length', () => {
  it('refuses a single character', async () => {
    renderPopup();
    await typeUnknownMobile('0771234567');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'N' } });

    expect(screen.getByText('Name needs at least 2 characters.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('accepts a short but real name', async () => {
    renderPopup();
    await typeUnknownMobile('0771234567');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Jo' } });

    expect(screen.queryByText(/Name needs/)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('caps the field at the length the server accepts', async () => {
    renderPopup();
    await typeUnknownMobile('0771234567');

    // 200 matches CreateCustomerDto's @MaxLength(200), so the form cannot
    // build a payload that fails at the end of the order flow.
    expect((screen.getByLabelText('Name') as HTMLInputElement).maxLength).toBe(200);
  });
});

describe('an invalid entry never reaches the API', () => {
  it('does not post while the mobile is too short', async () => {
    renderPopup();
    await typeUnknownMobile('077');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nimal Perera' } });

    fireEvent.click(saveButton());

    // The button is disabled, but Enter-to-submit and a stale click both reach
    // the handler without going through it.
    expect(post).not.toHaveBeenCalled();
  });

  it('posts once everything is valid', async () => {
    renderPopup();
    await typeUnknownMobile('0771234567');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nimal Perera' } });

    fireEvent.click(saveButton());

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      name: 'Nimal Perera',
      mobile: '0771234567',
    });
    // Takeaway collects no address, so none must be invented for the record.
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty('street');
  });
});

describe('the Name field survives a follow-up lookup', () => {
  it('is the same DOM node after another keystroke, not a remount', async () => {
    renderPopup();
    await typeUnknownMobile('0771234567');
    const before = screen.getByLabelText('Name');

    // Synchronously after the keystroke — exactly where the old code flipped
    // the result to `searching`, unmounted the field, and put a fresh one back
    // 250ms later.
    fireEvent.change(mobileInput(), { target: { value: '07712345678' } });

    expect(screen.getByLabelText('Name')).toBe(before);
  });

  it('keeps what the cashier already typed into it', async () => {
    renderPopup();
    await typeUnknownMobile('0771234567');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nimal Perera' } });

    fireEvent.change(mobileInput(), { target: { value: '07712345670' } });

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Nimal Perera');
  });

  it('still reports that a lookup is running', async () => {
    renderPopup();
    await typeUnknownMobile('0771234567');

    fireEvent.change(mobileInput(), { target: { value: '07712345678' } });

    // The positive control: separating the flag from the result must not cost
    // the operator the feedback that something is happening.
    expect(screen.getByText('Searching…')).toBeTruthy();
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('swaps the New Customer fields for the pick-list once a match lands', async () => {
    renderPopup();
    await typeUnknownMobile('0771234567');
    expect(screen.getByLabelText('Name')).toBeTruthy();

    // The other half: the fields are kept across a re-search, not pinned open
    // forever. A match still replaces them with the list of candidates.
    get.mockResolvedValue({
      items: [{ id: 'cus_9', name: 'Kamal Silva', mobile: '0779999999' }],
    });
    fireEvent.change(mobileInput(), { target: { value: '0779999999' } });

    await waitFor(() => expect(screen.getByRole('button', { name: /Kamal Silva/ })).toBeTruthy());
    expect(screen.queryByLabelText('Name')).toBeNull();
  });

  it('clears the result when the number is cut back below the search threshold', async () => {
    renderPopup();
    await typeUnknownMobile('0771234567');

    fireEvent.change(mobileInput(), { target: { value: '07' } });

    // Nothing has been looked up, so there is no result to keep showing.
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.queryByText('Searching…')).toBeNull();
  });
});

// ── Choosing an existing customer ────────────────────────────────────────────
//
// The lookup OFFERS matches; it never decides. The old dialog pinned the first
// hit as "Customer found", which looked done while being silently wrong for a
// shared or mistyped number. The standard POS flow is pick-list → tap → pinned
// card with a Change affordance, and New Customer stays reachable throughout.

const addressInput = () => screen.getByLabelText('Delivery address') as HTMLTextAreaElement;
const useCustomerButton = () =>
  screen.getByRole('button', { name: /Use customer/ }) as HTMLButtonElement;
const matchRow = (name: RegExp) => screen.getByRole('button', { name });

const FOUND_WITH_ADDRESS = {
  items: [
    {
      id: 'cus_9',
      name: 'Kamal Silva',
      mobile: '0779999999',
      street: '12 Galle Rd',
      city: 'Colombo',
    },
  ],
};

const FOUND_WITHOUT_ADDRESS = {
  items: [{ id: 'cus_8', name: 'Sunil Perera', mobile: '0778888888' }],
};

const TWO_MATCHES = {
  items: [
    { id: 'cus_8', name: 'Sunil Perera', mobile: '0778888888' },
    { id: 'cus_9', name: 'Kamal Silva', mobile: '0778888899' },
  ],
};

describe('the pick-list offers matches without deciding', () => {
  it('lists every candidate and pins none of them', async () => {
    renderPopup();
    get.mockResolvedValue(TWO_MATCHES);
    fireEvent.change(mobileInput(), { target: { value: '07788888' } });
    await waitFor(() => expect(matchRow(/Sunil Perera/)).toBeTruthy());

    expect(matchRow(/Kamal Silva/)).toBeTruthy();
    // Nothing chosen yet, so there is nothing to continue with.
    expect(screen.queryByRole('button', { name: /Use customer/ })).toBeNull();
  });

  it('pins the tapped customer as a card, and hands over exactly that record', async () => {
    const onChoose = vi.fn();
    renderPopup('TAKEAWAY', onChoose);
    get.mockResolvedValue(TWO_MATCHES);
    fireEvent.change(mobileInput(), { target: { value: '07788888' } });
    await waitFor(() => expect(matchRow(/Kamal Silva/)).toBeTruthy());

    fireEvent.click(matchRow(/Kamal Silva/));

    expect(screen.getByText('Customer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();
    fireEvent.click(useCustomerButton());
    expect(onChoose).toHaveBeenCalledWith({
      customerId: 'cus_9',
      name: 'Kamal Silva',
      phone: '0778888899',
      deliveryAddress: undefined,
    });
  });

  it('mirrors the picked customer number into the field, clearing the length warning', async () => {
    renderPopup();
    get.mockResolvedValue(FOUND_WITH_ADDRESS);
    fireEvent.change(mobileInput(), { target: { value: '07799' } });
    await waitFor(() => expect(matchRow(/Kamal Silva/)).toBeTruthy());
    // The prefix that surfaced the match is legitimately "too short"…
    expect(screen.getByText('Mobile number needs at least 9 digits.')).toBeTruthy();

    fireEvent.click(matchRow(/Kamal Silva/));

    // …but once a customer is pinned, the field shows their number, and a
    // warning about the abandoned prefix would be noise.
    expect(mobileInput().value).toBe('0779999999');
    expect(screen.queryByText(/Mobile number needs/)).toBeNull();
  });

  it('unpins when the number is edited — a new search is a new question', async () => {
    renderPopup();
    get.mockResolvedValue(TWO_MATCHES);
    fireEvent.change(mobileInput(), { target: { value: '07788888' } });
    await waitFor(() => expect(matchRow(/Sunil Perera/)).toBeTruthy());
    fireEvent.click(matchRow(/Sunil Perera/));
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();

    fireEvent.change(mobileInput(), { target: { value: '077888881' } });

    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  });

  it('keeps New Customer reachable while matches exist, and offers a way back', async () => {
    renderPopup();
    get.mockResolvedValue(TWO_MATCHES);
    fireEvent.change(mobileInput(), { target: { value: '0778888800' } });
    await waitFor(() => expect(matchRow(/Sunil Perera/)).toBeTruthy());

    // Right number, wrong person — the matches must not trap the cashier.
    fireEvent.click(screen.getByRole('button', { name: /New customer with this number/ }));
    expect(screen.getByLabelText('Name')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sunil Perera/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Back to matches/ }));
    expect(matchRow(/Sunil Perera/)).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
  });

  it('completes a half-typed number from a single match when starting a new customer', async () => {
    renderPopup();
    get.mockResolvedValue(FOUND_WITH_ADDRESS);
    // The prefix surfaced Kamal; "this number" can only mean his — a family
    // member ordering from the same phone should not retype what the till
    // just displayed (PO decision, 2026-09-02).
    fireEvent.change(mobileInput(), { target: { value: '07799' } });
    await waitFor(() => expect(matchRow(/Kamal Silva/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /New customer with this number/ }));

    expect(mobileInput().value).toBe('0779999999');
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('leaves the typed prefix alone when the matches carry different numbers', async () => {
    renderPopup();
    get.mockResolvedValue(TWO_MATCHES);
    fireEvent.change(mobileInput(), { target: { value: '07788' } });
    await waitFor(() => expect(matchRow(/Sunil Perera/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /New customer with this number/ }));

    // Two different full numbers on screen — there is no "this number" to
    // take, so nothing is guessed onto the new record.
    expect(mobileInput().value).toBe('07788');
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('never replaces a complete number the cashier typed', async () => {
    renderPopup();
    get.mockResolvedValue(FOUND_WITH_ADDRESS);
    // A valid number that merely resembles Kamal's — the cashier meant what
    // they typed, and the match must not overwrite it.
    fireEvent.change(mobileInput(), { target: { value: '0779999900' } });
    await waitFor(() => expect(matchRow(/Kamal Silva/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /New customer with this number/ }));

    expect(mobileInput().value).toBe('0779999900');
  });
});

// ── Delivery mode ────────────────────────────────────────────────────────────
//
// The address belongs to the order, not the customer record. The original
// markup nested the address textarea inside the New Customer block, so the
// moment the lookup matched a customer the field unmounted — the typed address
// vanished, and "Use customer" let a delivery order through with no
// destination at all.

describe('delivery keeps the address across a customer match', () => {
  it('leaves the field mounted, holding what was typed, through match and pick', async () => {
    renderPopup('THIRD_PARTY');
    fireEvent.change(addressInput(), { target: { value: '45/2 Temple Lane, Kandy' } });

    get.mockResolvedValue(FOUND_WITHOUT_ADDRESS);
    fireEvent.change(mobileInput(), { target: { value: '0778888888' } });
    await waitFor(() => expect(matchRow(/Sunil Perera/)).toBeTruthy());

    // The name form goes while the list is up; the destination must not.
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(addressInput().value).toBe('45/2 Temple Lane, Kandy');

    fireEvent.click(matchRow(/Sunil Perera/));
    expect(addressInput().value).toBe('45/2 Temple Lane, Kandy');
  });

  it('offers the saved address as the pre-selected destination, with no editable box', async () => {
    const onChoose = vi.fn();
    renderPopup('THIRD_PARTY', onChoose);
    get.mockResolvedValue(FOUND_WITH_ADDRESS);
    fireEvent.change(mobileInput(), { target: { value: '0779999999' } });
    await waitFor(() => expect(matchRow(/Kamal Silva/)).toBeTruthy());
    fireEvent.click(matchRow(/Kamal Silva/));

    const saved = screen.getByRole('radio', { name: /Saved address/ }) as HTMLInputElement;
    expect(saved.checked).toBe(true);
    expect(screen.getByText('12 Galle Rd, Colombo')).toBeTruthy();
    // No duplicate, editable copy of the address — the box appears only for
    // "a different address".
    expect(screen.queryByLabelText('Delivery address')).toBeNull();

    // Continuing delivers to the saved address, and the record needs no
    // backfill — it already has one.
    fireEvent.click(useCustomerButton());
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryAddress: '12 Galle Rd, Colombo' }),
    );
    expect(patch).not.toHaveBeenCalled();
  });

  it('reveals an empty box for a different address', async () => {
    renderPopup('THIRD_PARTY');
    get.mockResolvedValue(FOUND_WITH_ADDRESS);
    fireEvent.change(mobileInput(), { target: { value: '0779999999' } });
    await waitFor(() => expect(matchRow(/Kamal Silva/)).toBeTruthy());
    fireEvent.click(matchRow(/Kamal Silva/));

    fireEvent.click(screen.getByRole('radio', { name: /different address/ }));

    // Empty — nothing to delete before typing the one-off destination.
    expect(addressInput().value).toBe('');
    // And no destination chosen yet means no continuing yet.
    expect(useCustomerButton().disabled).toBe(true);
  });

  it('keeps a destination typed before the pick selected over the saved one', async () => {
    renderPopup('THIRD_PARTY');
    fireEvent.change(addressInput(), { target: { value: 'Office: 90 Union Pl' } });

    get.mockResolvedValue(FOUND_WITH_ADDRESS);
    fireEvent.change(mobileInput(), { target: { value: '0779999999' } });
    await waitFor(() => expect(matchRow(/Kamal Silva/)).toBeTruthy());
    fireEvent.click(matchRow(/Kamal Silva/));

    // The cashier already knew where this order goes; the saved address must
    // not shove their work aside.
    const other = screen.getByRole('radio', { name: /different address/ }) as HTMLInputElement;
    expect(other.checked).toBe(true);
    expect(addressInput().value).toBe('Office: 90 Union Pl');
  });
});

describe('delivery saves a new customer with their first address', () => {
  it('writes the typed address to the record as one street line', async () => {
    const onChoose = vi.fn();
    renderPopup('THIRD_PARTY', onChoose);
    // No match, so this order creates the customer — the address typed here
    // is the only chance to give the record one, and without it the next
    // delivery for this customer starts from a blank box.
    fireEvent.change(mobileInput(), { target: { value: '0766727512' } });
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Kasun Perera' } });
    fireEvent.change(addressInput(), { target: { value: '45/2 Temple Lane\nKandy' } });

    fireEvent.click(saveButton());

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    // Newlines collapse: the street column feeds one-line displays and QBO.
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      name: 'Kasun Perera',
      mobile: '0766727512',
      street: '45/2 Temple Lane, Kandy',
    });
    // The order itself still carries the address exactly as typed.
    await waitFor(() =>
      expect(onChoose).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryAddress: '45/2 Temple Lane\nKandy' }),
      ),
    );
  });
});

describe('a prefill belongs to the customer it came from', () => {
  // One number, two people, only one with a saved address — the shape that
  // let Kamal's address ride along onto Sunil's order via Change.
  const MIXED_MATCHES = {
    items: [
      { id: 'cus_8', name: 'Sunil Perera', mobile: '0778888888' },
      {
        id: 'cus_9',
        name: 'Kamal Silva',
        mobile: '0778888899',
        street: '12 Galle Rd',
        city: 'Colombo',
      },
    ],
  };

  it('gives the next customer a clean slate — no address rides along via Change', async () => {
    renderPopup('THIRD_PARTY');
    get.mockResolvedValue(MIXED_MATCHES);
    fireEvent.change(mobileInput(), { target: { value: '07788888' } });
    await waitFor(() => expect(matchRow(/Kamal Silva/)).toBeTruthy());

    fireEvent.click(matchRow(/Kamal Silva/));
    expect(screen.getByText('12 Galle Rd, Colombo')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await waitFor(() => expect(matchRow(/Sunil Perera/)).toBeTruthy());
    fireEvent.click(matchRow(/Sunil Perera/));

    // Kamal's address must not become Sunil's delivery: Sunil has no saved
    // address, so the plain box comes back — empty.
    expect(addressInput().value).toBe('');
  });

  it('keeps a hand-typed one-off address through the same switch', async () => {
    renderPopup('THIRD_PARTY');
    get.mockResolvedValue(MIXED_MATCHES);
    fireEvent.change(mobileInput(), { target: { value: '07788888' } });
    await waitFor(() => expect(matchRow(/Kamal Silva/)).toBeTruthy());
    fireEvent.click(matchRow(/Kamal Silva/));

    // The cashier redirected this order on purpose; that work survives.
    fireEvent.click(screen.getByRole('radio', { name: /different address/ }));
    fireEvent.change(addressInput(), { target: { value: 'Office: 90 Union Pl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await waitFor(() => expect(matchRow(/Sunil Perera/)).toBeTruthy());
    fireEvent.click(matchRow(/Sunil Perera/));

    expect(addressInput().value).toBe('Office: 90 Union Pl');
  });
});

describe('an address-less record adopts its first delivery address', () => {
  it('backfills the record when Use customer completes with a typed address', async () => {
    const onChoose = vi.fn();
    renderPopup('THIRD_PARTY', onChoose);
    get.mockResolvedValue(FOUND_WITHOUT_ADDRESS);
    fireEvent.change(mobileInput(), { target: { value: '0778888888' } });
    await waitFor(() => expect(matchRow(/Sunil Perera/)).toBeTruthy());
    fireEvent.click(matchRow(/Sunil Perera/));
    fireEvent.change(addressInput(), { target: { value: '45/2 Temple Lane\nKandy' } });

    fireEvent.click(useCustomerButton());

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[0]).toBe('/customers/cus_8');
    expect(patch.mock.calls[0]?.[1]).toEqual({ street: '45/2 Temple Lane, Kandy' });
    // The order continues regardless of the backfill round-trip.
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cus_8', deliveryAddress: '45/2 Temple Lane\nKandy' }),
    );
  });

  it('never rewrites a record that already has an address', async () => {
    const onChoose = vi.fn();
    renderPopup('THIRD_PARTY', onChoose);
    get.mockResolvedValue(FOUND_WITH_ADDRESS);
    fireEvent.change(mobileInput(), { target: { value: '0779999999' } });
    await waitFor(() => expect(matchRow(/Kamal Silva/)).toBeTruthy());
    fireEvent.click(matchRow(/Kamal Silva/));

    // A one-off redirect: office today, home unchanged.
    fireEvent.click(screen.getByRole('radio', { name: /different address/ }));
    fireEvent.change(addressInput(), { target: { value: 'Office: 90 Union Pl' } });
    fireEvent.click(useCustomerButton());

    expect(patch).not.toHaveBeenCalled();
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryAddress: 'Office: 90 Union Pl' }),
    );
  });
});

describe('delivery requires a destination even for an existing customer', () => {
  it('blocks Use customer while the address is empty, and never calls onChoose', async () => {
    const onChoose = vi.fn();
    renderPopup('THIRD_PARTY', onChoose);
    get.mockResolvedValue(FOUND_WITHOUT_ADDRESS);
    fireEvent.change(mobileInput(), { target: { value: '0778888888' } });
    await waitFor(() => expect(matchRow(/Sunil Perera/)).toBeTruthy());
    fireEvent.click(matchRow(/Sunil Perera/));

    // The address input must still be there to type into — cus_8 has no
    // saved address, which is exactly the reported bug's shape.
    expect(addressInput()).toBeTruthy();
    expect(useCustomerButton().disabled).toBe(true);
    // The handler guard, for paths that bypass the disabled attribute.
    fireEvent.click(useCustomerButton());
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('continues with the address on the chosen customer once one is entered', async () => {
    const onChoose = vi.fn();
    renderPopup('THIRD_PARTY', onChoose);
    get.mockResolvedValue(FOUND_WITHOUT_ADDRESS);
    fireEvent.change(mobileInput(), { target: { value: '0778888888' } });
    await waitFor(() => expect(matchRow(/Sunil Perera/)).toBeTruthy());
    fireEvent.click(matchRow(/Sunil Perera/));

    fireEvent.change(addressInput(), { target: { value: '45/2 Temple Lane, Kandy' } });
    expect(useCustomerButton().disabled).toBe(false);

    fireEvent.click(useCustomerButton());
    expect(onChoose).toHaveBeenCalledWith({
      customerId: 'cus_8',
      name: 'Sunil Perera',
      phone: '0778888888',
      deliveryAddress: '45/2 Temple Lane, Kandy',
    });
  });
});
