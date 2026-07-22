import { cn } from '@/lib/utils';
import { supplierInitials } from '@/lib/suppliers/format';

/** Supplier logo, falling back to initials on a branded well. */
export function SupplierAvatar({
  name,
  logoUrl,
  size = 'md',
  className,
}: {
  name: string;
  logoUrl?: string | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const dims =
    size === 'lg' ? 'h-14 w-14 text-lg' : size === 'sm' ? 'h-8 w-8 text-xs' : 'h-10 w-10 text-sm';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand-50 font-semibold text-brand-700',
        dims,
        className,
      )}
      aria-hidden
    >
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        supplierInitials(name)
      )}
    </span>
  );
}
