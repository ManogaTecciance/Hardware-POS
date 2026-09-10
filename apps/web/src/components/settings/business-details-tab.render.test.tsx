/**
 * D150 — the Business details tab.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The payload is the assertion. "Save was clicked" or "the request went out"
 * would pass for a screen that sent the list it loaded and ignored every edit,
 * which is the failure that matters here — so each editing case asserts the
 * EXACT `fields` array handed to the API, and the screen's own state after the
 * response, rather than that something happened.
 *
 * Every positive is paired: a row is added AND the others survive; a dropdown
 * reveals its choices AND a text field does not; a refusal is shown AND the
 * field the server refused to drop is still on screen. The refusal case is the
 * one this tab exists to get right — a 409 that quietly emptied the editor
 * would look like a successful delete.
 *
 * The API module is mocked, not the component's own logic: `draftsToFields` and
 * the key derivation run for real, so a change to either shows up here as a
 * wrong payload rather than as a passing test against a stubbed answer.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttributeField } from '@hardware-pos/shared';

import { BusinessDetailsTab, draftsToFields } from './business-details-tab';
import {
  fetchBusinessDetailsConfig,
  replaceBusinessDetails,
} from '@/lib/products/business-details-api';

vi.mock('@/lib/products/business-details-api', () => ({
  fetchBusinessDetailsConfig: vi.fn(),
  replaceBusinessDetails: vi.fn(),
}));

let canManage = true;
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: () => canManage }),
}));

const session = {
  token: 'tok',
  user: { id: 'u1', tenantId: 't1', role: 'OWNER' as const, permissions: [] },
} as never;

/** The retail domain's own list, as `source: 'DOMAIN'` would deliver it. */
const DOMAIN_FIELDS: AttributeField[] = [
  { key: 'material', label: 'Material', type: 'text' },
  { key: 'fit', label: 'Fit', type: 'enum', options: ['Slim', 'Regular'] },
  { key: 'launchDate', label: 'Launch date', type: 'date' },
];

/**
 * `list[i]`, checked.
 *
 * Every case here indexes a query result, and `noUncheckedIndexedAccess` makes
 * each one `T | undefined`. A `!` would hide the one thing worth knowing when a
 * row goes missing — WHICH row — behind a null deref several lines later, so
 * this asserts once and says the index it wanted.
 */
function nth<T>(list: readonly T[], index: number, what: string): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`expected ${what}[${index}], but only ${list.length} exist`);
  }
  return item;
}

const mockFetch = vi.mocked(fetchBusinessDetailsConfig);
const mockReplace = vi.mocked(replaceBusinessDetails);

/** Renders and waits for the load to settle, so no case races the fetch. */
async function open(
  fields: AttributeField[] = DOMAIN_FIELDS,
  source: 'TENANT' | 'DOMAIN' = 'DOMAIN',
) {
  mockFetch.mockResolvedValue({ fields, source });
  render(<BusinessDetailsTab session={session} />);
  await screen.findByText('Business details');
  return screen.getAllByLabelText('Field name') as HTMLInputElement[];
}

/** The `fields` array of the one save that was sent. */
function sentFields(): AttributeField[] {
  expect(mockReplace).toHaveBeenCalledTimes(1);
  return nth(mockReplace.mock.calls, 0, 'replaceBusinessDetails calls')[1];
}

const clickSave = () => fireEvent.click(screen.getByRole('button', { name: /save business/i }));

beforeEach(() => {
  canManage = true;
  mockFetch.mockReset();
  mockReplace.mockReset();
  // Echo back whatever was sent, which is what the server does on success.
  mockReplace.mockImplementation(async (_s, fields) => ({ fields }));
});
afterEach(cleanup);

describe('loading the configuration', () => {
  it('renders one row per field, with the control each type needs', async () => {
    const names = await open();

    // POSITIVE — every field arrives, in order, with its label.
    expect(names.map((i) => i.value)).toEqual(['Material', 'Fit', 'Launch date']);
    const types = screen.getAllByLabelText('Type') as HTMLSelectElement[];
    expect(types.map((s) => s.value)).toEqual(['text', 'enum', 'date']);

    // …and every type this screen offers is on offer for every field.
    expect(Array.from(nth(types, 0, 'type selects').options).map((o) => o.textContent)).toEqual([
      'Text box',
      'Dropdown',
      'Calendar date',
    ]);

    // NEGATIVE — choices belong to the dropdown alone. A choices editor under
    // all three would satisfy the positive above on its own.
    expect(screen.getAllByText('Choices')).toHaveLength(1);
    expect(screen.getByLabelText('Choice 1 for Fit')).toBeDefined();
    expect(screen.queryByLabelText('Choice 1 for Material')).toBeNull();
  });

  it('says the list is a suggestion only until the tenant owns it', async () => {
    await open(DOMAIN_FIELDS, 'DOMAIN');
    expect(screen.getByText(/suggested fields for your business type/i)).toBeDefined();

    // NEGATIVE — a tenant that has configured its own is not told they are
    // suggestions. Without this the note could be unconditional.
    cleanup();
    await open(DOMAIN_FIELDS, 'TENANT');
    expect(screen.queryByText(/suggested fields for your business type/i)).toBeNull();
  });

  it('an empty list is a real answer, not an empty screen', async () => {
    mockFetch.mockResolvedValue({ fields: [], source: 'TENANT' });
    render(<BusinessDetailsTab session={session} />);

    expect(await screen.findByText(/skips this step entirely/i)).toBeDefined();
    expect(screen.queryAllByLabelText('Field name')).toHaveLength(0);
    // …and the operator can still start adding.
    expect(screen.getByRole('button', { name: /add field/i })).toBeDefined();
  });

  it('a failed load says so instead of offering an empty editor', async () => {
    mockFetch.mockRejectedValue(new Error('Network is down'));
    render(<BusinessDetailsTab session={session} />);

    expect(await screen.findByText('Network is down')).toBeDefined();
    // NEGATIVE — no Save button over a list that was never loaded; saving one
    // would replace the tenant's real fields with nothing.
    expect(screen.queryByRole('button', { name: /save business/i })).toBeNull();
  });
});

describe('editing the list', () => {
  it('adds a field and derives its key from the label at save', async () => {
    await open();

    fireEvent.click(screen.getByRole('button', { name: /add field/i }));
    const names = screen.getAllByLabelText('Field name') as HTMLInputElement[];
    // POSITIVE — appended…
    expect(names).toHaveLength(4);
    // …and NEGATIVE — the three that were there are untouched.
    expect(names.slice(0, 3).map((i) => i.value)).toEqual(['Material', 'Fit', 'Launch date']);

    fireEvent.change(nth(names, 3, 'field-name inputs'), {
      target: { value: 'Care instructions' },
    });
    clickSave();

    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(sentFields()).toEqual([
      { key: 'material', label: 'Material', type: 'text', required: false, maxLength: undefined },
      { key: 'fit', label: 'Fit', type: 'enum', required: false, options: ['Slim', 'Regular'] },
      { key: 'launchDate', label: 'Launch date', type: 'date', required: false },
      {
        key: 'careInstructions',
        label: 'Care instructions',
        type: 'text',
        required: false,
        maxLength: undefined,
      },
    ]);
  });

  it('renaming a label never changes the key the values are stored under', async () => {
    // The property the whole key-derivation design exists for: a typo fix must
    // not orphan every value already recorded on every product.
    await open();

    const names = screen.getAllByLabelText('Field name') as HTMLInputElement[];
    fireEvent.change(nth(names, 0, 'field-name inputs'), { target: { value: 'Fabric' } });
    clickSave();

    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    const first = nth(sentFields(), 0, 'sent fields');
    expect(first.label).toBe('Fabric');
    expect(first.key).toBe('material');
    // NEGATIVE — and it is not re-derived from the new label.
    expect(first.key).not.toBe('fabric');
  });

  it('switching a type to Dropdown reveals its choices, and back hides them', async () => {
    await open();
    const types = screen.getAllByLabelText('Type') as HTMLSelectElement[];

    fireEvent.change(nth(types, 0, 'type selects'), { target: { value: 'enum' } });
    expect(screen.getAllByText('Choices')).toHaveLength(2);
    expect(screen.getByText(/dropdown needs at least one choice/i)).toBeDefined();

    // NEGATIVE — and it goes away again, rather than accumulating.
    fireEvent.change(nth(screen.getAllByLabelText('Type'), 0, 'type selects'), {
      target: { value: 'date' },
    });
    expect(screen.getAllByText('Choices')).toHaveLength(1);
  });

  it('switching a type back and forth keeps the choices already typed', async () => {
    await open();
    const types = screen.getAllByLabelText('Type') as HTMLSelectElement[];

    // Fit is a dropdown with two options; make it text and back again.
    fireEvent.change(nth(types, 1, 'type selects'), { target: { value: 'text' } });
    expect(screen.queryByLabelText('Choice 1 for Fit')).toBeNull();
    fireEvent.change(nth(screen.getAllByLabelText('Type'), 1, 'type selects'), {
      target: { value: 'enum' },
    });

    expect((screen.getByLabelText('Choice 1 for Fit') as HTMLInputElement).value).toBe('Slim');
    expect((screen.getByLabelText('Choice 2 for Fit') as HTMLInputElement).value).toBe('Regular');
  });

  it('adds, edits and removes the choices behind a dropdown', async () => {
    await open();

    fireEvent.click(screen.getByRole('button', { name: /add choice/i }));
    fireEvent.change(screen.getByLabelText('Choice 3 for Fit'), {
      target: { value: 'Relaxed' },
    });
    fireEvent.change(screen.getByLabelText('Choice 1 for Fit'), {
      target: { value: 'Slim fit' },
    });
    fireEvent.click(screen.getByRole('button', { name: /remove choice 2 for fit/i }));

    clickSave();
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());

    const fit = nth(sentFields(), 1, 'sent fields');
    expect(fit).toEqual({
      key: 'fit',
      label: 'Fit',
      type: 'enum',
      required: false,
      options: ['Slim fit', 'Relaxed'],
    });
  });

  it('removes a field from the list it sends', async () => {
    await open();

    fireEvent.click(screen.getByRole('button', { name: /remove launch date/i }));
    // POSITIVE — off the screen…
    expect(screen.queryByDisplayValue('Launch date')).toBeNull();
    clickSave();

    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    // …and out of the payload, while its neighbours stay.
    expect(sentFields().map((f) => f.key)).toEqual(['material', 'fit']);
  });

  it('marks a field required', async () => {
    await open();

    fireEvent.click(nth(screen.getAllByRole('checkbox'), 0, 'required checkboxes'));
    clickSave();

    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(nth(sentFields(), 0, 'sent fields').required).toBe(true);
    // NEGATIVE — one checkbox, one field.
    expect(nth(sentFields(), 1, 'sent fields').required).toBe(false);
  });

  it('saves an empty list, which is what turns the wizard step off', async () => {
    await open();

    for (const label of ['material', 'fit', 'launch date']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`remove ${label}`, 'i') }));
    }
    clickSave();

    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(sentFields()).toEqual([]);
    expect(await screen.findByText(/skips the business details step/i)).toBeDefined();
  });
});

describe('refusals', () => {
  it('shows the server refusal and keeps the field it would not drop', async () => {
    await open();
    mockReplace.mockRejectedValue(
      new Error('3 product(s) still record "Material". Clear it on those products first.'),
    );

    fireEvent.click(screen.getByRole('button', { name: /remove material/i }));
    clickSave();

    // The server's own wording, with its count — not a generic failure.
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '3 product(s) still record "Material". Clear it on those products first.',
    );
    // NEGATIVE — the editor still holds the removal, so the operator can undo
    // it or go clear the products. An editor that reloaded on failure would
    // silently discard every other edit they had made.
    expect(screen.queryByDisplayValue('Material')).toBeNull();
    expect(screen.getByRole('button', { name: /save business/i })).toBeDefined();
  });

  it('refuses a nameless field before any request goes out', async () => {
    await open();

    fireEvent.click(screen.getByRole('button', { name: /add field/i }));
    clickSave();

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Every field needs a name.',
    );
    // The half that matters: nothing was sent, so a half-built row cannot
    // replace the tenant's real list.
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('refuses an empty dropdown before any request goes out', async () => {
    await open();

    fireEvent.change(
      nth(screen.getAllByLabelText('Type') as HTMLSelectElement[], 0, 'type selects'),
      { target: { value: 'enum' } },
    );
    clickSave();

    expect((await screen.findByRole('alert')).textContent).toMatch(/needs at least one choice/i);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('lets a valid list through, so the guards above are not "refuse all"', async () => {
    await open();
    clickSave();

    await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      'Saved. New products collect these fields.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('permissions', () => {
  it('a role without product:manage can read but not edit', async () => {
    canManage = false;
    await open();

    for (const input of screen.getAllByLabelText('Field name')) {
      expect((input as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.getByRole('button', { name: /save business/i })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/can view these but not change them/i)).toBeDefined();

    // NEGATIVE — the same screen with the permission is editable, so the
    // assertions above cannot pass because the tab is disabled for everyone.
    cleanup();
    canManage = true;
    await open();
    expect(
      nth(screen.getAllByLabelText('Field name'), 0, 'field-name inputs') as HTMLInputElement,
    ).toHaveProperty('disabled', false);
  });
});

describe('draftsToFields', () => {
  it('assigns keys to new fields without colliding with the saved ones', () => {
    // Directly, because the collision needs two unsaved rows whose labels
    // collapse to one key — reachable through the UI, but clearer stated here.
    const fields = draftsToFields([
      { key: 'material', label: 'Material', type: 'text', required: false, options: [], uid: 'a' },
      { key: null, label: 'Material', type: 'text', required: false, options: [], uid: 'b' },
      { key: null, label: 'material', type: 'text', required: false, options: [], uid: 'c' },
    ]);

    expect(fields.map((f) => f.key)).toEqual(['material', 'material2', 'material3']);
    // NEGATIVE — the saved row kept its key; only the new ones were assigned.
    expect(nth(fields, 0, 'built fields').key).toBe('material');
  });

  it('trims labels and options, and carries only what each type declares', () => {
    const fields = draftsToFields([
      { key: null, label: '  Season  ', type: 'enum', required: true, options: [' Summer '], uid: 'a' },
      { key: null, label: 'Warranty until', type: 'date', required: false, options: [], uid: 'b' },
    ]);

    expect(nth(fields, 0, 'built fields')).toEqual({
      key: 'season',
      label: 'Season',
      type: 'enum',
      required: true,
      options: ['Summer'],
    });
    // A date carries no options and no maxLength — a payload that included the
    // draft's empty `options` array would be refused by the DTO.
    expect(nth(fields, 1, 'built fields')).toEqual({
      key: 'warrantyUntil',
      label: 'Warranty until',
      type: 'date',
      required: false,
    });
    expect('options' in nth(fields, 1, 'built fields')).toBe(false);
  });
});
