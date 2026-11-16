/**
 * Which posts on a monday item are Jetta's.
 *
 * Her monday token is a PERSON's, so on the board everything she writes
 * carries that person's name. Two shapes are hers: comments that open with
 * the "🤖 Jetta:" prefix, and the context block she files with an item
 * ("Product: … / Account: … / Freshdesk ticket: …", optionally under a
 * "Follow-up from the SAME Freshdesk ticket" line).
 *
 * One definition, here, with no imports — so the pages and pure modules that
 * need it (/activity, /dev-board) can use it without pulling in the monday
 * client. They each used to carry their own regex, and each missed one of the
 * two shapes: her chases and relays were counted as a person's work, and on
 * /dev-board as an engineering reply.
 */
export const JETTA_POST_PREFIX = "🤖 Jetta:";

/** One of her "🤖 Jetta:" comments. */
export function isJettaPost(text: string | null | undefined): boolean {
  return (text ?? "").trimStart().startsWith(JETTA_POST_PREFIX);
}

/** A context post createDevItem makes ("Product: …\nAccount: …"). Also hers. */
export function isJettaContextPost(text: string | null | undefined): boolean {
  return /^\s*(Follow-up from the SAME Freshdesk ticket[^\n]*\s*)?Product:/.test(text ?? "");
}

/** Anything she wrote on an item, either shape. */
export function isJettaAuthored(text: string | null | undefined): boolean {
  return isJettaPost(text) || isJettaContextPost(text);
}
