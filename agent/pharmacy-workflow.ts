import { RefillActions } from "./actions.js";
import { ClinicalEhrError } from "./clinical-ehr.js";
import { clinicalReply, type ClinicalProgress } from "./clinical-workflow.js";
import { transition, type ConversationState } from "./conversation-state.js";
import { directoryListSchema, type DirectoryPharmacy, type PharmacyService } from "./pharmacy-client.js";
import { parsePharmacyCommand, selectPharmacy } from "./pharmacy-selection.js";
import { PatientClinicalReader } from "./patient-clinical.js";
import { assertSavedPharmacyPrompt, assertSessionPatient, sessionSelectionVersion, type SessionContext } from "./sessions.js";

type SelectedState = Extract<ConversationState, { phase: "awaiting_pharmacy_confirmation" }>;
interface ChangeRecord { scope: string; kind: "pending" | "updated" | "unknown" | "rejected" }

/** Limit visible directory choices so the complete patient reply fits its schema. */
function displayedCandidates(records: DirectoryPharmacy[]): DirectoryPharmacy[] {
  const visible: DirectoryPharmacy[] = [];
  let length = 0;
  for (const record of records.slice(0, 10)) {
    const label = `${visible.length + 1}. ${record.name}, ${record.address}; `;
    // Reserve headroom for the question and clarification prefixes under replySchema's 4000 chars.
    if (length + label.length > 3000) break;
    visible.push(record);
    length += label.length;
  }
  return visible;
}

/** Describe the saved pharmacy question and the exact action its confirmation permits. */
export function pharmacyReply(state: SelectedState): string {
  const prompt = state.pharmacyContext;
  if (!prompt) return "Pharmacy information is required before submission. Please retry. No refill has been submitted.";
  switch (prompt.stage) {
    case "confirm_current":
      return `Your current pharmacy is ${prompt.pharmacy.name} (reference ${prompt.pharmacy.pharmacyId}). Reply "Yes, keep my pharmacy" to submit your refill request for ${state.medicationName} to this pharmacy, or ask for a different pharmacy. No refill has been submitted.`;
    case "confirm_change":
      return `Change your pharmacy to ${prompt.pharmacy.name}, ${prompt.pharmacy.address}? Reply yes to change the pharmacy, or no to choose another. This confirmation does not submit the refill for ${state.medicationName}.`;
    case "search": {
      const choices = prompt.candidates.map((pharmacy, index) => `${index + 1}. ${pharmacy.name}, ${pharmacy.address}`).join("; ");
      return choices ? `Available pharmacies: ${choices}. Which one would you like? No pharmacy has been changed and no refill has been submitted.`
        : "Which pharmacy name or location would you like to search for? You can also ask to show available pharmacies. No refill has been submitted.";
    }
    default: { const exhaustive: never = prompt; return exhaustive; }
  }
}

/** Serialized conversational effects; only RefillActions can execute a refill POST. */
export class PharmacyWorkflow {
  readonly #changes = new Map<string, ChangeRecord>();
  /** Inject authorized reads, pharmacy integration and the sole guarded refill kernel. */
  constructor(readonly reader: PatientClinicalReader, readonly directory: PharmacyService, readonly actions: RefillActions) {}

  /** Restore retained refill outcomes before accepting another authenticated action. */
  async recover(state: ConversationState, context: SessionContext | undefined): Promise<ClinicalProgress | undefined> {
    const result = await this.actions.recoverRecorded(state, context);
    return result ? { state: result.state, message: "An earlier refill request has a recorded outcome. " + clinicalReply(result.state), cache: true } : undefined;
  }

  /** Retrieve the actual current pharmacy and save the corresponding consent question. */
  async prepare(state: ConversationState, context: SessionContext | undefined): Promise<ClinicalProgress> {
    if (state.phase !== "awaiting_pharmacy_confirmation") return { state, message: clinicalReply(state), cache: true };
    const recovered = await this.recover(state, context);
    if (recovered) return recovered;
    try {
      const current = await this.reader.pharmacy(state, context);
      assertSessionPatient(context, state);
      const next = transition(state, { type: "pharmacy_prompt", context: current
        ? { stage: "confirm_current", pharmacy: current } : { stage: "search", candidates: [] } });
      return this.#progress(next);
    } catch { return this.#unavailable(state); }
  }

  /** Interpret a pharmacy turn within the saved question and enforce deterministic consent guards. */
  async handle(state: SelectedState, text: string, context: SessionContext | undefined): Promise<ClinicalProgress> {
    assertSessionPatient(context, state);
    const recovered = await this.recover(state, context);
    if (recovered) return recovered;
    const command = parsePharmacyCommand(text);
    // Missing/failed presentation cannot turn a free-floating yes into permission.
    if (!state.pharmacyContext) return this.prepare(state, context);
    try {
      if (command.kind === "change") return await this.#search(state, command.query, context);
      if (command.kind === "other" && /\b(?:change\b[\s\S]*\bpharmacy|(?:different|another|new)\s+(?:pharmacy|location))\b/i.test(text)) {
        return await this.#search(state, "", context);
      }
      if (command.kind === "deny") {
        const next = transition(state, { type: "pharmacy_prompt", context: { stage: "search", candidates: [] } });
        return this.#progress(next);
      }
      const prompt = state.pharmacyContext;
      if (command.kind === "affirm") {
        assertSavedPharmacyPrompt(context, state);
        if (prompt.stage !== "confirm_current" && /\b(?:keep|use) my (?:current )?pharmacy\b/i.test(text)) {
          // Keeping the current destination contradicts a pending change; present it afresh.
          return this.prepare(state, context);
        }
        if (prompt.stage === "confirm_change") return await this.#change(state, prompt.pharmacy, context!);
        if (prompt.stage === "confirm_current") {
          await this.actions.confirmCurrentPharmacy(state, context, prompt.pharmacy.pharmacyId);
          // The kernel also recovers a retained receipt after a failed session commit.
          const result = await this.actions.submit(state, context);
          if (result.outcome.kind !== "blocked" || result.state.phase === "clinical_escalated") {
            const label = result.outcome.kind === "submitted" ? `For ${state.medicationName} at ${prompt.pharmacy.name}: ` : "";
            return { state: result.state, message: label + clinicalReply(result.state), cache: true };
          }
          if (result.outcome.reason === "invalid_context") {
            const next = transition(state, { type: "request_updated", request: state.request });
            return { state: next, message: "The prescription selection could not be revalidated. Please restate the medication name and strength. No refill has been submitted.", cache: false };
          }
          return this.prepare(state, context);
        }
        return this.#progress(state, "Please choose a specific pharmacy before confirming. ");
      }
      if (prompt.stage === "search") {
        const selected = selectPharmacy(prompt.candidates, text);
        if (selected.kind === "selected") {
          return this.#progress(transition(state, { type: "pharmacy_prompt", context: { stage: "confirm_change", pharmacy: selected.pharmacy } }));
        }
        if (selected.kind === "ambiguous") return this.#progress(state, "That matches more than one location. Please choose its number or exact address. ");
        // Explicitly entered names/locations are literal directory queries, never trusted IDs.
        if (!/\?/.test(text) && text.trim().length <= 200 && !/^(?:yes|ok|okay|pharmacy|pharmacies|use\s+\d+|\d+)[.!]?$/i.test(text.trim())) {
          return await this.#search(state, text.trim(), context);
        }
      }
      if (command.kind === "other" && !/\?/.test(text) && /^(?:please\s+)?use\s+/i.test(text)) {
        const preference = /\b(?:on|at|in)\s+(.+?)[.!]?$/i.exec(text)?.[1]
          ?? text.replace(/^(?:please\s+)?use\s+/i, "").replace(/[.!]+$/, "");
        return await this.#search(state, preference.trim(), context);
      }
      return this.#progress(state, "Please answer the pending question, request a pharmacy change, or cancel. ");
    } catch { return this.#unavailable(state); }
  }

  /** Retrieve validated directory choices and save an unambiguous confirmation or selection question. */
  async #search(state: SelectedState, query: string, context: SessionContext | undefined): Promise<ClinicalProgress> {
    // A change request invalidates the old confirmation even when directory access fails.
    const searching = transition(state, { type: "pharmacy_prompt", context: { stage: "search", candidates: [] } });
    if (searching.phase !== "awaiting_pharmacy_confirmation") throw new Error("Invalid pharmacy transition");
    try {
      assertSessionPatient(context, state);
      const parsed = directoryListSchema.safeParse(await this.directory.search(query));
      if (!parsed.success) throw new ClinicalEhrError("invalid_response");
      assertSessionPatient(context, state);
      // Keep displayed choices bounded and stable so an ordinal cannot select an unseen result.
      const candidates = displayedCandidates(parsed.data);
      const next = transition(state, { type: "pharmacy_prompt", context: candidates.length === 1
        ? { stage: "confirm_change", pharmacy: candidates[0] } : { stage: "search", candidates } });
      return this.#progress(next, candidates.length === 0 ? "No pharmacies matched that search. "
        : parsed.data.length > candidates.length ? `Showing the first ${candidates.length} matches; refine your search if needed. ` : "");
    } catch { return this.#unavailable(searching); }
  }

  /** Revalidate saved consent and directory evidence before one guarded pharmacy update. */
  async #change(state: SelectedState, destination: DirectoryPharmacy, context: SessionContext): Promise<ClinicalProgress> {
    assertSavedPharmacyPrompt(context, state);
    const patientId = assertSessionPatient(context, state);
    const revision = sessionSelectionVersion(context, state);
    const scope = JSON.stringify([patientId, state.medId, state.medicationName, state.request.medicationQuery, revision, destination]);
    const previous = this.#changes.get(context.conversationId);
    if (previous && (previous.kind === "pending" || previous.kind === "unknown")) return this.#stop(state, "pharmacy_unknown");
    if (previous?.kind === "rejected") return this.#stop(state, "pharmacy_rejected");
    if (previous?.kind === "updated" && previous.scope === scope) return this.#verifyChange(state, destination, context, previous);
    // Revalidate the destination against authoritative directory data immediately before PUT.
    const records = directoryListSchema.safeParse(await this.directory.search(""));
    if (!records.success) throw new ClinicalEhrError("invalid_response");
    const found = records.data.find(item => item.pharmacyId === destination.pharmacyId);
    if (!found || found.name !== destination.name || found.address !== destination.address) {
      return this.#progress(transition(state, { type: "pharmacy_prompt", context: { stage: "search", candidates: [] } }), "The directory entry changed. Please search and confirm again. ");
    }
    assertSavedPharmacyPrompt(context, state);
    assertSessionPatient(context, state);
    // Do not replace a pending record after an await or retry a potentially accepted mutation.
    if (this.#changes.get(context.conversationId) !== previous) return this.#stop(state, "pharmacy_unknown");
    const record: ChangeRecord = { scope, kind: "pending" };
    this.#changes.set(context.conversationId, record);
    try { await this.directory.update(patientId, destination.pharmacyId); }
    catch (error) {
      if (error instanceof ClinicalEhrError && !error.uncertain) {
        record.kind = "rejected";
        return this.#stop(state, "pharmacy_rejected");
      }
      // Even a timed-out PUT may have succeeded. A safe GET can reconcile the value.
    }
    return this.#verifyChange(state, destination, context, record);
  }

  /** Read back the authoritative destination and require fresh refill confirmation after a change. */
  async #verifyChange(state: SelectedState, destination: DirectoryPharmacy, context: SessionContext, record: ChangeRecord): Promise<ClinicalProgress> {
    try {
      const pharmacy = await this.reader.pharmacy(state, context);
      assertSessionPatient(context, state);
      if (!pharmacy || pharmacy.pharmacyId !== destination.pharmacyId || pharmacy.name !== destination.name) throw new Error("Unverified destination");
      record.kind = "updated";
      const next = transition(state, { type: "pharmacy_prompt", context: { stage: "confirm_current", pharmacy } });
      return this.#progress(next, "Your pharmacy destination has been verified. ");
    } catch {
      record.kind = "unknown";
      return this.#stop(state, "pharmacy_unknown");
    }
  }

  /** Build a cached workflow response from trusted pharmacy or clinical state. */
  #progress(state: ConversationState, prefix = ""): ClinicalProgress {
    return { state, message: prefix + (state.phase === "awaiting_pharmacy_confirmation" ? pharmacyReply(state) : clinicalReply(state)), cache: true };
  }
  /** Enter a terminal clinical stop for rejected or uncertain pharmacy mutations. */
  #stop(state: SelectedState, reason: "pharmacy_unknown" | "pharmacy_rejected"): ClinicalProgress {
    return this.#progress(transition(state, { type: "clinical_stop", reason, policyReasons: [] }));
  }
  /** Return a recoverable service-failure reply without claiming a new submission. */
  #unavailable(state: SelectedState): ClinicalProgress {
    return { state, message: "Pharmacy or prescription information is temporarily unavailable. Please retry. No new submission has been confirmed.", cache: false };
  }
}
