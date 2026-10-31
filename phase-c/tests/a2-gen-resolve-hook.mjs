/* Resolve hook for the A2 generation harness.
 * Redirects Convex-runtime imports so convex/quiz.ts (and the modules it
 * pulls in) can be loaded in plain Node:
 *   ./_generated/server -> pass-through registration stubs
 *   ./_generated/api    -> string-id internal references
 *   convex/values       -> ConvexError + permissive v
 *   ./ai/model          -> real runWithFallback/getGeminiConfig + stubbed transport
 * Everything else falls back to the existing extensionless .ts mapping.
 * Zero dependencies. */
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

// Portable: derived from this hook's own location, so the suite runs from
// any checkout (Linux, macOS, Windows) — no machine-specific paths.
const HERE = path.dirname(fileURLToPath(import.meta.url)); // phase-c/tests
const STUBS = path.join(HERE, 'stubs');
const SERVER_STUB = pathToFileURL(path.join(STUBS, 'a2-server-stub.mjs')).href;
const API_STUB = pathToFileURL(path.join(STUBS, 'a2-api-stub.mjs')).href;
const VALUES_STUB = pathToFileURL(path.join(STUBS, 'a2-values-stub.mjs')).href;
const MODEL_STUB = pathToFileURL(path.join(STUBS, 'a2-model-stub.mjs')).href;
const CONVEX_DIR_URL = pathToFileURL(path.join(HERE, '..', '..', 'convex') + path.sep).href;

function looksLikeConvexTree(parentURL) {
  return !!parentURL && parentURL.startsWith(CONVEX_DIR_URL);
}

export async function resolve(specifier, context, nextResolve) {
  const parentURL = context.parentURL || '';
  if (looksLikeConvexTree(parentURL)) {
    if (specifier === './_generated/server' || specifier === '../_generated/server') return { url: SERVER_STUB, shortCircuit: true };
    if (specifier === './_generated/api' || specifier === '../_generated/api') return { url: API_STUB, shortCircuit: true };
    if (specifier === 'convex/values') return { url: VALUES_STUB, shortCircuit: true };
    // B1: tutor.ts uses the same stubbed model boundary as quiz.ts (real
    // runWithFallback/getGeminiConfig, stubbed callGeminiJson transport).
    if (specifier === './ai/model' && (parentURL.includes('/convex/quiz.ts') || parentURL.includes('/convex/tutor.ts'))) {
      return { url: MODEL_STUB, shortCircuit: true };
    }
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
    const looksBare = isRelative && !/\.[a-zA-Z0-9]+$/.test(specifier);
    if (looksBare) {
      return await nextResolve(specifier + '.ts', context);
    }
    throw err;
  }
}
