import { z } from "zod";

export const conversationStateSchema = z.enum(["in_progress", "complete", "escalated"]);
export const patientMessageSchema = z.strictObject({ from: z.literal("patient"), text: z.string().trim().min(1).max(4000) });
export const conversationReplySchema = z.strictObject({
  messages: z.array(z.strictObject({ from: z.literal("agent"), text: z.string().trim().min(1).max(4000) })).min(1).max(10),
  state: conversationStateSchema,
});
const healthSchema = z.strictObject({ ok: z.boolean(), status: z.number().int().min(100).max(599).nullable().optional() });
export const serviceStatusSchema = z.strictObject({ agent: healthSchema, mock: healthSchema });
export type ConversationReply = z.infer<typeof conversationReplySchema>;
export type ConversationState = ConversationReply["state"] | "not_started";
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export interface ResponseDetails { readonly httpStatus: number | null; readonly durationMs: number; readonly body: unknown }
export interface AgentResponse { readonly reply: ConversationReply; readonly details: ResponseDetails }
export interface ChatMessage {
  readonly id: string; readonly speaker: "patient" | "agent" | "notice"; readonly text: string;
  readonly createdAt: string; readonly response?: ResponseDetails;
}
export interface InterfaceNotice { readonly text: string; readonly warning: boolean }
export type SendMessage = (conversationId: string, text: string, signal?: AbortSignal) => Promise<AgentResponse>;
