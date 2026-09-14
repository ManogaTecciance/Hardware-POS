import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { StoreCreditService } from './store-credit.service';

/**
 * D175 — the store-credit ledger.
 *
 * Deliberately NOT `@Global`. It was, briefly, and the integration suite
 * refused it in 378 tests:
 *
 *     Nest can't resolve dependencies of the ReturnsService (…, ?, …).
 *     Please make sure that the argument StoreCreditService at index [7]
 *     is available in the ReturnsModule module.
 *
 * `@Global` only takes effect once the module is imported SOMEWHERE in the
 * graph. `app.module.ts` did that for the running application, so the app
 * booted and the unit suite passed — while every integration spec, which builds
 * its own module graph from the feature modules it needs, had no idea the
 * module existed.
 *
 * The lesson is not about test wiring. A module that declares its own
 * dependencies works in any graph; one that relies on being registered
 * elsewhere works only in the graph that registers it, and the failure surfaces
 * far from the cause. `ReturnsModule` and `CustomersModule` import this now,
 * which is what they actually do.
 */
@Module({
  imports: [PrismaModule],
  providers: [StoreCreditService],
  exports: [StoreCreditService],
})
export class StoreCreditModule {}
