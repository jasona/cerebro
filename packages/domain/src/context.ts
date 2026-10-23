import { z } from "zod";

/** Server-resolved identity and tenant for one request, job or tool call. */
export const RequestContext = z.object({
  userId: z.string().uuid(),
  organizationId: z.string().uuid(),
  via: z.enum(["web", "mcp", "worker"]),
  connectionId: z.string().uuid().optional(),
  requestId: z.string().min(1),
});
export type RequestContext = z.infer<typeof RequestContext>;
