/**
 * Barcode symbology selection.
 *
 * Retail scanners treat a true GTIN differently from an arbitrary string, so a
 * code that *is* a valid UPC-A / EAN-13 is printed with its native symbology;
 * everything else falls back to Code 128, which encodes any printable ASCII.
 *
 * Check-digit handling matters: ZPL's ^BU and ^BE take the code WITHOUT its
 * final check digit and print the digit the printer computes. Passing the full
 * code straight through is the classic way to end up with an unscannable label,
 * so a valid check digit is verified and then stripped.
 */

export type Symbology = 'UPC_A' | 'EAN_13' | 'CODE_128' | 'QR';

/**
 * GTIN mod-10 check digit for a code supplied WITHOUT its check digit.
 * Weights alternate 3,1 from the rightmost digit — correct for UPC-A (11 in)
 * and EAN-13 (12 in) alike.
 */
export function gtinCheckDigit(digitsWithoutCheck: string): number {
  let sum = 0;
  const reversed = digitsWithoutCheck.split('').reverse();
  reversed.forEach((digit, index) => {
    sum += Number(digit) * (index % 2 === 0 ? 3 : 1);
  });
  return (10 - (sum % 10)) % 10;
}

function hasValidCheckDigit(code: string): boolean {
  const body = code.slice(0, -1);
  const check = Number(code.slice(-1));
  return gtinCheckDigit(body) === check;
}

export interface SymbologyChoice {
  symbology: Symbology;
  /** What to put in ^FD — GTINs are stripped of their check digit. */
  data: string;
}

export function chooseSymbology(rawCode: string, preferQr = false): SymbologyChoice {
  const code = rawCode.trim();

  if (preferQr) return { symbology: 'QR', data: code };

  const digitsOnly = /^\d+$/.test(code);
  if (digitsOnly && code.length === 12 && hasValidCheckDigit(code)) {
    return { symbology: 'UPC_A', data: code.slice(0, 11) };
  }
  if (digitsOnly && code.length === 13 && hasValidCheckDigit(code)) {
    return { symbology: 'EAN_13', data: code.slice(0, 12) };
  }
  return { symbology: 'CODE_128', data: code };
}
