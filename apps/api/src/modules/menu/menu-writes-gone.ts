import { GoneException } from '@nestjs/common';

/**
 * D60 — MenuItem (and its Menu/MenuSection parents) are FROZEN.
 *
 * Reads stay: historical orders, KOT reprints and the support-only legacy
 * browser resolve against the retained rows. Writes are gone: the Product
 * wizard (Inventory → Products) has been the single authoring surface since
 * D45, and the convergence backfill has migrated every placement into
 * `CatalogueEntry`. Returning 410 (not 403) is deliberate — the resource
 * category is permanently gone, not forbidden to this caller.
 *
 * Typed `void` rather than `never` so the call can sit as the first line of
 * each legacy write handler without turning the retained body into
 * statically-unreachable code — the bodies stay as documentation of what the
 * endpoints did, and disappear with the deferred drop.
 */
export function assertMenuWritesAllowed(): void {
  throw new GoneException({
    code: 'MENU_WRITES_GONE',
    message:
      'Menu authoring has moved to Products (D60). This legacy endpoint is read-only; ' +
      'create and edit sellable items in Inventory → Products.',
  });
}
