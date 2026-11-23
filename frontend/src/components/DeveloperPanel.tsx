import React from "react";
import type { ResponseDetails } from "../types.js";

/** Display observed transport facts and returned JSON without inferring transaction success. */
export function DeveloperPanel({ response }: { readonly response: ResponseDetails | null }) {
  return <details className="developer-panel">
    <summary>Request details {response && <span>HTTP {response.httpStatus ?? "unavailable"} · {Math.round(response.durationMs)} ms</span>}</summary>
    {response ? <><dl><div><dt>HTTP status</dt><dd>{response.httpStatus ?? "No response"}</dd></div>
      <div><dt>Request duration</dt><dd>{Math.round(response.durationMs)} ms</dd></div></dl>
      <pre>{typeof response.body === "string" ? response.body : JSON.stringify(response.body, null, 2)}</pre></>
      : <p>No response details in the local display.</p>}
  </details>;
}
