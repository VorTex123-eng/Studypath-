/* Test stub for convex/ai/model, used ONLY by the A2 generation harness.
 * runWithFallback and getGeminiConfig are the REAL implementations
 * (re-exported from the actual module via absolute file URL, so the retry
 * policy, timeout constants and env-key lookup under test are genuine).
 * callGeminiJson is a mutable stub: each test installs the provider
 * behavior it wants (valid / malformed / timeout / provider error …).
 * Zero dependencies beyond the real model module. */
export {
  runWithFallback,
  getGeminiConfig,
} from '../../../convex/ai/model.ts';

let impl = null;
const calls = [];

/** Install the fake provider for the next test. fn receives the same params the real transport gets. */
export function __setTransport(fn) {
  impl = fn;
  calls.length = 0;
}
/** Every transport invocation so far (params only). */
export function __transportCalls() {
  return calls;
}

export async function callGeminiJson(params) {
  calls.push({ model: params.model, prompt: params.prompt, hasSchema: !!params.responseSchema });
  if (!impl) throw new Error('callGeminiJson stub has no implementation - call __setTransport first');
  return impl(params);
}
