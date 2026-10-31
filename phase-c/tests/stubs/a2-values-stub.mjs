/* Test stub for the "convex/values" npm package (not installed here).
 * ConvexError carries the payload on .data, exactly like the real one, so
 * targetedErrorFor's `err.code || err.data.code` lookup behaves the same.
 * `v` is a permissive builder: validators are only invoked at module load
 * to describe args, never executed by the harness. Zero dependencies. */
export class ConvexError extends Error {
  constructor(data) {
    super(typeof data === 'object' && data !== null ? JSON.stringify(data) : String(data));
    this.name = 'ConvexError';
    this.data = data;
  }
}

const validator = new Proxy(
  function () {},
  {
    get: () => validator,
    apply: () => ({}),
  }
);
export const v = new Proxy(
  {},
  {
    get: () => (...args) => ({}),
  }
);
export { validator };
