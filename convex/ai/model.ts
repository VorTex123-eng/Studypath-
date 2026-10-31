import { ConvexError } from "convex/values";

/**
 * Shared server-side AI model layer (F1).
 *
 * Everything here used to live inline in convex/quiz.ts. It is the part of
 * "call the LLM safely" that has nothing to do with quizzes: the Gemini
 * transport (timeout, HTTP/parse failure mapping), the bounded retry policy,
 * the model fallback, and the model/API-key configuration. Quiz generation
 * still owns its own prompt, response schema and output validation - those
 * are feature-specific. Later features (targeted practice, tutor, study
 * guides) plug into this same boundary instead of growing their own pipeline.
 *
 * PROVIDER DECISION (recorded in A1, not implemented): quiz generation stays
 * on Gemini. The AI tutor (phase B) may use a different provider or model if
 * testing shows better tutoring quality. `runWithFallback` is already
 * provider-agnostic - it only sees an `attempt` callback - so a second
 * provider is added as another call function (like `callGeminiJson`) plus its
 * own config, chosen per feature. Nothing here should hard-wire Gemini into a
 * caller other than quiz generation. No second provider or credential exists yet.
 *
 * Moved verbatim, not redesigned: same error codes, same client-safe
 * messages, same timeout, same retry/fallback decisions. Provider output
 * is still untrusted here - callers validate `parsed` before using it.
 */

// M11E: bounded retry. Two attempts total (one retry), never more - per the
// explicit "never create an infinite retry loop" rule. Only codes where a
// second try could plausibly succeed are retried; a missing API key never
// is, since nothing about retrying changes that.
export const MAX_ATTEMPTS = 2;
export const RETRY_BACKOFF_MS = 800;
export const RETRYABLE_CODES = new Set([
  "network_error", "timeout", "provider_error", "rate_limited",
  "bad_response", "empty_response", "malformed_json", "validation_failed",
]);

// Failures where the MODEL/endpoint itself is the problem (overloaded,
// unreachable, erroring), as opposed to the two content-quality codes
// left out here (malformed_json, validation_failed) where the model
// responded fine but got the output wrong - those are worth retrying
// against the SAME model with a correction note, not a reason to switch
// models. This distinction is what decides model-fallback vs. same-model
// retry in runWithFallback below.
export const PROVIDER_LEVEL_CODES = new Set([
  "network_error", "timeout", "provider_error", "rate_limited",
  "bad_response", "empty_response",
]);

// M11H — a hung provider request must not tie up the action
// indefinitely (Convex actions do have their own platform-level ceiling,
// but that's a blunt last resort, not a deliberate limit tuned for this
// call). AbortController lets us fail fast and cleanly, with a specific
// "timeout" code the retry logic already treats as worth one more try.
export const GEMINI_TIMEOUT_MS = 30000;

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ModelFailure = { ok: false; code: string; message: string };
export type ModelJsonResult = { ok: true; parsed: any } | ModelFailure;

/**
 * Provider credentials and model names. The API key is read from the
 * deployment's environment only - it never leaves the server. Model names
 * are configurable so a healthy model can be swapped in without a code change.
 * A missing key is reported by the CALLER (after its own cheaper checks and
 * the rate limit) so the order of failures stays exactly as before.
 */
export function getGeminiConfig(): { apiKey: string | undefined; model: string; fallbackModel: string } {
  return {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
    // A real, observed Gemini failure mode: a specific model returning
    // HTTP 503 "experiencing high demand" at a sustained rate for days at
    // a time, unrelated to this deployment's key, billing, or quota.
    // Retrying the identical request against the identical struggling
    // model wastes the retry budget - falling back to a second model
    // gives it an actual chance to succeed instead.
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite",
  };
}

/**
 * One Gemini call that must return JSON. Never throws for provider problems:
 * every failure is mapped to a code + a client-safe message (full detail goes
 * to Convex's own function logs, never to the caller). On success `parsed` is
 * the model's JSON, still untrusted.
 */
export async function callGeminiJson(params: {
  apiKey: string;
  model: string;
  prompt: string;
  responseSchema: unknown;
  logTag: string;
}): Promise<ModelJsonResult> {
  const { apiKey, model, prompt, responseSchema, logTag } = params;

  let resp: Response;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema },
        }),
        signal: controller.signal,
      }
    );
  } catch (err) {
    const isTimeout = (err as any)?.name === "AbortError";
    if (isTimeout) {
      return { ok: false, code: "timeout", message: `The AI provider did not respond within ${GEMINI_TIMEOUT_MS / 1000} seconds. Please try again.` };
    }
    // Full detail goes to Convex's own function logs (dashboard-only,
    // never returned to a caller) - the client gets a safe generic
    // message. Same treatment below for the non-OK-status branch.
    console.error(`[${logTag}] fetch failed:`, (err as Error).message);
    return { ok: false, code: "network_error", message: "Could not reach the AI provider. Please try again." };
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    console.error(`[${logTag}] Gemini HTTP ${resp.status}:`, bodyText.slice(0, 2000));
    return {
      ok: false,
      code: resp.status === 429 ? "rate_limited" : "provider_error",
      message: resp.status === 429
        ? "The AI provider is receiving too many requests right now. Please try again shortly."
        : "The AI provider had a problem generating this quiz. Please try again.",
    };
  }

  let raw: any;
  try {
    raw = await resp.json();
  } catch {
    return { ok: false, code: "bad_response", message: "Gemini's response was not valid JSON." };
  }

  const text: string | undefined = raw?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const finishReason = raw?.candidates?.[0]?.finishReason;
    return {
      ok: false,
      code: "empty_response",
      message: finishReason ? `Gemini did not return content (finishReason: ${finishReason}).` : "Gemini did not return any content.",
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: "malformed_json", message: "Gemini's output was not valid JSON. Never falling back to guessing at unstructured text." };
  }

  return { ok: true, parsed };
}

/**
 * The bounded retry + model-fallback loop. `attempt` performs one full
 * generation (call + the caller's own validation) against the given model,
 * with an optional correction note for the prompt, and reports success or a
 * coded failure. Returns the successful value, or throws the same
 * ConvexError (code + message with attempt/model suffix) the quiz action
 * always threw.
 */
export async function runWithFallback<T>(opts: {
  logTag: string;
  model: string;
  fallbackModel: string;
  attempt: (model: string, retryNote: string) => Promise<{ ok: true; value: T } | ModelFailure>;
  validationRetryNote: (failureMessage: string) => string;
}): Promise<T> {
  const { logTag, model, fallbackModel, attempt, validationRetryNote } = opts;

  let currentModel = model;
  let lastFailure: { code: string; message: string } | null = null;
  let retryNote = "";
  const modelsUsed: string[] = [];

  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    modelsUsed.push(currentModel);
    const result = await attempt(currentModel, retryNote);

    if (result.ok) return result.value;

    lastFailure = { code: result.code, message: result.message };

    const isLastAttempt = n === MAX_ATTEMPTS;
    const canRetry = RETRYABLE_CODES.has(result.code);
    if (isLastAttempt || !canRetry) break;

    if (PROVIDER_LEVEL_CODES.has(result.code) && fallbackModel && currentModel !== fallbackModel) {
      // The model itself is the problem (overloaded, erroring,
      // unreachable) - switch models for the retry rather than giving
      // it a second shot at the exact same request. No backoff pause
      // here: that pause exists to let an overloaded model recover,
      // which is irrelevant once we're not calling that model anymore.
      console.error(`[${logTag}] ${currentModel} failed with ${result.code}, falling back to ${fallbackModel}.`);
      currentModel = fallbackModel;
      retryNote = "";
      continue;
    }

    // Give the model a concrete, specific reason to fix on retry rather
    // than just trying again blind.
    retryNote = result.code === "validation_failed" ? validationRetryNote(result.message) : "";

    // A brief pause before retrying a transient provider issue gives a
    // "temporarily overloaded" condition a real chance to clear, rather
    // than immediately re-hitting the same busy endpoint.
    if (result.code === "rate_limited" || result.code === "provider_error") {
      await sleep(RETRY_BACKOFF_MS);
    }
  }

  const uniqueModelsUsed = Array.from(new Set(modelsUsed));
  // Stabilization: internal model names must not reach the client.
  // They stay in the server logs (dashboard-only) for debugging.
  if (uniqueModelsUsed.length > 1) {
    console.error(`[${logTag}] generation failed across models: ${uniqueModelsUsed.join(", ")}`);
  }
  throw new ConvexError({
    code: lastFailure!.code,
    message: lastFailure!.message + (
      MAX_ATTEMPTS > 1 ? ` (failed after ${MAX_ATTEMPTS} attempts)` : ""
    ),
  });
}
