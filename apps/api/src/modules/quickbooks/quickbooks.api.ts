/** Minimal client for the QuickBooks Online Accounting API. */

export interface QboItem {
  Id: string;
  Name: string;
  Sku?: string;
  Description?: string;
  PurchaseDesc?: string;
  UnitPrice?: number;
  PurchaseCost?: number;
  QtyOnHand?: number;
  /** The date QtyOnHand was established (YYYY-MM-DD). */
  InvStartDate?: string;
  Type?: string;
  Active?: boolean;
  SubItem?: boolean;
  ParentRef?: { value: string; name?: string };
  IncomeAccountRef?: { value: string; name?: string };
  ExpenseAccountRef?: { value: string; name?: string };
  AssetAccountRef?: { value: string; name?: string };
  /** Optimistic-concurrency token required by QBO for updates. */
  SyncToken?: string;
}

/** A QuickBooks account (only the fields item creation needs). */
export interface QboAccount {
  Id: string;
  Name: string;
  AccountType: string;
  AccountSubType?: string;
}

interface QueryResponse {
  QueryResponse?: { Item?: QboItem[] };
}

interface CompanyInfoQueryResponse {
  QueryResponse?: { CompanyInfo?: Array<{ CompanyName?: string }> };
}

interface PreferencesQueryResponse {
  QueryResponse?: {
    Preferences?: Array<{ CurrencyPrefs?: { HomeCurrency?: { value?: string } } }>;
  };
}

/** A reference to another QuickBooks entity (Item, Customer, …). */
export interface QboRef {
  value: string;
  name?: string;
}

/** A single sales line on a SalesReceipt / Invoice. */
export interface QboSalesLine {
  DetailType: 'SalesItemLineDetail';
  Amount: number;
  Description?: string;
  SalesItemLineDetail: {
    ItemRef?: QboRef;
    Qty?: number;
    UnitPrice?: number;
  };
}

/** Body shared by SalesReceipt and Invoice creation. */
export interface QboSalesDocumentInput {
  CustomerRef?: QboRef;
  DocNumber?: string;
  PrivateNote?: string;
  Line: QboSalesLine[];
  TxnTaxDetail?: { TotalTax: number };
}

/**
 * Body shared by RefundReceipt and CreditMemo creation. Same line/tax shape as a
 * sales document; a RefundReceipt additionally names the account the money is
 * paid back from (DepositToAccountRef) and the refund tender (PaymentMethodRef).
 */
export interface QboReturnDocumentInput {
  CustomerRef?: QboRef;
  DocNumber?: string;
  PrivateNote?: string;
  Line: QboSalesLine[];
  TxnTaxDetail?: { TotalTax: number };
  DepositToAccountRef?: QboRef;
  PaymentMethodRef?: QboRef;
}

/** Body for a QuickBooks Payment linked to an Invoice. */
export interface QboPaymentInput {
  CustomerRef: QboRef;
  TotalAmt: number;
  PrivateNote?: string;
  Line: Array<{
    Amount: number;
    LinkedTxn: Array<{ TxnId: string; TxnType: 'Invoice' }>;
  }>;
}

/** A created QuickBooks transaction (only the fields we consume). */
export interface QboDocument {
  Id: string;
  DocNumber?: string;
}

interface RequestParams {
  apiBase: string;
  realmId: string;
  accessToken: string;
}

/** Run a QBO SQL-ish query against the Accounting API and return the parsed JSON. */
async function runQuery<T>(params: RequestParams, query: string): Promise<T> {
  const url = `${params.apiBase}/v3/company/${params.realmId}/query?minorversion=65&query=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`QuickBooks query failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as T;
}

/**
 * Query all Items from a QuickBooks company. The caller filters by type; we pull
 * everything (up to 1000) so inventory and non-inventory items are both returned.
 */
export async function queryItems(params: RequestParams): Promise<QboItem[]> {
  const json = await runQuery<QueryResponse>(params, 'select * from Item maxresults 1000');
  return json.QueryResponse?.Item ?? [];
}

/** Fetch one Item by id (used to obtain the SyncToken before an update). */
export async function queryItemById(params: RequestParams, id: string): Promise<QboItem | null> {
  const json = await runQuery<QueryResponse>(
    params,
    `select * from Item where Id = '${id.replace(/'/g, '')}'`,
  );
  return json.QueryResponse?.Item?.[0] ?? null;
}

/** Postal address as QBO returns it. */
export interface QboAddress {
  Line1?: string;
  Line2?: string;
  City?: string;
  /** State / province code. */
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  Country?: string;
}

/** A QuickBooks Vendor (the fields supplier mapping + pull-create need). */
export interface QboVendor {
  Id: string;
  DisplayName: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  Mobile?: { FreeFormNumber?: string };
  Fax?: { FreeFormNumber?: string };
  WebAddr?: { URI?: string };
  BillAddr?: QboAddress;
  TaxIdentifier?: string;
  Balance?: number;
  Active?: boolean;
}

/** Search active vendors by display name (empty term returns the first page). */
export async function queryVendors(params: RequestParams, term: string): Promise<QboVendor[]> {
  const safe = term.replace(/'/g, "\\'");
  const where = safe ? ` where DisplayName like '%${safe}%'` : '';
  const json = await runQuery<{ QueryResponse?: { Vendor?: QboVendor[] } }>(
    params,
    `select Id, DisplayName, Balance, Active from Vendor${where} maxresults 50`,
  );
  return (json.QueryResponse?.Vendor ?? []).filter((v) => v.Active !== false);
}

/** List vendors with full detail for a reconciliation / pull-create pass. */
export async function queryAllVendors(params: RequestParams): Promise<QboVendor[]> {
  const json = await runQuery<{ QueryResponse?: { Vendor?: QboVendor[] } }>(
    params,
    'select * from Vendor maxresults 1000',
  );
  return json.QueryResponse?.Vendor ?? [];
}

/** A QuickBooks Customer (the fields party sync + pull-create need). */
export interface QboCustomer {
  Id: string;
  DisplayName: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  Mobile?: { FreeFormNumber?: string };
  Fax?: { FreeFormNumber?: string };
  WebAddr?: { URI?: string };
  BillAddr?: QboAddress;
  ResaleNum?: string;
  Active?: boolean;
}

/** List customers with full detail for a reconciliation / pull-create pass. */
export async function queryAllCustomers(params: RequestParams): Promise<QboCustomer[]> {
  const json = await runQuery<{ QueryResponse?: { Customer?: QboCustomer[] } }>(
    params,
    'select * from Customer maxresults 1000',
  );
  return json.QueryResponse?.Customer ?? [];
}

/** Fetch one Vendor by id. */
export async function queryVendorById(params: RequestParams, id: string): Promise<QboVendor | null> {
  const json = await runQuery<{ QueryResponse?: { Vendor?: QboVendor[] } }>(
    params,
    `select Id, DisplayName, Balance, Active from Vendor where Id = '${id.replace(/'/g, '')}'`,
  );
  return json.QueryResponse?.Vendor?.[0] ?? null;
}

/** List accounts (for resolving the Income / COGS / Inventory Asset refs). */
export async function queryAccounts(params: RequestParams): Promise<QboAccount[]> {
  const json = await runQuery<{ QueryResponse?: { Account?: QboAccount[] } }>(
    params,
    'select Id, Name, AccountType, AccountSubType from Account maxresults 1000',
  );
  return json.QueryResponse?.Account ?? [];
}

/** Create a QuickBooks Item (product/service). */
export async function createItem(
  params: RequestParams,
  body: Record<string, unknown>,
): Promise<QboItem> {
  const json = await postEntity<{ Item?: QboItem }>(params, 'item', body);
  if (!json.Item?.Id) {
    throw new Error('QuickBooks Item response did not include an Id');
  }
  return json.Item;
}

/**
 * Sparse-update a QuickBooks Item: only the provided fields change. Requires the
 * item's current SyncToken (QBO's optimistic-concurrency token).
 */
export async function updateItemSparse(
  params: RequestParams,
  body: Record<string, unknown> & { Id: string; SyncToken: string },
): Promise<QboItem> {
  const json = await postEntity<{ Item?: QboItem }>(params, 'item', { ...body, sparse: true });
  if (!json.Item?.Id) {
    throw new Error('QuickBooks Item response did not include an Id');
  }
  return json.Item;
}

/** Fetch the connected company's display name and home currency (best-effort fields). */
export async function queryCompanyInfo(
  params: RequestParams,
): Promise<{ companyName: string | null; currency: string | null }> {
  const [company, prefs] = await Promise.all([
    runQuery<CompanyInfoQueryResponse>(params, 'select * from CompanyInfo'),
    runQuery<PreferencesQueryResponse>(params, 'select * from Preferences'),
  ]);
  return {
    companyName: company.QueryResponse?.CompanyInfo?.[0]?.CompanyName ?? null,
    currency: prefs.QueryResponse?.Preferences?.[0]?.CurrencyPrefs?.HomeCurrency?.value ?? null,
  };
}

/** Create a QuickBooks Sales Receipt (used for fully-paid sales). */
export async function createSalesReceipt(
  params: RequestParams,
  body: QboSalesDocumentInput,
): Promise<QboDocument> {
  const json = await postEntity<{ SalesReceipt?: QboDocument }>(params, 'salesreceipt', body);
  return expectEntity(json.SalesReceipt, 'SalesReceipt');
}

/** Create a QuickBooks Invoice (used for credit / partially-paid sales). */
export async function createInvoice(
  params: RequestParams,
  body: QboSalesDocumentInput,
): Promise<QboDocument> {
  const json = await postEntity<{ Invoice?: QboDocument }>(params, 'invoice', body);
  return expectEntity(json.Invoice, 'Invoice');
}

/** Create a QuickBooks Payment linked to an Invoice (records the amount paid). */
export async function createPayment(
  params: RequestParams,
  body: QboPaymentInput,
): Promise<QboDocument> {
  const json = await postEntity<{ Payment?: QboDocument }>(params, 'payment', body);
  return expectEntity(json.Payment, 'Payment');
}

/** Create a QuickBooks Refund Receipt (money paid back for a fully-paid sale). */
export async function createRefundReceipt(
  params: RequestParams,
  body: QboReturnDocumentInput,
): Promise<QboDocument> {
  const json = await postEntity<{ RefundReceipt?: QboDocument }>(params, 'refundreceipt', body);
  return expectEntity(json.RefundReceipt, 'RefundReceipt');
}

/** Create a QuickBooks Credit Memo (credit for a returned invoice / credit sale). */
export async function createCreditMemo(
  params: RequestParams,
  body: QboReturnDocumentInput,
): Promise<QboDocument> {
  const json = await postEntity<{ CreditMemo?: QboDocument }>(params, 'creditmemo', body);
  return expectEntity(json.CreditMemo, 'CreditMemo');
}

/** POST a JSON entity to the Accounting API and return the parsed response. */
async function postEntity<T>(
  params: RequestParams,
  entity: 'salesreceipt' | 'invoice' | 'payment' | 'refundreceipt' | 'creditmemo' | 'item',
  body: unknown,
): Promise<T> {
  const url = `${params.apiBase}/v3/company/${params.realmId}/${entity}?minorversion=65`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`QuickBooks ${entity} create failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as T;
}

function expectEntity(doc: QboDocument | undefined, kind: string): QboDocument {
  if (!doc?.Id) {
    throw new Error(`QuickBooks ${kind} response did not include an Id`);
  }
  return doc;
}
