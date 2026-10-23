import Link from "next/link";
import { buttonClasses } from "@cerebro/ui";

/**
 * 404. Unauthorized reads also land here (domain `not_found`), so the copy
 * never confirms that the resource exists.
 */
export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-start px-4 py-20 sm:px-6">
      <p className="text-xs font-medium tracking-[0.14em] text-muted uppercase">Not found</p>
      <h1 className="mt-3 font-serif text-headline text-ink">We couldn&apos;t find that page</h1>
      <p className="mt-3 text-muted">
        It may have moved, been withdrawn, or you may not have access to it. If someone shared it with you, ask them to
        check that you have been given access.
      </p>
      <Link href="/" className={buttonClasses({ variant: "secondary", className: "mt-6" })}>
        Go to your workspace
      </Link>
    </div>
  );
}
