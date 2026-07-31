/** POS-level settings surfaced to the front-end. */
export interface AppSettings {
  currency: string;
  /** Sales tax rate as a percentage. 0 disables tax. */
  taxRatePercent: number;
  taxInclusive: boolean;
  /** Discount percentage above which manager approval is required. */
  highDiscountThresholdPercent: number;
  receiptFooter: string;
  /** Product-return configuration. */
  returns: ReturnSettings;
  /** Quotation defaults (validity, numbering, guard rails). */
  quotation: QuotationSettings;
  /** Document/letterhead + paper-format configuration for A4 PDFs and bills. */
  documents: DocumentSettings;
  /** Email / WhatsApp share configuration. */
  sharing: SharingSettings;
}

/** Quotation defaults. Owner/Admin tune these; the quotation service reads them. */
export interface QuotationSettings {
  /** Days a new quotation stays valid by default. */
  defaultValidityDays: number;
  /** Default terms shown on new quotations and the A4 document footer. */
  defaultTermsAndConditions: string;
  /** Human quotation numbering format. `{seq}` is the zero-padded counter. */
  numberFormat: string;
  /** Revision label format. `{number}` = base number, `{rev}` = revision index. */
  revisionFormat: string;
  /** Require a customer to be selected before a quotation can be saved. */
  requireCustomer: boolean;
  /** Allow quoting items that are out of stock. */
  allowWithoutStock: boolean;
  /** Show live stock availability on the quotation screen / document. */
  showStockAvailability: boolean;
  /** Allow the unit price to be overridden per line. */
  allowPriceOverride: boolean;
  /** Discount % (of grand total) above which manager approval is required. */
  requireApprovalAboveDiscountPercent: number;
}

/**
 * Letterhead + paper configuration for A4 documents (quotations and bills).
 * `companyName`/address/etc. fall back to the tenant / branch record when null —
 * see the documents service. Persistence is a TODO like the rest of settings.
 */
export interface DocumentSettings {
  /** Overrides the seller name on documents; null → tenant.name. */
  companyName: string | null;
  addressLine: string | null;
  phone: string | null;
  email: string | null;
  /** Seller tax/VAT registration number printed in the header. */
  taxNumber: string | null;
  /** Absolute/inline logo URL (data: URIs allowed) for the document header. */
  logoUrl: string | null;
  /** Uploaded authorized-signature image, drawn in the signature area. */
  signatureUrl: string | null;
  /** Uploaded company stamp/seal image, drawn near the signature area. */
  stampUrl: string | null;
  /** Footer/thank-you line on documents. */
  footerText: string;
  /**
   * Free-text note printed below the footer on invoices / bills — e.g. a
   * return policy ("Items must be returned within 7 days"). Blank hides it.
   */
  billNote: string;
  /** Document accent colour (headings, rules, totals). Hex, e.g. `#1d4ed8`. */
  accentColor: string;
  /** Header logo alignment. */
  logoAlignment: 'LEFT' | 'CENTER' | 'RIGHT';
  /** Header logo size. */
  logoSize: 'SMALL' | 'MEDIUM' | 'LARGE';
  /** Page-margin density for the A4 sheet. */
  marginStyle: 'COMPACT' | 'STANDARD' | 'SPACIOUS';
  /** Default paper size for the bill/quotation documents. */
  defaultPaperSize: 'A4' | 'THERMAL_80';
  orientation: 'PORTRAIT' | 'LANDSCAPE';
  showProductImages: boolean;
  showSku: boolean;
  showTaxColumn: boolean;
  showDiscountColumn: boolean;
  /** Show the customer's tax/VAT number in the bill-to block. */
  showCustomerTaxNumber: boolean;
  /** Print `Page X of Y` + generated timestamp in the PDF footer (multi-page). */
  showPageNumbers: boolean;
  /** Default final-bill format. A4 is the default for this client. */
  defaultBillFormat: 'A4' | 'THERMAL' | 'BOTH';
  /** Render authorized/customer signature areas in the footer. */
  signatureFields: boolean;
}

/**
 * Email / WhatsApp share configuration. Templates support the placeholders
 * `{customerName}`, `{quotationNumber}`, `{businessName}`, `{validUntil}`.
 */
export interface SharingSettings {
  emailSenderName: string;
  /** From address; null uses the configured mail-provider default. */
  emailSenderAddress: string | null;
  emailSubjectTemplate: string;
  emailBodyTemplate: string;
  whatsappMessageTemplate: string;
  /** Days a public share link remains valid. */
  shareLinkExpirationDays: number;
  /** Days a generated PDF is retained. */
  pdfStorageDurationDays: number;
}

/**
 * Configuration for the Product Return feature. Owner/Admin tune these; the
 * returns service reads them to decide when manager approval is required and
 * which refund methods are allowed. Persistence is still a TODO (the whole
 * settings service returns hardcoded defaults for now).
 */
export interface ReturnSettings {
  /** Days after the sale a return is allowed without manager approval. */
  returnPeriodDays: number;
  /** Max refund total (LKR) a cashier may process without manager approval. */
  cashierReturnValueLimit: number;
  /** Whether store / customer credit refunds are offered at all. */
  allowStoreCredit: boolean;
  /** Refund methods offered in the UI (PaymentMethod values). */
  allowedRefundMethods: string[];
  /** Require manager approval for damaged / opened / used / non-resellable items. */
  requireApprovalForNonGoodCondition: boolean;
  /** Require manager approval when any returned line uses the "Other" reason. */
  requireApprovalForOtherReason: boolean;
  /**
   * QuickBooks account a Refund Receipt deposits from (DepositToAccountRef). Left
   * null uses the QuickBooks company default. TODO(accountant): confirm mapping.
   */
  quickbooksRefundReceiptDepositAccountRef: string | null;
}
