/**
 * D113c (`6.1`) — a measured product must name its unit.
 *
 * ## Why this is a unit spec and not only an integration one
 *
 * The rule is a pure function of two values, and it has four cases that matter.
 * Exercising them through `ProductsService.update` would need a database, a
 * tenant and a stored product for each — four fixtures to prove one conditional.
 * The integration spec covers that the SERVICE calls it with the resulting
 * state; this covers the rule itself, exhaustively.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The rule is asserted in **both directions**. A test that only checked the
 * refusal would pass for an implementation that refused everything — including
 * every shirt in every tenant, which is exactly the failure mode a `NOT NULL`
 * column would have had. So the positive case, "a WHOLE product needs no unit",
 * carries as much weight here as the negative one.
 */

import { BadRequestException } from '@nestjs/common';
import { QuantityType } from '@hardware-pos/database';

import { assertMeasuredProductNamesItsUnit } from './products.service';

describe('D113c — a measured product must name its unit', () => {
  it('refuses a DECIMAL product with no unit', () => {
    expect(() => assertMeasuredProductNamesItsUnit(QuantityType.DECIMAL, null)).toThrow(
      BadRequestException,
    );
    expect(() => assertMeasuredProductNamesItsUnit(QuantityType.DECIMAL, undefined)).toThrow(
      BadRequestException,
    );
  });

  it('refuses a unit that is only whitespace', () => {
    // `''` and `'   '` are the two ways a form sends "the operator typed
    // nothing". Neither is a unit of measure.
    expect(() => assertMeasuredProductNamesItsUnit(QuantityType.DECIMAL, '')).toThrow(
      BadRequestException,
    );
    expect(() => assertMeasuredProductNamesItsUnit(QuantityType.DECIMAL, '   ')).toThrow(
      BadRequestException,
    );
  });

  it('accepts a DECIMAL product that names its unit', () => {
    expect(() => assertMeasuredProductNamesItsUnit(QuantityType.DECIMAL, 'kg')).not.toThrow();
    expect(() => assertMeasuredProductNamesItsUnit(QuantityType.DECIMAL, 'L')).not.toThrow();
  });

  it('POSITIVE CONTROL: a WHOLE product needs no unit', () => {
    // The assertion that stops this rule from being "every product needs a
    // unit". A NOT NULL column would have failed exactly here, for every shirt,
    // service line and restaurant menu item in every tenant — which is the
    // reason D113c put the rule in the service instead.
    expect(() => assertMeasuredProductNamesItsUnit(QuantityType.WHOLE, null)).not.toThrow();
    expect(() => assertMeasuredProductNamesItsUnit(QuantityType.WHOLE, undefined)).not.toThrow();
    expect(() => assertMeasuredProductNamesItsUnit(QuantityType.WHOLE, '')).not.toThrow();
  });

  it('leaves a WHOLE product alone even when it carries a unit', () => {
    // Not an error state: a product switched back from DECIMAL keeps whatever
    // unit it had, and refusing that would block the very correction D113b §2
    // exists to allow.
    expect(() => assertMeasuredProductNamesItsUnit(QuantityType.WHOLE, 'kg')).not.toThrow();
  });

  it('says something a shopkeeper can act on', () => {
    // `4.19` cost two hours on a promotion that behaved correctly and explained
    // nothing. The person reading this is adding rice, not debugging a DTO.
    try {
      assertMeasuredProductNamesItsUnit(QuantityType.DECIMAL, null);
      throw new Error('expected a refusal');
    } catch (error) {
      const message = (error as BadRequestException).message;
      expect(message).toContain('weight or measure');
      expect(message).toContain('kg');
      // NEGATIVE: not the field name. A message naming `unitOfMeasure` would be
      // written for the wrong reader.
      expect(message).not.toContain('unitOfMeasure');
    }
  });
});
