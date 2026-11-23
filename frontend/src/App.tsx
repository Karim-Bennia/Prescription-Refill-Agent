import React, { useState, type FormEvent } from "react";
import { useConversation, type ConversationOptions } from "./useConversation.js";
import { Sidebar } from "./components/Sidebar.js";
import { Transcript } from "./components/Transcript.js";
import { Composer } from "./components/Composer.js";
import { DeveloperPanel } from "./components/DeveloperPanel.js";
import type { ConversationState } from "./types.js";

const LABELS: Readonly<Record<ConversationState, string>> = { not_started: "Not started", in_progress: "In progress", complete: "Complete", escalated: "Escalated" };

/** Compose a local React client; all identity, consent and clinical authority remains server-side. */
export default function App({ conversationOptions }: { readonly conversationOptions?: ConversationOptions }) {
  const conversation = useConversation(conversationOptions);
  const [draft, setDraft] = useState("");
  /** Submit exactly one patient turn and clear only the accepted draft. */
  function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (conversation.pending || !draft.trim() || draft.length > 4000) return;
    const text = draft; setDraft(""); void conversation.send(text);
  }
  /** Replace the conversation ID only when no request is pending. */
  function handleNew() { if (conversation.newConversation()) setDraft(""); }
  /** Remove local transcript contents while preserving the active session. */
  function handleClear() { conversation.clearDisplay(); }

  return <div className="workspace"><Sidebar conversationId={conversation.conversationId} pending={conversation.pending} onNew={handleNew} onClear={handleClear} />
    <main className="conversation-panel"><header className="conversation-header"><div><div className="eyebrow">SYNTHETIC PATIENT TESTING</div><h1>Conversation lab</h1></div>
      <div id="conversation-state" className="state-badge" data-state={conversation.state} role="status">{LABELS[conversation.state]}</div></header>
      <div className="conversation-context"><span className="context-dot" aria-hidden="true" /><p>Actual agent replies. Real mock-service actions.<span> No simulated conversation.</span></p></div>
      <Transcript messages={conversation.messages} pending={conversation.pending} state={conversation.state} />
      <Composer draft={draft} onChange={setDraft} pending={conversation.pending} notice={conversation.notice} onSend={handleSend} />
      <DeveloperPanel response={conversation.lastResponse} />
    </main></div>;
}
