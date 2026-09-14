/**
 * D183 — the Printing tab, where a printer is chosen rather than typed.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The payload is the assertion: every case that adds or edits a printer
 * asserts the EXACT body handed to `kitchenPrinters.create` / `.update`, so
 * a form that showed the discovered list but still sent the placeholder, or
 * that patched every field back, fails here rather than at the printer.
 *
 * Positives are paired with the state that must NOT appear: the Windows-name
 * picker for a USB printer AND its absence when nothing was reported; the
 * network chips AND their absence for a USB kind; a patch that carries the
 * changed address AND no unchanged field.
 *
 * The API module is mocked; the tab's own state, the code suggestion, the
 * virtual-printer ordering and the patch diff run for real.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmProvider } from '@/components/ui/confirm';
import { AGENT_POLL_MS, PrintingTab, agentApiUrl } from './printing-tab';
import { kitchenPrinters, kitchenStations, printing } from '@/lib/restaurant/api';
import type {
  KitchenPrinterView,
  KitchenStationView,
  PrintAgentView,
  PrinterDiscoveryView,
} from '@/lib/restaurant/types';

vi.mock('@/lib/restaurant/api', () => ({
  kitchenPrinters: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    setStations: vi.fn(),
    testPrint: vi.fn(),
    remove: vi.fn(),
  },
  kitchenStations: { list: vi.fn() },
  printing: {
    agents: vi.fn(),
    queue: vi.fn(),
    job: vi.fn(),
    retryJob: vi.fn(),
    pairAgent: vi.fn(),
    revokeAgent: vi.fn(),
    removeAgent: vi.fn(),
    discover: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

const session = {
  token: 'tok',
  user: { id: 'u1', tenantId: 't1', role: 'OWNER' as const, permissions: [] },
} as never;

const BRANCH = 'brn_test';

const STATIONS: KitchenStationView[] = [
  { id: 'st_main', branchId: BRANCH, code: 'KIT', name: 'Main Kitchen', category: 'KITCHEN', isActive: true, createdAt: '', updatedAt: '' },
  { id: 'st_grill', branchId: BRANCH, code: 'GRL', name: 'Grill', category: 'GRILL', isActive: true, createdAt: '', updatedAt: '' },
];

const Q80B: KitchenPrinterView = {
  id: 'prn_q80b',
  branchId: BRANCH,
  code: 'KITCHEN-1',
  name: 'Kitchen XP-Q80B',
  kind: 'ESC_POS_NETWORK',
  address: '192.168.1.60:9100',
  isActive: true,
  role: 'KITCHEN',
  columns: 48,
  stationIds: ['st_main'],
};

const AGENT_ONLINE: PrintAgentView = {
  id: 'agt_1',
  name: 'Counter PC',
  isActive: true,
  lastSeenAt: new Date().toISOString(),
  version: '0.2.0',
  createdAt: '',
  online: true,
};

const DISCOVERY: PrinterDiscoveryView = {
  source: 'AGENT',
  agentName: 'Counter PC',
  at: new Date().toISOString(),
  port: 9100,
  // The office printer is listed FIRST here so the test proves the sort.
  printers: [
    { host: '192.168.0.75', port: 9100, latencyMs: 14, escpos: false },
    { host: '192.168.123.100', port: 9100, latencyMs: 4, escpos: true },
  ],
  localPrinters: [
    { name: 'Microsoft Print to PDF', driver: 'Microsoft Print To PDF', port: 'PORTPROMPT:' },
    { name: 'Xprinter XP-365B', driver: 'Xprinter XP-365B', port: 'USB002' },
    { name: 'Canon G3010 series', driver: 'Microsoft IPP Class Driver', port: 'WSD-1' },
  ],
};

const mock = {
  list: vi.mocked(kitchenPrinters.list),
  create: vi.mocked(kitchenPrinters.create),
  update: vi.mocked(kitchenPrinters.update),
  setStations: vi.mocked(kitchenPrinters.setStations),
  remove: vi.mocked(kitchenPrinters.remove),
  stations: vi.mocked(kitchenStations.list),
  agents: vi.mocked(printing.agents),
  queue: vi.mocked(printing.queue),
  discover: vi.mocked(printing.discover),
  pairAgent: vi.mocked(printing.pairAgent),
  removeAgent: vi.mocked(printing.removeAgent),
};

async function open(opts: { printers?: KitchenPrinterView[]; discovery?: PrinterDiscoveryView; agents?: PrintAgentView[] } = {}) {
  mock.list.mockResolvedValue(opts.printers ?? []);
  mock.stations.mockResolvedValue(STATIONS);
  mock.agents.mockResolvedValue(opts.agents ?? [AGENT_ONLINE]);
  mock.queue.mockResolvedValue({ pendingKitchenAttempts: 0, failedKitchenTickets: 0, pendingBillJobs: 0, failedBillJobs: [] });
  mock.discover.mockResolvedValue(opts.discovery ?? DISCOVERY);
  mock.create.mockImplementation(async (_s, _b, body) => ({ ...Q80B, ...body, id: 'prn_new', stationIds: [] }) as KitchenPrinterView);
  mock.update.mockImplementation(async (_s, _b, id, body) => ({ ...Q80B, ...body, id }) as KitchenPrinterView);
  mock.setStations.mockResolvedValue(Q80B);
  mock.remove.mockResolvedValue({ ok: true, unlinkedStations: 1, failedPendingJobs: 0 });
  render(
    <ConfirmProvider>
      <PrintingTab session={session} branchId={BRANCH} />
    </ConfirmProvider>,
  );
  await screen.findByText('Printers');
}

const openAddForm = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Add printer' }));
  await waitFor(() => expect(mock.discover).toHaveBeenCalledTimes(1));
  await screen.findByText(/Found by/);
};

const setKind = (value: string) =>
  fireEvent.change(screen.getByLabelText('Printer connection'), { target: { value } });

const clickAdd = () => fireEvent.click(screen.getAllByRole('button', { name: 'Add printer' }).at(-1)!);

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('PrintingTab — adding a printer from what the agent found', () => {
  it('opening the form asks for discovery once and suggests the next free code', async () => {
    await open({ printers: [Q80B] });
    expect(mock.discover).not.toHaveBeenCalled();
    await openAddForm();
    expect(mock.discover).toHaveBeenCalledWith(session, BRANCH);
    // KITCHEN-1 is taken by the Q80B, so the suggestion moves on.
    expect((screen.getByLabelText('Printer code') as HTMLInputElement).value).toBe('KITCHEN-2');
    // …and follows the role until the owner types a code.
    fireEvent.change(screen.getByLabelText('Printer role'), { target: { value: 'CASHIER' } });
    expect((screen.getByLabelText('Printer code') as HTMLInputElement).value).toBe('CASHIER-1');
  });

  it('a network printer: clicking a discovered host fills the address and is what gets created', async () => {
    await open();
    await openAddForm();
    const chips = screen.getByRole('group', { name: /found on the network/i });
    expect(within(chips).getByRole('button', { name: /192\.168\.123\.100/ })).toBeTruthy();
    // The Windows-name picker belongs to USB/office kinds only.
    expect(screen.queryByLabelText('Windows printer')).toBeNull();

    fireEvent.change(screen.getByLabelText('Printer name'), { target: { value: 'Kitchen' } });
    fireEvent.click(within(chips).getByRole('button', { name: /192\.168\.123\.100/ }));
    expect((screen.getByLabelText('Printer address') as HTMLInputElement).value).toBe('192.168.123.100:9100');

    clickAdd();
    await waitFor(() => expect(mock.create).toHaveBeenCalledTimes(1));
    expect(mock.create.mock.calls[0]![2]).toEqual({
      code: 'KITCHEN-1',
      name: 'Kitchen',
      kind: 'ESC_POS_NETWORK',
      address: '192.168.123.100:9100',
      role: 'KITCHEN',
      columns: 48,
    });
  });

  it('a device on 9100 that is not a receipt printer is offered last and labelled', async () => {
    await open();
    await openAddForm();
    const chips = within(screen.getByRole('group', { name: /found on the network/i })).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual([
      expect.stringContaining('192.168.123.100'),
      expect.stringContaining('192.168.0.75'),
    ]);
    expect(chips[0]!.textContent).toMatch(/receipt printer/);
    expect(chips[0]!.textContent).not.toMatch(/not a receipt printer/);
    expect(chips[1]!.textContent).toMatch(/not a receipt printer/);
    expect(chips[1]!.getAttribute('title')).toContain('Wi-Fi / office printer');
  });

  it('a USB printer: the agent PC’s printers are offered, real ones first, and the exact name is sent', async () => {
    await open();
    await openAddForm();
    setKind('ESC_POS_USB');
    const picker = screen.getByLabelText('Windows printer') as HTMLSelectElement;
    const labels = () => Array.from(picker.options).map((o) => o.textContent ?? '');
    // USB shows the USB printer and NOT the Wi-Fi Canon or the print-to-file
    // devices — those are on WSD / PORTPROMPT ports, not USB ones.
    expect(labels().some((l) => l.startsWith('Xprinter XP-365B'))).toBe(true);
    expect(labels().some((l) => l.startsWith('Canon G3010'))).toBe(false);
    expect(labels().some((l) => l.startsWith('Microsoft Print to PDF'))).toBe(false);
    // "Show all" brings the rest back, labelled and after the USB one.
    fireEvent.click(screen.getByRole('button', { name: /Show all 3 printers/ }));
    expect(labels().findIndex((l) => l.startsWith('Xprinter XP-365B'))).toBeLessThan(
      labels().findIndex((l) => l.startsWith('Canon G3010')),
    );
    expect(labels().find((l) => l.startsWith('Canon G3010'))).toMatch(/\(on the network\)/);
    expect(labels().find((l) => l.startsWith('Microsoft Print to PDF'))).toMatch(/\(virtual\)/);
    // No network chips for a spooler kind.
    expect(screen.queryByRole('group', { name: /found on the network/i })).toBeNull();

    fireEvent.change(screen.getByLabelText('Printer role'), { target: { value: 'CASHIER' } });
    fireEvent.change(screen.getByLabelText('Printer name'), { target: { value: 'Counter' } });
    fireEvent.change(picker, { target: { value: 'Xprinter XP-365B' } });
    clickAdd();
    await waitFor(() => expect(mock.create).toHaveBeenCalledTimes(1));
    expect(mock.create.mock.calls[0]![2]).toMatchObject({
      code: 'CASHIER-1',
      kind: 'ESC_POS_USB',
      address: 'Xprinter XP-365B',
      role: 'CASHIER',
    });
  });

  it('the Wi-Fi / office picker shows the network printer and not the USB one', async () => {
    await open();
    await openAddForm();
    setKind('A4_NETWORK');
    const picker = screen.getByLabelText('Windows printer') as HTMLSelectElement;
    const labels = Array.from(picker.options).map((o) => o.textContent ?? '');
    expect(labels.some((l) => l.startsWith('Canon G3010'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Xprinter XP-365B'))).toBe(false);
    expect(screen.getByText(/reaches over the network/)).toBeTruthy();
  });

  it('a spooler kind with printers reported but none of its own says so and offers all', async () => {
    await open({
      discovery: {
        ...DISCOVERY,
        localPrinters: [{ name: 'Xprinter XP-365B', driver: 'Xprinter XP-365B', port: 'USB002' }],
      },
    });
    await openAddForm();
    setKind('A4_NETWORK');
    expect(screen.queryByLabelText('Windows printer')).toBeNull();
    expect(screen.getByText(/None of the 1 printers on that PC is on the network/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all of them' }));
    const picker = screen.getByLabelText('Windows printer') as HTMLSelectElement;
    expect(Array.from(picker.options).some((o) => (o.textContent ?? '').includes('Xprinter XP-365B'))).toBe(true);
  });

  it('an office printer with nothing reported falls back to typing, and says why', async () => {
    await open({ discovery: { ...DISCOVERY, localPrinters: [] } });
    await openAddForm();
    setKind('A4_NETWORK');
    expect(screen.queryByLabelText('Windows printer')).toBeNull();
    expect(screen.getByText(/has not reported its printers yet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Printer name'), { target: { value: 'Grill' } });
    fireEvent.change(screen.getByLabelText('Printer address'), { target: { value: 'Canon G3010 series' } });
    clickAdd();
    await waitFor(() => expect(mock.create).toHaveBeenCalledTimes(1));
    expect(mock.create.mock.calls[0]![2]).toMatchObject({ kind: 'A4_NETWORK', address: 'Canon G3010 series' });
  });

  it('the how-to steps follow the connection kind', async () => {
    await open();
    await openAddForm();
    const howTo = () => screen.getByTestId('how-to-connect').textContent ?? '';
    expect(howTo()).toMatch(/router/i);
    expect(howTo()).not.toMatch(/DIP switch/);
    setKind('ESC_POS_USB');
    expect(howTo()).toMatch(/DIP switch pin 1 OFF/);
    expect(howTo()).not.toMatch(/router/i);
  });

  it('a spooler printer warns when no agent is online, and does not for a network one', async () => {
    await open({ agents: [{ ...AGENT_ONLINE, online: false }] });
    await openAddForm();
    expect(screen.queryByText(/needs the print agent online/)).toBeNull();
    setKind('ESC_POS_USB');
    expect(screen.getByText(/needs the print agent online/)).toBeTruthy();
  });

  it('a code the server would refuse is refused here first', async () => {
    await open();
    await openAddForm();
    fireEvent.change(screen.getByLabelText('Printer name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('Printer address'), { target: { value: '10.0.0.5' } });
    fireEvent.change(screen.getByLabelText('Printer code'), { target: { value: '1-KITCHEN' } });
    expect(screen.getByText(/starts with a letter/)).toBeTruthy();
    const add = screen.getAllByRole('button', { name: 'Add printer' }).at(-1) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(mock.create).not.toHaveBeenCalled();
  });
});

describe('PrintingTab — the print agent', () => {
  it('pairing shows the API address the installer must be given, the token, and one command', async () => {
    await open();
    mock.pairAgent.mockResolvedValue({ id: 'agt_new', name: 'Counter PC', token: 'pat_abc123' });
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Counter PC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair agent' }));
    const box = await screen.findByTestId('pairing-box');
    const url = agentApiUrl();
    // The app's own API base, without /v1 — what the first customer install got wrong.
    expect(url).toMatch(/^https?:\/\//);
    expect(url).not.toMatch(/\/v1\/?$/);
    expect(box.textContent).toContain(url);
    expect(box.textContent).toContain('pat_abc123');
    expect(box.textContent).toContain(`install.cmd -ApiUrl "${url}" -Token "pat_abc123" -Name "Counter PC"`);
    expect(mock.pairAgent).toHaveBeenCalledWith(session, BRANCH, 'Counter PC');
  });

  it('an agent that never checked in says so, with the address it must use', async () => {
    await open({ agents: [{ ...AGENT_ONLINE, online: false, lastSeenAt: null, version: null }] });
    expect(screen.getByText('Never checked in')).toBeTruthy();
    expect(screen.getByText(/different API address than/).textContent).toContain(agentApiUrl());
  });

  it('Remove asks, then deletes the agent and reloads — for a revoked one too', async () => {
    await open({ agents: [{ ...AGENT_ONLINE, isActive: false, online: false }] });
    mock.removeAgent.mockResolvedValue({ ok: true });
    expect(screen.getByText('Revoked')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove agent Counter PC' }));
    const dialog = await screen.findByRole('dialog');
    expect(mock.removeAgent).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove agent' }));
    await waitFor(() => expect(mock.removeAgent).toHaveBeenCalledWith(session, 'agt_1'));
    await waitFor(() => expect(mock.agents).toHaveBeenCalledTimes(2));
  });

  it('the Online badge appears by itself once the agent checks in — no reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await open({ agents: [{ ...AGENT_ONLINE, online: false, lastSeenAt: null }] });
      expect(screen.getByText('Offline')).toBeTruthy();
      mock.agents.mockResolvedValue([AGENT_ONLINE]);
      await vi.advanceTimersByTimeAsync(AGENT_POLL_MS + 50);
      await waitFor(() => expect(screen.getByText('Online')).toBeTruthy());
      expect(mock.agents.mock.calls.length).toBeGreaterThanOrEqual(2);
      // Only the agents (and, every third tick, the queue) are re-read — not the printers.
      expect(mock.list).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PrintingTab — removing a printer', () => {
  it('Remove asks first, names the stations that lose their printer, then deletes and reloads', async () => {
    await open({ printers: [Q80B] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kitchen XP-Q80B' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Remove Kitchen XP-Q80B?');
    expect(dialog.textContent).toContain('Main Kitchen will have no printer');
    expect(mock.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove printer' }));
    await waitFor(() => expect(mock.remove).toHaveBeenCalledWith(session, BRANCH, 'prn_q80b'));
    await waitFor(() => expect(mock.list).toHaveBeenCalledTimes(2));
  });

  it('cancelling the dialog deletes nothing', async () => {
    await open({ printers: [Q80B] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kitchen XP-Q80B' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.remove).not.toHaveBeenCalled();
    expect(mock.list).toHaveBeenCalledTimes(1);
  });
});

describe('PrintingTab — editing a printer', () => {
  it('Edit sends only the changed address, with the code fixed', async () => {
    await open({ printers: [Q80B] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Kitchen XP-Q80B' }));
    await screen.findByText(/Found by/);
    const codeField = screen.getByLabelText('Printer code') as HTMLInputElement;
    expect(codeField.disabled).toBe(true);
    expect(codeField.value).toBe('KITCHEN-1');

    const chips = screen.getByRole('group', { name: /found on the network/i });
    fireEvent.click(within(chips).getByRole('button', { name: /192\.168\.123\.100/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save printer' }));

    await waitFor(() => expect(mock.update).toHaveBeenCalledTimes(1));
    const [, , id, patch] = mock.update.mock.calls[0]!;
    expect(id).toBe('prn_q80b');
    expect(patch).toEqual({ address: '192.168.123.100:9100' });
    expect(mock.create).not.toHaveBeenCalled();
    // The list reloads so the row shows the new address.
    await waitFor(() => expect(mock.list).toHaveBeenCalledTimes(2));
  });

  it('Edit with nothing changed sends nothing', async () => {
    await open({ printers: [Q80B] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Kitchen XP-Q80B' }));
    await screen.findByText(/Found by/);
    fireEvent.click(screen.getByRole('button', { name: 'Save printer' }));
    await waitFor(() => expect(mock.list).toHaveBeenCalledTimes(2));
    expect(mock.update).not.toHaveBeenCalled();
  });
});
