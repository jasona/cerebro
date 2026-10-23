"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isDomainError, withdrawPublication } from "@cerebro/domain";
import { briefingPaths } from "@/lib/paths";
import { getBriefingRequestContext } from "@/lib/context";
import { field } from "@/lib/errors";

/** Withdraw the current publication (irreversible; the snapshot is kept). Requires `withdraw`. */
export async function withdrawAction(fd: FormData): Promise<void> {
  const company = field(fd, "company");
  const briefing = field(fd, "briefing");
  let target: string;
  try {
    if (field(fd, "confirm") !== "withdraw") {
      target = briefingPaths.history(company, briefing, { error: "confirm" });
    } else {
      const rc = await getBriefingRequestContext(company, briefing);
      await withdrawPublication(rc.db, rc.ctx, { briefingId: field(fd, "briefingId"), publicationId: field(fd, "publicationId") });
      revalidatePath(briefingPaths.reader(company, briefing));
      target = briefingPaths.history(company, briefing, { withdrawn: "1" });
    }
  } catch (err) {
    if (!isDomainError(err)) throw err;
    target = briefingPaths.history(company, briefing, { error: err.code });
  }
  redirect(target);
}
