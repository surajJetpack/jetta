/**
 * Top resolved-ticket patterns, inlined into the system prompt as few-shot
 * examples. Maintained manually and refreshed monthly. Behavioral rules are
 * now learned automatically via the /evals loop (lib/evals.ts — LEARNED
 * GUIDELINES block); this file remains for worked resolution examples only.
 *
 * Format per example:
 *   ## Resolution example: <product> — <short title>
 *   Symptom: ...
 *   Cause: ...
 *   Resolution: ...
 *
 * The seed set below is a placeholder; replace with the real top-50 at go-live
 * (Day 3, step 7).
 */
export const RESOLUTION_EXAMPLES = `
## Resolution example: GetSign — mapping not saving
Symptom: User reports column mappings reset after closing the editor.
Cause: Mapping save requires explicit confirmation via the Save button,
       not auto-saved on close.
Resolution: Instruct user to click Save before closing. Confirmed in v2.3+.

## Resolution example: GetSign — signature request not delivered
Symptom: Recipient never receives the signature request email.
Cause: Recipient address typo, or the email landed in spam/quarantine.
Resolution: Have the user verify the recipient address on the request, then
       resend. Ask the recipient to check spam and allowlist no-reply@getsign.io.

## Resolution example: Jetpack Apps — widget not loading on the board
Symptom: App view shows a blank/spinning state on a monday.com board.
Cause: Stale session token after a monday.com workspace permission change.
Resolution: Have the user reinstall the app from the marketplace or re-grant
       permissions; a hard refresh clears the cached token.

## Resolution example: Billing — unexpected charge after trial
Symptom: User sees a charge they did not expect at the end of a trial.
Cause: Trial converts to a paid plan automatically at trial end.
Resolution: Confirm the plan and charge date from FastSpring, explain the
       auto-conversion, and process a refund or cancellation only per policy.
`.trim();
