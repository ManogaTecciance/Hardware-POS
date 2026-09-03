import type { BadgeTone } from '@/lib/restaurant/labels';
import type {
  PaymentMethod,
  UnifiedChannel,
  UnifiedOrderStatus,
  UnifiedSource,
} from '@/lib/restaurant/types';

export const UNIFIED_STATUS_LABELS: Record<UnifiedOrderStatus, string> = {
  DRAFT: 'Draft',
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  IN_PROGRESS: 'Preparing',
  READY: 'Ready',
  HANDED_OVER: 'Handed over',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const UNIFIED_STATUS_TONES: Record<UnifiedOrderStatus, BadgeTone> = {
  DRAFT: 'neutral',
  PENDING: 'warning',
  CONFIRMED: 'info',
  IN_PROGRESS: 'info',
  READY: 'positive',
  HANDED_OVER: 'muted',
  COMPLETED: 'muted',
  CANCELLED: 'danger',
};

export const UNIFIED_CHANNEL_LABELS: Record<UnifiedChannel, string> = {
  DINE_IN: 'Dining',
  TAKEAWAY: 'Takeaway',
  THIRD_PARTY: '3rd Party',
};

export const UNIFIED_CHANNEL_TONES: Record<UnifiedChannel, BadgeTone> = {
  DINE_IN: 'info',
  TAKEAWAY: 'positive',
  THIRD_PARTY: 'warning',
};

export const UNIFIED_SOURCE_LABELS: Record<UnifiedSource, string> = {
  POS: 'POS',
  WALK_IN: 'Walk-in',
  PHONE_ORDER: 'Phone',
  UBER_EATS: 'Uber Eats',
  PICKME_FOOD: 'PickMe Food',
  DOORDASH: 'DoorDash',
  MOCK: 'Mock',
  OTHER: 'Other',
};

export const PAYMENT_LABELS: Record<'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED', string> = {
  UNPAID: 'Unpaid',
  PARTIAL: 'Partial',
  PAID: 'Paid',
  REFUNDED: 'Refunded',
};

export const PAYMENT_TONES: Record<'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED', BadgeTone> = {
  UNPAID: 'danger',
  PARTIAL: 'warning',
  PAID: 'positive',
  REFUNDED: 'muted',
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  QR_PAYMENT: 'QR payment',
  CHECK: 'Cheque',
  STORE_CREDIT: 'Store credit',
  OTHER: 'Other',
};
