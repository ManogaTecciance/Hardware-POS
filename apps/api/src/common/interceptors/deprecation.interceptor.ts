import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';

/**
 * D62 — deprecation headers for aliased legacy routes (convergence plan
 * §9.1's deprecation policy).
 *
 * A deprecated route keeps working, says so in-band (`Deprecation`, `Sunset`,
 * and a `Link rel="successor-version"` naming where to go), and is removed no
 * earlier than two releases after the successor ships. Headers rather than a
 * body change, so no consumer's parsing breaks while it migrates.
 */
export function deprecatedRoute(successorPath: string, sunset: string) {
  @Injectable()
  class DeprecationInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
      const res = context.switchToHttp().getResponse<{
        setHeader: (name: string, value: string) => void;
      }>();
      res.setHeader('Deprecation', 'true');
      res.setHeader('Sunset', sunset);
      res.setHeader('Link', `<${successorPath}>; rel="successor-version"`);
      return next.handle();
    }
  }
  return DeprecationInterceptor;
}
