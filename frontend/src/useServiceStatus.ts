import { useCallback, useEffect, useRef, useState } from "react";
import { getServiceStatus } from "./api.js";
import type { ServiceStatus } from "./types.js";

/** Poll bounded local health checks without sending patient messages or model requests. */
export function useServiceStatus() {
  const [services, setServices] = useState<ServiceStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("Checking local service health…");
  const active = useRef<AbortController | null>(null); const mounted = useRef(true);
  /** Refresh the two local health probes, serializing overlapping refresh requests. */
  const refresh = useCallback(async () => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; setPending(true);
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const result = await getServiceStatus(controller.signal);
      if (mounted.current) {
        setServices(result); setNote(result.agent.ok && result.mock.ok
          ? "Both services passed health checks; provider and credential checks are separate."
          : "Start the unavailable service, then refresh its status.");
      }
    } catch {
      if (mounted.current) { setServices(null); setNote("Could not check services. Verify the frontend server is running."); }
    } finally { clearTimeout(timer); if (active.current === controller) active.current = null; if (mounted.current) setPending(false); }
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    const interval = setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
    return () => { mounted.current = false; clearInterval(interval); active.current?.abort(); };
  }, [refresh]);
  return { services, pending, note, refresh };
}
