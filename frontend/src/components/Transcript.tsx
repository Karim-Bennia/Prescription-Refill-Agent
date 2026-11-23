import React, { useLayoutEffect, useRef } from "react";
import type { ChatMessage, ConversationState } from "../types.js";

/** Render only actual submitted patient text, returned replies, or explicitly labeled UI notices. */
function Message({ message }: { readonly message: ChatMessage }) {
  return <article className={`message ${message.speaker}`}>
    <div className="message-heading"><span>{message.speaker === "patient" ? "You · patient" : message.speaker === "agent" ? "Agent" : "Interface notice"}</span>
      <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
    <div className="bubble">{message.text}</div>
    {message.response && <details className="response-details"><summary><span className="http-label">HTTP {message.response.httpStatus ?? "unavailable"}</span>View actual response</summary>
      <pre>{typeof message.response.body === "string" ? message.response.body : JSON.stringify(message.response.body, null, 2)}</pre></details>}
  </article>;
}

/** Keep the current viewport readable while announcing new actual conversation content. */
export function Transcript({ messages, pending, state }: { readonly messages: readonly ChatMessage[]; readonly pending: boolean; readonly state: ConversationState }) {
  const viewport = useRef<HTMLElement | null>(null); const nearBottom = useRef(true);
  useLayoutEffect(() => {
    const current = viewport.current;
    if (current && (nearBottom.current || messages.at(-1)?.speaker === "patient")) current.scrollTop = current.scrollHeight;
  }, [messages, pending]);
  return <section id="transcript-scroll" className="transcript-scroll" ref={viewport} aria-label="Conversation transcript" onScroll={() => {
    const current = viewport.current;
    if (current) nearBottom.current = current.scrollHeight - current.scrollTop - current.clientHeight < 100;
  }}>
    {messages.length === 0 && <div className="empty-state"><div className="welcome-symbol" aria-hidden="true">↔</div>
      <div className="eyebrow">{state === "not_started" ? "READY WHEN YOU ARE" : "LOCAL DISPLAY"}</div>
      <h2>{state === "not_started" ? "Start with a patient message." : "The local display is empty."}</h2>
      <p>{state === "not_started" ? "Ask your agent for help with a prescription refill, then follow its questions using synthetic patient details."
        : "Your current conversation ID and backend session are preserved. Read the state above before continuing."}</p>
      <div className="empty-note">Only messages you send and actual replies appear here.<br />No patient message is sent automatically.</div></div>}
    <div id="messages" className="messages" role="log" aria-live="polite" aria-relevant="additions">{messages.map(message => <Message key={message.id} message={message} />)}</div>
    {pending && <div className="pending-indicator" role="status"><span className="pending-dots" aria-hidden="true"><i /><i /><i /></span> Waiting for the agent…</div>}
  </section>;
}
