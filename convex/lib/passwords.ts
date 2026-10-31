/* Studypath strong passwords (Phase 1, 2026-10-27).
 *
 * Server-side authority for password strength. The signup form shows a
 * meter and may also check Have I Been Pwned by hash prefix, but neither
 * is enforcement: a request can always skip the frontend, so this module
 * is what signup and password reset actually enforce.
 *
 * Rules (2026-10-27 update, user requested strict big-company style):
 * - Minimum 12 characters, maximum 128.
 * - Must contain at least one capital letter, one lowercase letter,
 *   one number, and one special character. Missing any one blocks
 *   signup and password reset, server side.
 * - Rejected if it is a common password, equals the account email or
 *   name, or is one repeated character.
 * Breach-list checking (HIBP) stays frontend-only: signup is a mutation,
 * and mutations cannot fetch, so the server cannot query HIBP itself
 * without restructuring signup into an action. The common-password list
 * below covers the worst cases server-side.
 */

const COMMON_PASSWORDS = new Set([
  "password", "password123", "password1234", "password12345", "123456",
  "12345678", "123456789", "1234567890", "1234567", "12345", "123123",
  "111111", "000000", "qwerty", "qwerty123", "abc123", "letmein",
  "welcome", "welcome123", "admin", "admin123", "monkey", "dragon",
  "football", "baseball", "superman", "batman", "trustno1",
  "iloveyou", "princess", "sunshine", "master", "shadow", "michael",
  "jesus", "jesus123", "god123", "nigeria", "nigeria123", "lagos123",
  "studypath", "studypath123", "changeme", "secret", "passw0rd",
  "p@ssw0rd", "p@ssword", "1234qwer", "qwertyuiop", "asdfghjkl",
  "1qaz2wsx", "dragon123", "football123", "michael123",
]);

export function validatePassword(
  password: string,
  email?: string | null,
  name?: string | null
): string | null {
  if (typeof password !== "string" || password.length < 12) {
    return "Password must be at least 12 characters.";
  }
  if (password.length > 128) {
    return "Password is too long.";
  }
  const missing: string[] = [];
  if (!/[A-Z]/.test(password)) missing.push("a capital letter");
  if (!/[a-z]/.test(password)) missing.push("a lowercase letter");
  if (!/[0-9]/.test(password)) missing.push("a number");
  if (!/[^A-Za-z0-9]/.test(password)) missing.push("a special character");
  if (missing.length > 0) {
    return "Password must contain " + missing.join(", ") + ".";
  }
  const lowered = password.toLowerCase().trim();
  if (/^(password|qwerty|letmein|welcome|admin|123456|abc123|football|monkey|dragon)\d*$/.test(lowered)) {
    return "That password is too common. Choose a longer, less predictable one.";
  }
  if (COMMON_PASSWORDS.has(lowered)) {
    return "That password is too common. Choose a longer, less predictable one.";
  }
  if (/^(.)\1+$/.test(password)) {
    return "That password is too predictable. Choose a longer, less predictable one.";
  }
  if (email) {
    const local = email.trim().toLowerCase().split("@")[0];
    if (local && local.length >= 4 && lowered === local) {
      return "Your password cannot be the same as your email address.";
    }
  }
  if (name) {
    const compact = name.trim().toLowerCase().replace(/\s+/g, "");
    if (compact && compact.length >= 4 && lowered === compact) {
      return "Your password cannot be the same as your name.";
    }
  }
  return null;
}
