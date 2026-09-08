/**
 * Enumerate every HTTP route the API actually registers.
 *
 * **Test-only.** Nothing in the running application imports this.
 *
 * ## Why metadata and not a source grep
 *
 * The route-module matrix (Slice 7.6) is only worth having if it is provably
 * complete, and completeness is exactly the property a source grep cannot
 * establish. A regex over `@Get\\(` misses a route registered through a base class,
 * silently skips a controller whose file was renamed, and cannot see the
 * `@RequireModule` metadata that decides whether the route is gated at all.
 *
 * Reading Nest's own `PATH_METADATA` / `METHOD_METADATA` off the controller classes
 * asks the framework what it will serve. A controller left out of the list below is
 * the one remaining hole, and `route-module-matrix.spec.ts` closes it by comparing
 * this inventory against every `*.controller.ts` file on disk.
 */

import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { ModuleKey } from '@hardware-pos/database';

import { REQUIRE_MODULE_KEY } from '../decorators/require-module.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { BRANCH_SCOPE_METADATA, BranchScopeKind } from '../decorators/branch-scope.decorator';

/** Nest's own metadata keys. Imported by value so a version bump cannot silently drift. */
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

/** Nest's RequestMethod enum ordinals, in declaration order. */
const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'ALL',
  'OPTIONS',
  'HEAD',
  'SEARCH',
] as const;

export interface RouteInfo {
  /** Controller class name, e.g. `ProductsController`. */
  controller: string;
  /** Handler method name, e.g. `findAll`. */
  handler: string;
  method: string;
  /** Full path below the global `/v1` prefix, e.g. `/products/:id`. */
  path: string;
  /** The `@RequireModule(...)` key on the handler or its class, if any. */
  requiredModule: ModuleKey | null;
  /** Is the route `@Public()` (no authentication)? */
  isPublic: boolean;
  /** Permissions required by `@RequirePermissions(...)`, if any. */
  permissions: string[];
  /**
   * Branch-scope classification (Phase 1.5.6). `null` when the handler and its
   * controller both declare no scope — the guard treats a null scope as
   * `TENANT_SCOPED` (no-op). Classified routes state their intent explicitly so
   * the matrix test can verify that every branch-scoped route really does need
   * an active branch, and vice versa.
   */
  branchScope: BranchScopeKind | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ControllerClass = new (...args: any[]) => object;

/**
 * Every route on the given controllers.
 *
 * **Throws when handed no controllers, or when a controller exposes no routes.**
 * Both are the silent-vacuity failure the D30 standard names: a matrix test that
 * iterates an empty inventory passes having checked nothing, and looks identical
 * to one that checked everything.
 */
export function collectRoutes(controllers: ControllerClass[]): RouteInfo[] {
  if (controllers.length === 0) {
    throw new Error('collectRoutes was given no controllers — the caller inspects nothing');
  }

  const routes: RouteInfo[] = [];

  for (const controller of controllers) {
    const basePath = normalise(
      (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '',
    );
    const proto = controller.prototype as Record<string, unknown>;
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (name) => name !== 'constructor' && typeof proto[name] === 'function',
    );

    let found = 0;
    for (const handler of handlers) {
      const fn = proto[handler] as object;
      const methodOrdinal = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
      if (methodOrdinal === undefined) continue;

      found += 1;
      const subPath = normalise(
        (Reflect.getMetadata(PATH_METADATA, fn) as string | undefined) ?? '',
      );
      routes.push({
        controller: controller.name,
        handler,
        method: HTTP_METHODS[methodOrdinal] ?? `UNKNOWN(${methodOrdinal})`,
        path: joinPath(basePath, subPath),
        requiredModule:
          ((Reflect.getMetadata(REQUIRE_MODULE_KEY, fn) ??
            Reflect.getMetadata(REQUIRE_MODULE_KEY, controller)) as ModuleKey | undefined) ?? null,
        isPublic: Boolean(
          Reflect.getMetadata(IS_PUBLIC_KEY, fn) ?? Reflect.getMetadata(IS_PUBLIC_KEY, controller),
        ),
        permissions:
          ((Reflect.getMetadata(PERMISSIONS_KEY, fn) ??
            Reflect.getMetadata(PERMISSIONS_KEY, controller)) as string[] | undefined) ?? [],
        branchScope:
          ((Reflect.getMetadata(BRANCH_SCOPE_METADATA, fn) ??
            Reflect.getMetadata(BRANCH_SCOPE_METADATA, controller)) as BranchScopeKind | undefined) ??
          null,
      });
    }

    if (found === 0) {
      throw new Error(
        `${controller.name} registered no routes — either it is not a controller, or the ` +
          'metadata keys this inventory reads have changed. Either way it is inspecting nothing.',
      );
    }
  }

  return routes.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

/**
 * Every `*.controller.ts` file under `root`, by base name.
 *
 * Compared against the hand-maintained controller list so a new controller cannot
 * be added without also being classified. Throws on an empty walk.
 */
export function discoverControllerFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.controller.ts') && !entry.endsWith('.spec.ts')) {
        found.push(entry.replace(/\.controller\.ts$/, ''));
      }
    }
  };
  walk(root);

  if (found.length === 0) {
    throw new Error(`discoverControllerFiles found nothing under ${root} — the path is wrong`);
  }
  return found.sort();
}

function normalise(path: string): string {
  const trimmed = path.trim().replace(/^\/+|\/+$/g, '');
  return trimmed;
}

function joinPath(base: string, sub: string): string {
  const parts = [base, sub].filter((p) => p.length > 0);
  return `/${parts.join('/')}`;
}
