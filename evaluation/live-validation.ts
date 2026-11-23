import type { LiveInterpretationMetric, LiveRequestMetric } from "./live-observer.js";

/** Provider evidence is independent from a conversation that subsequently recovers without the model. */
export function assessLiveProvider(
  requests: readonly LiveRequestMetric[], interpretations: readonly LiveInterpretationMetric[],
) {
  const responses = requests.filter(request => request.outcome === "response" && request.status !== undefined
    && request.status >= 200 && request.status < 300);
  const interpretationFailures = interpretations.filter(metric => metric.structuredOutputValid !== true || metric.errorCode !== undefined).length;
  const matchingModelResponses = responses.filter(request => request.modelMatchesExpected === true).length;
  const mismatchedModelResponses = responses.filter(request => request.modelMatchesExpected === false).length;
  const missingModelMetadataResponses = responses.filter(request => request.modelMatchesExpected === undefined).length;
  const successfulProviderResponses = responses.length;
  const passed = requests.length > 0 && successfulProviderResponses === requests.length
    && interpretations.length > 0 && interpretationFailures === 0
    && matchingModelResponses === successfulProviderResponses;
  return { interpretationFailures, matchingModelResponses, mismatchedModelResponses,
    missingModelMetadataResponses, successfulProviderResponses, passed };
}
