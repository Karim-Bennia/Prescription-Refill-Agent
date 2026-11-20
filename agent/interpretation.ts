import { interpretationSchema, type LanguageInterpreter, type Interpretation } from "./intent.js";
import { LlmProviderError } from "./errors.js";

const CLARIFICATIONS = {
  none: null,
  identity: "Please provide your first and last name, date of birth, and phone ending or ZIP code.",
  medication: "Which medication would you like to refill? Please include its name and strength.",
  pharmacy: "Which pharmacy and location would you like to use?",
  request: "How can I help with your prescription refill request?",
} as const;

// Small provider-independent consumer. Future orchestration must still validate identity,
// policy and consent. Model proposals cannot produce action or clinical outcome messages.
export async function interpretMessage(
  provider: LanguageInterpreter, text: string,
): Promise<{ interpretation: Interpretation; clarification: string | null }> {
  if (!text.trim() || text.length > 4000) throw new LlmProviderError("invalid_input");
  const proposal = interpretationSchema.safeParse(await provider.interpret(text));
  if (!proposal.success) throw new LlmProviderError("invalid_response");
  return { interpretation: proposal.data, clarification: CLARIFICATIONS[proposal.data.clarification] };
}
