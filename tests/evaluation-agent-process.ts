import { createApplicationRuntime } from "../agent/runtime.js";
import { createAgentServer } from "../agent/http-server.js";
import { HttpClinicalEhr, ClinicalEhrError, type ClinicalEhr } from "../agent/clinical-ehr.js";

// Isolated test executable: environment is supplied explicitly by the test, never loaded from .env.
const base = process.env.EHR_BASE_URL!;
const actual = new HttpClinicalEhr({ baseUrl: base, apiKey: process.env.EHR_API_KEY!, timeoutMs: 1000, maxRetries: 0 });
const ehr: ClinicalEhr = {
  medications: id => actual.medications(id), time: () => actual.time(), labs: (id, type) => actual.labs(id, type),
  pharmacy: id => actual.pharmacy(id), submitRefill: async (id, medId) => {
    const receipt = await actual.submitRefill(id, medId);
    if (process.env.SYNTHETIC_LOSE_RECEIPT === "true") throw new ClinicalEhrError("timeout", { uncertain: true });
    return receipt;
  },
};
const runtime = createApplicationRuntime(process.env, { interpret: async () => { throw new Error("No live model permitted in restart test"); } }, { ehr });
const server = createAgentServer(runtime.engine);
server.listen(runtime.config.agentPort, "127.0.0.1");
server.on("error", () => { process.exitCode = 1; });
