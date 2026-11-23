import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationClientError, sendPatientMessage } from "./api.js";
import { patientMessageSchema, type ChatMessage, type ConversationState, type InterfaceNotice, type ResponseDetails, type SendMessage } from "./types.js";

export interface ConversationOptions { readonly send?: SendMessage; readonly createId?: () => string }

/** Create an ephemeral display entry without storing patient content outside React memory. */
function entry(speaker: ChatMessage["speaker"], text: string, response?: ResponseDetails): ChatMessage {
  return { id: crypto.randomUUID(), speaker, text, createdAt: new Date().toISOString(), response };
}

/** Own browser conversation context while leaving authentication and action authority to the agent. */
export function useConversation(options: ConversationOptions = {}) {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const [conversationId, setConversationId] = useState(createId);
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [state, setState] = useState<ConversationState>("not_started");
  const [pending, setPending] = useState(false);
  const [lastResponse, setLastResponse] = useState<ResponseDetails | null>(null);
  const [notice, setNotice] = useState<InterfaceNotice>({ text: "Synthetic data only • Local development", warning: false });
  const currentId = useRef(conversationId); const generation = useRef(0);
  const active = useRef<symbol | null>(null); const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const dependencies = useRef(options); dependencies.current = options;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; controller.current?.abort(); };
  }, []);

  /** Serialize sends synchronously and ignore any response from an obsolete component generation. */
  const send = useCallback(async (text: string): Promise<boolean> => {
    const parsed = patientMessageSchema.safeParse({ from: "patient", text });
    if (active.current || !parsed.success) return false;
    const token = Symbol("patient-turn"); active.current = token;
    const expectedGeneration = generation.current; const id = currentId.current;
    // An old routing context cannot apply a late reply to a new screen or conversation.
    const current = () => mounted.current && generation.current === expectedGeneration && currentId.current === id;
    const abort = new AbortController(); controller.current = abort;
    setPending(true); setMessages(previous => [...previous, entry("patient", parsed.data.text)]);
    setNotice({ text: "Sending one request. Please wait before continuing.", warning: false });
    try {
      const result = await (dependencies.current.send ?? sendPatientMessage)(id, parsed.data.text, abort.signal);
      if (!current()) return false;
      setMessages(previous => [...previous, ...result.reply.messages.map((message, index) => entry("agent", message.text,
        index === result.reply.messages.length - 1 ? result.details : undefined))]);
      setState(result.reply.state); setLastResponse(result.details);
      setNotice({ text: result.reply.state === "complete" ? "The agent returned complete. Read its response for the actual outcome."
        : result.reply.state === "escalated" ? "The agent returned escalated. A clinician contact is not assumed."
          : "Agent response received. Continue with your next patient message.", warning: false });
      return true;
    } catch (error) {
      if (!current()) return false;
      const known = error instanceof ConversationClientError;
      const text = known ? error.message : "A reliable response was not received. An action may already have been processed. Verify the outcome before repeating confirmation. No automatic retry was made.";
      const details = known ? error.details : null;
      setMessages(previous => [...previous, entry("notice", text, details ?? undefined)]);
      setLastResponse(details); setNotice({ text, warning: true });
      return false;
    } finally {
      if (active.current === token) { active.current = null; controller.current = null; if (current()) setPending(false); }
    }
  }, []);

  /** Clear only visible history and diagnostics, preserving the backend conversation and state. */
  const clearDisplay = useCallback((): boolean => {
    if (active.current) return false;
    generation.current++; setMessages([]); setLastResponse(null);
    setNotice({ text: "Local display cleared. Conversation ID, backend session and prior actions are unchanged.", warning: false });
    return true;
  }, []);

  /** Start a fresh routing context without resetting or undoing any backend operation. */
  const newConversation = useCallback((): boolean => {
    if (active.current) return false;
    const id = (dependencies.current.createId ?? (() => crypto.randomUUID()))();
    generation.current++; currentId.current = id; setConversationId(id);
    setMessages([]); setState("not_started"); setLastResponse(null);
    setNotice({ text: "New conversation ID created. Backend records and earlier actions have not been reset.", warning: false });
    return true;
  }, []);

  return { conversationId, messages, state, pending, lastResponse, notice, send, clearDisplay, newConversation };
}
