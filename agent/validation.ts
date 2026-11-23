import { z } from "zod";

export const conversationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

export const requestSchema = z.strictObject({
  from: z.literal("patient"),
  text: z.string().trim().min(1).max(4000),
});

export const replySchema = z.strictObject({
  messages: z.array(z.strictObject({
    from: z.literal("agent"),
    text: z.string().trim().min(1).max(4000),
  })).min(1).max(10),
  state: z.enum(["in_progress", "complete", "escalated"]),
});

export type AgentReply = z.infer<typeof replySchema>;

export class InputValidationError extends Error {
  /** Represent invalid conversation input without retaining the supplied values. */
  constructor() {
    super("Invalid conversation input.");
    this.name = "InputValidationError";
  }
}

/** Validate a conversation routing identifier without treating it as patient authentication. */
export function parseConversationId(value: unknown): string {
  const result = conversationIdSchema.safeParse(value);
  if (!result.success) throw new InputValidationError();
  return result.data;
}
