import { z } from "zod";

const observationSchema = z.strictObject({
  event: z.literal("http_request"), requestId: z.string().uuid(),
  status: z.number().int().min(100).max(599),
  category: z.enum(["health", "conversation", "invalid_request", "not_found", "method_not_allowed",
    "body_timeout", "request_too_large", "service_unavailable"]),
  durationMs: z.number().finite().min(0),
});
export type HttpObservation = z.infer<typeof observationSchema>;

/** Allowlisted metadata only: no paths, routing IDs, bodies, headers, prompts or error objects. */
export function createSafeHttpObserver(write: (line: string) => void | Promise<void> = line => console.error(line)) {
  return (observation: HttpObservation): void => {
    const safe = observationSchema.safeParse(observation);
    if (!safe.success) return;
    try { void Promise.resolve(write(JSON.stringify(safe.data))).catch(() => undefined); }
    catch { /* Diagnostic failure cannot change patient outcomes. */ }
  };
}
