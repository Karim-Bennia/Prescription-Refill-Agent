import React, { useLayoutEffect, useRef, type FormEvent } from "react";
import type { InterfaceNotice } from "../types.js";

interface ComposerProps {
  readonly draft: string; readonly pending: boolean; readonly notice: InterfaceNotice;
  readonly onChange: (text: string) => void; readonly onSend: (event: FormEvent<HTMLFormElement>) => void;
}

/** Collect bounded patient text without interpreting or authorizing its content. */
export function Composer({ draft, pending, notice, onChange, onSend }: ComposerProps) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    if (input.current) { input.current.style.height = "auto"; input.current.style.height = `${Math.min(180, Math.max(48, input.current.scrollHeight))}px`; }
  }, [draft]);
  return <div className="composer-area">
    <div className="interface-status" role="status" aria-live="polite" data-tone={notice.warning ? "warning" : "neutral"}>{notice.text}</div>
    <form id="message-form" className="composer" onSubmit={onSend}>
      <label className="sr-only" htmlFor="patient-message">Patient message</label>
      <textarea id="patient-message" ref={input} name="message" rows={2} maxLength={4000} value={draft} onChange={event => onChange(event.target.value)}
        placeholder="Type a patient message…" aria-describedby="composer-help" aria-busy={pending} autoComplete="off" spellCheck={false} required
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault(); if (!pending && draft.trim()) event.currentTarget.form?.requestSubmit();
        } }} />
      <div className="composer-actions"><span className="character-count">{draft.length.toLocaleString()} / 4,000</span>
        <button id="send-message" className="send-button" type="submit" disabled={pending || !draft.trim() || draft.length > 4000}>Send <span aria-hidden="true">↗</span></button></div>
    </form>
    <div className="composer-footer"><span id="composer-help"><kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for a new line</span><span>Actual HTTP and JSON details below</span></div>
  </div>;
}
