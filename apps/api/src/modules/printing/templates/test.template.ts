import { EscPosBuilder, type BuilderOptions } from '../escpos';

/**
 * D174 — the printer self-test page, as bytes.
 *
 * One template for both transports: the direct dispatcher and the on-site
 * agent print byte-identical pages, so "the test page came out" means the
 * same thing wherever the API happens to be running. The page names the
 * device and its configuration rather than saying "hello", because the
 * operator reading it is trying to work out which of three printers this is
 * and whether the column count matches the roll.
 */
export interface TestPageData {
  name: string;
  code: string;
  role: string;
  kind: string;
  address: string;
  columns: number;
  /** Which process sent the bytes — the API directly, or an on-site agent. */
  via: 'SERVER' | 'AGENT';
  printedAt: Date;
}

export function renderTestPage(data: TestPageData, options?: BuilderOptions): Buffer {
  const b = new EscPosBuilder(data.columns, options);
  b.init()
    .align('center')
    .bold(true)
    .doubleSize(true)
    .line('AXLO POS')
    .doubleSize(false)
    .line('Printer test page')
    .bold(false)
    .line()
    .align('left')
    .hr()
    .row('Printer', data.name)
    .row('Code', data.code)
    .row('Role', data.role)
    .row('Kind', data.kind)
    .row('Address', data.address)
    .row('Columns', String(data.columns))
    .row('Via', data.via === 'AGENT' ? 'on-site agent' : 'server')
    .row('Printed', data.printedAt.toISOString().slice(0, 19).replace('T', ' '))
    .hr()
    .line(
      data.via === 'AGENT'
        ? 'If you can read this, the print agent can reach this printer.'
        : 'If you can read this, the server can reach this printer.',
    )
    .cut();
  return b.build();
}
