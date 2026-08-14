'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

/**
 * The historical Restaurant Menu screen — now a pointer, for everyone.
 *
 * ## D66 — the menu admin is gone
 *
 * D45 moved authoring to the Product wizard; D60 froze every menu write at
 * the API (410); D66 deleted the legacy MenuBrowser and its `?view=legacy`
 * escape hatch with the rest of `components/restaurant/menu/**` — a browser
 * whose every editing control answers 410 is a broken UI, not a fallback.
 * Historical MenuItem rows remain readable through the retained API for
 * support tooling; the operator-facing surface is Products, where curation
 * now happens through collections (D62/D66).
 *
 * The route itself stays: bookmarks and typed URLs land on a visible
 * explanation instead of a 404 — same reasoning as the D45 card this page
 * always showed to restaurant tenants.
 */
export default function MenuPage() {
  const { session } = useAuth();

  if (!session) return null;

  return (
    <div className="space-y-6">
      <PageHeader title="Menu" description="This page has moved." />
      <Card>
        <CardContent className="space-y-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            Every sellable item — dishes, drinks and packaged goods — is managed from the
            Products screen, and the POS reads the same catalogue directly. Menus live on as
            collections of products, so there is nothing left to configure here.
          </p>
          <div className="flex justify-center">
            <Link href="/products" className={buttonVariants()}>
              Go to Products
              <ArrowRight className="ml-1 h-4 w-4" aria-hidden />
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
