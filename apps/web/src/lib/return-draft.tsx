'use client';

import * as React from 'react';

import type { PaymentMethodCode } from './sales';
import type {
  ItemConditionCode,
  ReturnReasonCode,
  StockDispositionCode,
} from '@hardware-pos/shared';

/**
 * Return-draft state. Lives above the /returns/new flow and persists to
 * sessionStorage under its own key, so navigating between steps (and a browser
 * refresh in the same tab) preserves the selected sale, chosen items, quantities,
 * reasons/conditions, refund method and manager approval. It is entirely separate
 * from the POS cart (`pos-cart.tsx`) and never touches it. Cleared only after a
 * successful return or an explicit cancel.
 */
const STORAGE_KEY = 'hpos.returndraft';

export interface ReturnSelection {
  returnQuantity: number;
  returnReason?: ReturnReasonCode;
  itemCondition?: ItemConditionCode;
  stockDisposition?: StockDispositionCode;
  note?: string;
}

interface ReturnDraftState {
  originalSaleId: string;
  saleNumber: string;
  selections: Record<string, ReturnSelection>;
  refundMethod?: PaymentMethodCode;
  refundReference?: string;
  approvalToken?: string;
  notes?: string;
}

const EMPTY: ReturnDraftState = { originalSaleId: '', saleNumber: '', selections: {} };

interface ReturnDraftValue extends ReturnDraftState {
  hydrated: boolean;
  startDraft: (saleId: string, saleNumber: string) => void;
  setSelection: (saleItemId: string, patch: Partial<ReturnSelection>) => void;
  removeSelection: (saleItemId: string) => void;
  setRefund: (method: PaymentMethodCode | undefined, reference?: string) => void;
  setApprovalToken: (token: string | undefined) => void;
  setNotes: (notes: string) => void;
  clearDraft: () => void;
}

const ReturnDraftContext = React.createContext<ReturnDraftValue | null>(null);

export function ReturnDraftProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<ReturnDraftState>(EMPTY);
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (raw) setState({ ...EMPTY, ...(JSON.parse(raw) as ReturnDraftState) });
    } catch {
      /* ignore malformed storage */
    }
    setHydrated(true);
  }, []);

  // Guarded on `hydrated` for the same reason as the POS cart: an unguarded
  // mount-time write would overwrite the saved draft with EMPTY before it is
  // read back, discarding an in-progress return on a full page load.
  React.useEffect(() => {
    if (!hydrated) return;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state, hydrated]);

  const value = React.useMemo<ReturnDraftValue>(
    () => ({
      ...state,
      hydrated,
      startDraft: (saleId, saleNumber) =>
        setState((s) =>
          // Starting a different sale resets the draft; the same sale keeps it.
          s.originalSaleId === saleId ? s : { ...EMPTY, originalSaleId: saleId, saleNumber },
        ),
      setSelection: (saleItemId, patch) =>
        setState((s) => ({
          ...s,
          selections: {
            ...s.selections,
            [saleItemId]: { returnQuantity: 1, ...s.selections[saleItemId], ...patch },
          },
        })),
      removeSelection: (saleItemId) =>
        setState((s) => {
          const selections = { ...s.selections };
          delete selections[saleItemId];
          return { ...s, selections };
        }),
      setRefund: (method, reference) =>
        setState((s) => ({ ...s, refundMethod: method, refundReference: reference })),
      setApprovalToken: (token) => setState((s) => ({ ...s, approvalToken: token })),
      setNotes: (notes) => setState((s) => ({ ...s, notes })),
      clearDraft: () => setState(EMPTY),
    }),
    [state, hydrated],
  );

  return <ReturnDraftContext.Provider value={value}>{children}</ReturnDraftContext.Provider>;
}

export function useReturnDraft(): ReturnDraftValue {
  const ctx = React.useContext(ReturnDraftContext);
  if (!ctx) throw new Error('useReturnDraft must be used within a ReturnDraftProvider');
  return ctx;
}
