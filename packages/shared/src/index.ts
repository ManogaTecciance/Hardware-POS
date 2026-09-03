/**
 * @hardware-pos/shared
 *
 * Central export point for types, enums, and constants shared between the
 * Next.js web front-end (apps/web) and the NestJS API (apps/api).
 *
 * Keep this package free of runtime dependencies — types and pure constants
 * only — so it can be imported safely from both the browser and the server.
 */

export * from './constants.js';
export * from './money.js';
export * from './returns.js';
export * from './sale-line-label.js';
export * from './tax-breakdown.js';
export * from './promotions/index.js';
export * from './quotations.js';
export * from './types/index.js';
export * from './domains/index.js';
