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

function renderPopup() {
  return render(
    <CustomerCapturePopup
      session={SESSION}
      // Takeaway: Skip is offered, so the dialog is at its most permissive —
      // if validation holds here it holds in the stricter Delivery mode too.
      mode="TAKEAWAY"
      onChoose={vi.fn()}
      onBack={vi.fn()}
    />,
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
  // No existing customer, so the dialog reveals the New Customer fields.
  get.mockResolvedValue({ items: [] });
  post.mockResolvedValue({ id: 'cus_1', name: 'Nimal Perera' });
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

  it('hides the New Customer fields once a customer is actually found', async () => {
    renderPopup();
    await typeUnknownMobile('0771234567');
    expect(screen.getByLabelText('Name')).toBeTruthy();

    // The other half: the fields are kept across a re-search, not pinned open
    // forever. A match still replaces them with the found card.
    get.mockResolvedValue({
      items: [{ id: 'cus_9', name: 'Kamal Silva', mobile: '0779999999' }],
    });
    fireEvent.change(mobileInput(), { target: { value: '0779999999' } });

    await waitFor(() => expect(screen.getByText('Customer found')).toBeTruthy());
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
