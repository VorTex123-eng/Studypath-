/* Studypath email sending via Brevo (2026-10-28).
 *
 * Replaces the Resend setup. Brevo is used with a single verified
 * sender for now (Eghosa's Gmail), because Studypath has no domain yet:
 * Brevo's single-sender verification lets a verified Gmail address send
 * to anyone, without a custom domain. When a Studypath domain exists,
 * point BREVO_FROM_EMAIL at an address on that domain and re-verify it
 * in Brevo; no code change is needed beyond the env value.
 *
 * Env (set in the Convex dashboard, never in code or chat):
 * - BREVO_API_KEY: Brevo API key (header "api-key").
 * - BREVO_FROM_EMAIL: the exact verified sender address in Brevo.
 *   This must match the sender verified in Brevo, or Brevo rejects
 *   the send with a "sender email is invalid" style error.
 * - BREVO_FROM_NAME (optional): display name, defaults to "Studypath".
 *
 * Brevo API: POST https://api.brevo.com/v3/smtp/email
 * Success is HTTP 201 (resp.ok covers it). All other email code in
 * the app (code lifecycle, token lifecycle, rate limits, gating) is
 * untouched; only the transport changed.
 */
export async function sendStudypathEmail(
  to: string,
  subject: string,
  html: string
): Promise<boolean> {
  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.BREVO_FROM_EMAIL;
  if (!apiKey) {
    console.error("[email] BREVO_API_KEY is not set.");
    return false;
  }
  if (!fromEmail) {
    console.error(
      "[email] BREVO_FROM_EMAIL is not set. Set it in Convex env to the " +
        "exact sender address verified in Brevo."
    );
    return false;
  }
  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: {
        name: process.env.BREVO_FROM_NAME || "Studypath",
        email: fromEmail,
      },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.text()).slice(0, 300);
    } catch (e) {
      /* ignore */
    }
    console.error(`[email] Brevo send failed: HTTP ${resp.status} ${detail}`);
    return false;
  }
  return true;
}
