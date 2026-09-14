'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { ArrowLeft } from 'lucide-react';

import { ProductDetail } from '@/components/products/product-detail';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { useEffectiveProfile } from '@/lib/platform-profile';
import { resolveProductManagementPresentation } from '@/lib/products/product-presentation';
import {
  fetchCategoryTree,
  fetchProduct,
  syncProductToQuickBooks,
  type CategoryNode,
  type ManagedProduct,
} from '@/lib/products-api';
import { fetchBranches, type BranchSummary } from '@/lib/products/branches-api';
import { fetchBrands, type Brand } from '@/lib/products/brands-api';
import { fetchProductAttributeSchema, type AttributeField } from '@/lib/products/attributes-api';
import { PENDING, type Lookup } from '@/lib/products/catalogue-labels';
import {
  fetchVariants,
  fetchVariations,
  type ProductVariant,
  type ProductVariationDimension,
} from '@/lib/products/variants-api';

/**
 * Product Details route (D44).
 *
 * A thin client shell that fetches the product and mounts `<ProductDetail>` —
 * the tabbed client component that owns the presentation state (active tab,
 * dialogs, mutations). The auxiliary catalogues (variants, variations,
 * branches) load in a separate effect that does not gate the loading state:
 * the header must appear as soon as the product resolves, and per-tab data
 * lazy-loads inside `<ProductDetail>` anyway. This mirrors the pre-D44
 * detail page's single-await settle behaviour so the render tests do not
 * silently regress on tick ordering.
 *
 * The route stays a client component because everything below the auth line
 * (session token, permissions, in-page mutations) is client-only.
 */
export default function ProductDetailPage() {
  const { session, hasPermission } = useAuth();
  const canManage = hasPermission(Permission.PRODUCT_MANAGE);
  const canReceive = hasPermission(Permission.INVENTORY_RECEIVE);
  const canSyncQb = hasPermission(Permission.QUICKBOOKS_MANAGE);
  // D101 — the 86 switch has its own permission (the till holds it too).
  const canSetAvailability = hasPermission(Permission.PRODUCT_AVAILABILITY_SET);
  const { id } = useParams<{ id: string }>();
  const { inventoryMode, status: profileStatus } = useEffectiveProfile();

  const [product, setProduct] = React.useState<ManagedProduct | null>(null);
  const [variants, setVariants] = React.useState<ProductVariant[]>([]);
  /*
   * D167 — whether the variant list is KNOWN, not merely empty.
   *
   * `variants` starts `[]`, and the fetch below deliberately does not gate
   * the page's loading state. Without this flag the overview reads that
   * empty array as fact and announces "Single-variant product" for a
   * 25-variant product, alongside the parent's legacy price and stock — the
   * very fields D44 says are not read once `hasVariants` is true.
   *
   * It corrects itself a beat later, so it reads as a flicker on a fast
   * connection. On a slow one it lingers, and when the request FAILS it
   * never corrects at all: the catch below turns an error into `[]`, which
   * is indistinguishable from a genuine answer.
   */
  const [variantsState, setVariantsState] = React.useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [variations, setVariations] = React.useState<ProductVariationDimension[]>([]);
  /*
   * D169 — the same three states as `variantsState`, for the same reason.
   *
   * D167 left this fetch's failure flattened to `[]` and said so explicitly:
   * nothing rendered the dimensions, so an empty list changed nothing an
   * operator could see. The Variations card changes that, and the moment a
   * list is DISPLAYED, `[]` from a failure and `[]` from a product with no
   * dimensions stop being the same fact.
   */
  const [variationsState, setVariationsState] = React.useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  /*
   * D169 — the catalogues that turn the product's IDs into words.
   *
   * Each is fetched ONLY when the product actually carries the id it would
   * resolve, so a product with no brand issues no `/brands` request and an
   * uncategorised one issues no `/categories`. They resolve NAMES, never
   * facts: whether the product has a category is already known from the
   * payload, so nothing here can change what the page claims — only how
   * readable it is.
   */
  const [categories, setCategories] = React.useState<Lookup<CategoryNode>>(PENDING);
  const [brands, setBrands] = React.useState<Lookup<Brand>>(PENDING);
  const [attributeFields, setAttributeFields] = React.useState<AttributeField[]>([]);
  const [branches, setBranches] = React.useState<BranchSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [syncBusy, setSyncBusy] = React.useState(false);

  // Product fetch — single await, gates the page's loading state.
  React.useEffect(() => {
    if (!session || !id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchProduct(session, id)
      .then((p) => !cancelled && setProduct(p))
      .catch(
        (err: unknown) =>
          !cancelled && setError(err instanceof Error ? err.message : 'Could not load product'),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, id, reloadKey]);

  // Auxiliary fetches. These do NOT gate loading — the header can render
  // usefully from the product alone, and the inner tabs fetch their own data
  // lazily. Branches still fall back to an empty array (a slow branches
  // endpoint must not hide the page, and it changes nothing the page claims);
  // the variant and variation lists report their outcome instead, because
  // both are rendered and an empty one would otherwise read as an answer
  // (D167, D169).
  React.useEffect(() => {
    if (!session || !id) return;
    let cancelled = false;
    setVariantsState('loading');
    /*
     * D167 — branches and variations still fall back to empty on failure:
     * a slow branches endpoint must not hide the page, and neither changes
     * what the product IS. The variant list does, so its outcome is tracked
     * rather than flattened — `[]` from a failure and `[]` from a product
     * with no variants are different facts and must not render alike.
     */
    void Promise.all([
      fetchBranches(session).catch(() => [] as BranchSummary[]),
      fetchVariants(session, id).then(
        (rows) => ({ ok: true as const, rows }),
        () => ({ ok: false as const, rows: [] as ProductVariant[] }),
      ),
      fetchVariations(session, id).then(
        (r) => ({ ok: true as const, rows: r.dimensions }),
        () => ({ ok: false as const, rows: [] as ProductVariationDimension[] }),
      ),
    ]).then(([brs, vars, dims]) => {
      if (cancelled) return;
      setBranches(brs);
      setVariants(vars.rows);
      setVariantsState(vars.ok ? 'ready' : 'error');
      setVariations(dims.rows);
      setVariationsState(dims.ok ? 'ready' : 'error');
    });
    return () => {
      cancelled = true;
    };
  }, [session, id, reloadKey]);

  /*
   * D169 — catalogue lookups, keyed on what the product actually needs.
   *
   * Separate from the effect above because it cannot run until the product
   * has resolved: the ids it fetches names for arrive WITH the product. It
   * therefore re-runs when those ids change, not on every reload.
   */
  const productCategoryId = product?.categoryId ?? null;
  const productBrandId = product?.brandId ?? null;
  const hasAttributes = product != null && Object.keys(product.attributes ?? {}).length > 0;

  React.useEffect(() => {
    if (!session) return;
    let cancelled = false;

    if (productCategoryId) {
      setCategories(PENDING);
      void fetchCategoryTree(session).then(
        (rows) => !cancelled && setCategories({ state: 'ready', rows }),
        () => !cancelled && setCategories({ state: 'error', rows: [] }),
      );
    }

    if (productBrandId) {
      setBrands(PENDING);
      // `includeArchived` — a product may well carry a brand the tenant has
      // since archived, and refusing to name it would report a live fact as
      // a dangling reference.
      void fetchBrands(session, true).then(
        (rows) => !cancelled && setBrands({ state: 'ready', rows }),
        () => !cancelled && setBrands({ state: 'error', rows: [] }),
      );
    }

    if (hasAttributes) {
      /*
       * Labels only. A failure here is not tracked, and deliberately so:
       * the VALUES come from the product and are shown either way, and the
       * resolver falls back to a humanised key. Losing a tenant's wording is
       * a cosmetic loss; hiding what they recorded would not be.
       */
      void fetchProductAttributeSchema(session).then(
        (r) => !cancelled && setAttributeFields(r.fields),
        () => undefined,
      );
    }

    return () => {
      cancelled = true;
    };
  }, [session, productCategoryId, productBrandId, hasAttributes]);

  // The presentation resolver is the ONE authority for mode-driven UI decisions
  // — the header's Receive Stock button gate and any managed-mode labels in the
  // panels below both flow from it. Product components must not compare
  // `inventoryMode` directly (D31 structural rule).
  const presentation = resolveProductManagementPresentation({
    inventoryMode,
    syncStatus: product?.syncStatus,
    quickbooksItemId: product?.quickbooksItemId ?? null,
  });

  const handleSync = async () => {
    if (!session || !product) return;
    setSyncBusy(true);
    try {
      await syncProductToQuickBooks(session, product.id);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncBusy(false);
    }
  };

  if (!session) return null;

  if (loading || profileStatus === 'loading') {
    return <p className="py-16 text-center text-sm text-muted-foreground">Loading...</p>;
  }

  if (error || !product) {
    return (
      <div className="space-y-4">
        <Link
          href="/products"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Back to products
        </Link>
        <Card>
          <CardContent className="py-16 text-center text-sm text-danger">
            {error ?? 'Product not found'}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <ProductDetail
      session={session}
      product={product}
      variants={variants}
      variantsState={variantsState}
      variationsState={variationsState}
      categories={categories}
      brands={brands}
      attributeFields={attributeFields}
      variations={variations}
      branches={branches}
      presentation={presentation}
      hasReceivePermission={canReceive}
      hasManagePermission={canManage}
      canSyncQb={canSyncQb}
      syncBusy={syncBusy}
      onSync={() => void handleSync()}
      onReload={() => setReloadKey((k) => k + 1)}
      canSetAvailability={canSetAvailability}
    />
  );
}
