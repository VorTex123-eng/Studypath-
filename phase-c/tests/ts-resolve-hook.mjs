/* Resolve hook for tests: maps extensionless relative imports (the Convex
   convention, e.g. `from "./topics"`) to their `.ts` files so Node's
   type-stripping loader can find them. Zero dependencies. */
export async function resolve(specifier, context, nextResolve) {
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
