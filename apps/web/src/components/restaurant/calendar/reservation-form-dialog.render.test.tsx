/**
 * The reservation form after its 2026-09-03 fixes, pinned in pairs:
 *
 * - The customer match list reads the number a record actually answers to
 *   (`mobile ?? phone`) — POS-captured customers only carry `mobile`, and the
 *   old `.phone`-only read showed them as blank rows and prefilled nothing.
 * - Booking leaves a customer record behind: an exact digit match links, no
 *   match creates, and a directory failure must not cost the booking.
 * - The edit path sends phone/notes/customerId EXPLICITLY — `?? undefined`
 *   made clearing them silent no-ops, because JSON drops undefined keys.
 * - Client validation mirrors the server: phone digit bounds, party 1–200,
 *   and the 15-minute past grace — with reasons, not just a dead button.
 * - Capacity is a warning, never a block (joined tables exist).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/auth';
import type { ManagedCustomer } from '@/lib/customers-api';
import type { ReservationView, RestaurantTableView, DiningAreaView } from '@/lib/restaurant/types';

// ── boundaries ───────────────────────────────────────────────────────────────

const createFn = vi.fn();
const updateFn = vi.fn();
vi.mock('@/lib/restaurant/api', () => ({
  reservations: {
    create: (...args: unknown[]) => createFn(...args),
    update: (...args: unknown[]) => updateFn(...args),
  },
}));

const fetchCustomersFn = vi.fn();
const createCustomerFn = vi.fn();
vi.mock('@/lib/customers-api', () => ({
  fetchCustomers: (...args: unknown[]) => fetchCustomersFn(...args),
  createCustomer: (...args: unknown[]) => createCustomerFn(...args),
}));

const { ReservationFormDialog, toDateInputValue } = await import('./reservation-form-dialog');

const SESSION = { token: 'tok' } as unknown as Session;

// ── fixtures ─────────────────────────────────────────────────────────────────

const AREAS = [{ id: 'area_1', name: 'Main' }] as unknown as DiningAreaView[];
const TABLES = [
  { id: 'tbl_1', code: 'T1', label: null, capacity: 4, areaId: 'area_1' },
] as unknown as RestaurantTableView[];

function customer(overrides: Partial<ManagedCustomer> & { id: string }): ManagedCustomer {
  return { name: 'Someone', phone: null, mobile: null, ...overrides } as ManagedCustomer;
}

function dayFromNow(days: number, hours = 19): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hours, 0, 0, 0);
  return d;
}

const emptyPage = { items: [], total: 0, page: 1, pageSize: 3 };

function renderCreate() {
  return render(
    <ReservationFormDialog
      session={SESSION}
      branchId="brn_1"
      tables={TABLES}
      areas={AREAS}
      hours={null}
      defaultDate={toDateInputValue(dayFromNow(1))}
      onClose={() => undefined}
      onSaved={() => undefined}
    />,
  );
}

const nameInput = () => screen.getByPlaceholderText('Nimal Perera');
const phoneInput = () => screen.getByPlaceholderText('0771234567') as HTMLInputElement;
const searchInput = () => screen.getByPlaceholderText('Search by name or phone…');
const partyInput = () => document.querySelector('input[type=number]') as HTMLInputElement;
// Date and time are chip strips (data-date / data-time); selects, in layout
// order, are [0] table, [1] duration.
const dateChips = () => [...document.querySelectorAll<HTMLButtonElement>('[data-date]')];
const timeChips = () => [...document.querySelectorAll<HTMLButtonElement>('[data-time]')];
const durationSelect = () => document.querySelectorAll('select')[1]!;
const bookButton = () => screen.getByRole('button', { name: 'Book table' }) as HTMLButtonElement;

beforeEach(() => {
  createFn.mockReset();
  createFn.mockResolvedValue({});
  updateFn.mockReset();
  updateFn.mockResolvedValue({});
  fetchCustomersFn.mockReset();
  fetchCustomersFn.mockResolvedValue(emptyPage);
  createCustomerFn.mockReset();
  createCustomerFn.mockResolvedValue(customer({ id: 'c_new' }));
});

afterEach(() => {
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('finding an existing customer', () => {
  it('shows and prefills the number the record answers to — mobile included', async () => {
    fetchCustomersFn.mockResolvedValue({
      ...emptyPage,
      items: [
        // The till's own customers: number lives in `mobile`, phone is null.
        customer({ id: 'c1', name: 'Kasun', mobile: '0771234567' }),
        // An imported one: only `phone`.
        customer({ id: 'c2', name: 'Lahiru', phone: '0112223344' }),
      ],
    });
    renderCreate();

    fireEvent.change(searchInput(), { target: { value: 'ka' } });
    await waitFor(() => expect(screen.getByText('Kasun')).toBeTruthy(), { timeout: 2000 });
    // Both rows show their number, whichever column holds it.
    expect(screen.getByText('0771234567')).toBeTruthy();
    expect(screen.getByText('0112223344')).toBeTruthy();

    fireEvent.click(screen.getByText('Kasun'));
    // The pick mirrors the MOBILE into the phone field — this was blank before.
    expect(phoneInput().value).toBe('0771234567');
    expect(screen.getByText(/Linked to customer record/)).toBeTruthy();
  });
});

describe('phone validation', () => {
  it('polices digit bounds with a reason, and strips what a phone cannot contain', () => {
    renderCreate();
    fireEvent.change(nameInput(), { target: { value: 'Nimal' } });

    fireEvent.change(phoneInput(), { target: { value: 'abc077' } });
    // Letters never enter the field…
    expect(phoneInput().value).toBe('077');
    // …and a short number blocks with a message, not a dead button.
    expect(screen.getByText(/needs at least 9 digits/)).toBeTruthy();
    expect(bookButton().disabled).toBe(true);

    fireEvent.change(phoneInput(), { target: { value: '0771234567' } });
    expect(screen.queryByText(/needs at least 9 digits/)).toBeNull();
    expect(bookButton().disabled).toBe(false);
  });
});

describe('the slot cannot be in the past (server grace mirrored)', () => {
  it('offers no past date on create — today leads the strip', () => {
    renderCreate();
    const todayStr = toDateInputValue(new Date());
    const values = dateChips().map((c) => c.dataset.date!);

    expect(values[0]).toBe(todayStr);
    // Lexicographic works for YYYY-MM-DD: nothing offered precedes today.
    expect(values.every((v) => v >= todayStr)).toBe(true);
    expect(screen.getByText('Today')).toBeTruthy();
  });

  it("offers only slots that are still bookable on today's date, inside the hours window", () => {
    renderCreate();
    const todayStr = toDateInputValue(new Date());
    fireEvent.click(dateChips().find((c) => c.dataset.date === todayStr)!);

    const cutoff = Date.now() - 15 * 60_000 - 1000;
    for (const chip of timeChips()) {
      // The selected chip is exempt: the pre-selected 19:00 stays listed even
      // when the test runs in the evening (truth outranks the menu).
      if (chip.dataset.active === 'true') continue;
      const v = chip.dataset.time!;
      expect(new Date(`${todayStr}T${v}`).getTime()).toBeGreaterThan(cutoff);
      // Inside the fallback window (08:00 – one slot before 23:00 close).
      expect(v >= '08:00' && v <= '22:30').toBe(true);
    }
  });

  it('blocks MOVING an old booking into the past, while a notes-only edit stays allowed', async () => {
    const pastStart = dayFromNow(-1);
    const past: ReservationView = {
      id: 'rsv_old',
      branchId: 'brn_1',
      tableId: 'tbl_1',
      reservationNumber: 'RSV-000009',
      customerId: null,
      customerName: 'Kasun',
      customerPhone: null,
      partySize: 2,
      startAt: pastStart.toISOString(),
      endAt: new Date(pastStart.getTime() + 90 * 60_000).toISOString(),
      status: 'SEATED',
      notes: null,
      createdByUserId: null,
      createdAt: new Date().toISOString(),
    } as ReservationView;
    render(
      <ReservationFormDialog
        session={SESSION}
        branchId="brn_1"
        tables={TABLES}
        areas={AREAS}
        hours={null}
        defaultDate={toDateInputValue(pastStart)}
        existing={past}
        onClose={() => undefined}
        onSaved={() => undefined}
      />,
    );
    const save = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;

    // Untouched, the slot has not moved: the server allows the edit, so the
    // form must too (this is how the notes of a booking underway get fixed).
    expect(screen.queryByText('That time has already passed.')).toBeNull();
    expect(save.disabled).toBe(false);

    // Stretching the duration MOVES the slot — now the past matters.
    fireEvent.change(durationSelect(), { target: { value: '120' } });
    expect(screen.getByText('That time has already passed.')).toBeTruthy();
    expect(save.disabled).toBe(true);
  });
});

describe('duration labels', () => {
  it('prints half-hours once — "1.5 h", never "1.5.5 h"', () => {
    renderCreate();
    const labels = [...durationSelect().querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toContain('1.5 h');
    expect(labels).toContain('2.5 h');
    expect(labels.some((l) => l?.includes('.5.5'))).toBe(false);
  });
});

describe('party size', () => {
  it('caps at 200 with a reason, and warns — without blocking — past table capacity', () => {
    renderCreate();
    fireEvent.change(nameInput(), { target: { value: 'Nimal' } });

    fireEvent.change(partyInput(), { target: { value: '250' } });
    expect(screen.getByText('Maximum 200 guests.')).toBeTruthy();
    expect(bookButton().disabled).toBe(true);

    // 6 on a 4-seat table: a warning the host can override, not a wall —
    // parties larger than the table are seated on joined tables every night.
    fireEvent.change(partyInput(), { target: { value: '6' } });
    expect(screen.queryByText('Maximum 200 guests.')).toBeNull();
    expect(screen.getByText(/T1 seats 4 — a party of 6 may not fit\./)).toBeTruthy();
    expect(bookButton().disabled).toBe(false);

    fireEvent.change(partyInput(), { target: { value: '4' } });
    expect(screen.queryByText(/may not fit/)).toBeNull();
  });
});

describe('booking leaves a customer record behind', () => {
  const fill = () => {
    fireEvent.change(nameInput(), { target: { value: 'Nimal' } });
    fireEvent.change(phoneInput(), { target: { value: '0771234567' } });
  };

  it('creates the customer and links the booking when the number is new', async () => {
    renderCreate();
    fill();
    fireEvent.click(bookButton());

    await waitFor(() => expect(createFn).toHaveBeenCalled());
    expect(createCustomerFn).toHaveBeenCalledWith(SESSION, {
      name: 'Nimal',
      mobile: '0771234567',
    });
    expect(createFn.mock.calls[0]![2]).toMatchObject({ customerId: 'c_new' });
  });

  it('links an exact digit match instead of creating a duplicate', async () => {
    fetchCustomersFn.mockResolvedValue({
      ...emptyPage,
      // Same number, stored formatted — digits decide, not the string.
      items: [customer({ id: 'c_exist', name: 'Kasun', mobile: '077-123 4567' })],
    });
    renderCreate();
    fill();
    fireEvent.click(bookButton());

    await waitFor(() => expect(createFn).toHaveBeenCalled());
    expect(createCustomerFn).not.toHaveBeenCalled();
    expect(createFn.mock.calls[0]![2]).toMatchObject({ customerId: 'c_exist' });
  });

  it('books unlinked when the directory refuses — never costs the reservation', async () => {
    createCustomerFn.mockRejectedValue(new Error('403'));
    renderCreate();
    fill();
    fireEvent.click(bookButton());

    await waitFor(() => expect(createFn).toHaveBeenCalled());
    expect(createFn.mock.calls[0]![2].customerId).toBeUndefined();
  });
});

describe('the edit path sends what the fields hold', () => {
  const startAt = dayFromNow(1);
  const EXISTING: ReservationView = {
    id: 'rsv_1',
    branchId: 'brn_1',
    tableId: 'tbl_1',
    reservationNumber: 'RSV-000001',
    customerId: 'c1',
    customerName: 'Kasun',
    customerPhone: '0771234567',
    partySize: 2,
    startAt: startAt.toISOString(),
    endAt: new Date(startAt.getTime() + 90 * 60_000).toISOString(),
    status: 'BOOKED',
    notes: 'window seat',
    createdByUserId: null,
    createdAt: new Date().toISOString(),
  } as ReservationView;

  const renderEdit = () =>
    render(
      <ReservationFormDialog
        session={SESSION}
        branchId="brn_1"
        tables={TABLES}
        areas={AREAS}
        hours={null}
        defaultDate={toDateInputValue(startAt)}
        existing={EXISTING}
        onClose={() => undefined}
        onSaved={() => undefined}
      />,
    );

  it('clearing phone and notes, and Unlink, actually clear on the server', async () => {
    renderEdit();
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    fireEvent.change(phoneInput(), { target: { value: '' } });
    fireEvent.change(screen.getByPlaceholderText('Window seat, birthday cake at 8…'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    // The old `?? undefined` shape made all three silent no-ops: JSON drops
    // undefined keys and the server reads an absent field as "unchanged".
    await waitFor(() => expect(updateFn).toHaveBeenCalled());
    expect(updateFn.mock.calls[0]![2]).toMatchObject({
      customerId: null,
      customerPhone: '',
      notes: '',
    });
  });

  it('sends the untouched values explicitly, keeping them', async () => {
    renderEdit();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateFn).toHaveBeenCalled());
    expect(updateFn.mock.calls[0]![2]).toMatchObject({
      customerId: 'c1',
      customerPhone: '0771234567',
      notes: 'window seat',
    });
    // No directory write on edit — creation is a booking-time affordance.
    expect(createCustomerFn).not.toHaveBeenCalled();
  });
});
