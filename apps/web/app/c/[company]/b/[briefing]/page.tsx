import type { Metadata } from "next";
import { ReaderPage } from "@/components/briefing/reader/reader-page";
import type { BriefingPageParams } from "./_lib/load";

export const dynamic = "force-dynamic";
// The title is set generically: a page title must not disclose a briefing the viewer cannot read.
export const metadata: Metadata = { title: "Briefing" };

export default function BriefingReaderRoute({
  params,
  searchParams,
}: {
  params: Promise<BriefingPageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ReaderPage params={params} searchParams={searchParams} />;
}
