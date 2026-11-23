import React from "react";
import { useServiceStatus } from "../useServiceStatus.js";

interface SidebarProps { readonly conversationId: string; readonly pending: boolean; readonly onNew: () => void; readonly onClear: () => void }

/** Show local health independently from patient authentication or model availability. */
function ServiceStatus({ ok }: { readonly ok: boolean | undefined }) {
  return <span className="service-status" data-status={ok === true ? "online" : ok === false ? "offline" : "checking"}>
    {ok === true ? "Connected" : ok === false ? "Unavailable" : "Unknown"}
  </span>;
}

/** Present routing controls without exposing credentials or resetting backend actions. */
export function Sidebar({ conversationId, pending, onNew, onClear }: SidebarProps) {
  const health = useServiceStatus();
  return <aside className="sidebar" aria-label="Local testing workspace">
    <div className="brand" aria-label="Artera conversation lab"><span className="brand-mark" aria-hidden="true">＋</span>
      <span>artera<span className="brand-caption">PRESCRIPTION REFILL ASSESSMENT</span></span></div>
    <div className="workspace-label"><span className="tiny-dot" /> LOCAL WORKSPACE</div>
    <div className="sidebar-heading">A conversation,<br />connected to your agent.</div>
    <p className="sidebar-description">Test the real patient workflow against your running application and mock services.</p>
    <section className="service-card" aria-labelledby="services-heading">
      <div className="section-heading"><h2 id="services-heading">Live services</h2>
        <button className="icon-button" type="button" onClick={() => void health.refresh()} disabled={health.pending} aria-label="Refresh service status">↻</button></div>
      <div className="service-row"><span>Patient agent</span><ServiceStatus ok={health.services?.agent.ok} /></div>
      <div className="service-row"><span>Mock EHR + pharmacy</span><ServiceStatus ok={health.services?.mock.ok} /></div>
      <p className="service-note" role="status">{health.note}</p>
    </section>
    <section className="session-section" aria-labelledby="session-heading">
      <h2 id="session-heading">This conversation</h2><div className="session-id-label">CONVERSATION ID</div>
      <code id="conversation-id" className="conversation-id">{conversationId}</code>
      <button id="new-conversation" className="secondary-button" type="button" disabled={pending} onClick={onNew}>＋ New conversation</button>
      <button id="clear-display" className="secondary-button clear-button" type="button" disabled={pending} onClick={onClear}>Clear local display</button>
      <p className="small-note">Clear preserves this ID and session. New creates a fresh ID. Neither resets the mock, cancels a request, nor undoes an action.</p>
    </section>
    <div className="sidebar-footer"><span className="privacy-icon" aria-hidden="true">◇</span><p>Synthetic data only<br /><span>Local development</span></p></div>
  </aside>;
}
