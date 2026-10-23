import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReaderPage } from "@/components/briefing/reader/reader-page";
import { positiveInt, type BriefingPageParams } from "../../_lib/load";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Briefing" };

/** Pinned revision reader: always exactly revision `n`, never the latest under its identity. */
export default async function PinnedRevisionRoute({
  params,
  searchParams,
}: {
  params: Promise<BriefingPageParams & { n: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const n = positiveInt((await params).n);
  if (!n) notFound();
  return <ReaderPage params={params} searchParams={searchParams} revisionNumber={n} />;
}
