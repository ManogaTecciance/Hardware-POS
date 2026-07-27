import * as ExcelJS from 'exceljs';

/** Build an .xlsx buffer from a header row + data rows (import-test sheets). */
export async function buildSheet(
  headers: string[],
  rows: Array<Array<string | number>>,
  sheetName = 'Sheet1',
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(headers);
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const VENDOR_HEADERS = [
  'Name', 'Company', 'Email', 'Phone', 'Mobile', 'Fax', 'Website', 'Street',
  'City', 'Province/Region/State', 'Postal code', 'Country', 'Opening Balance',
  'Date', 'Tax Id Number',
];

export const CUSTOMER_HEADERS = [
  'Name', 'Company', 'Customer Type', 'Email', 'Phone', 'Mobile', 'Fax',
  'Website', 'Street', 'City', 'State', 'ZIP', 'Country', 'Opening Balance',
  'Date', 'Resale Number',
];

export const PRODUCT_HEADERS = [
  'Product/service name', 'Category', 'Item type', 'SKU', 'Sales description',
  'Sales price/rate', 'Income account', 'Purchase description', 'Purchase cost',
  'Expense account', 'Quantity on hand', 'Quantity as of date', 'Reorder point',
  'Inventory asset account',
];
