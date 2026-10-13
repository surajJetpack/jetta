/**
 * Make customer-facing text read like a person typed it.
 *
 * Em dashes are the giveaway: people writing support replies type commas,
 * full stops and hyphens, and a reply studded with "—" reads as machine-written
 * however good the content is. The prompt asks the model not to use them, but
 * the prompt is itself full of them, so this is the guarantee: every path that
 * puts Jetta's words in front of a customer (Freshdesk reply, the draft an
 * agent copies, chat messages) runs through here.
 *
 * Works on plain text, markdown and HTML alike: dashes never appear inside
 * tags or URLs, and the HTML entities are folded in first.
 */
export function humanizeText(text: string): string {
  if (!/[—–]|&mdash;|&ndash;|&#821[12];/.test(text)) return text;
  return (
    text
      .replace(/&mdash;|&#8212;/g, "—")
      .replace(/&ndash;|&#8211;/g, "–")
      // A dash used as a bullet at the start of a line becomes a hyphen bullet.
      .replace(/^([ \t]*)[—–][ \t]+/gm, "$1- ")
      // A dash right before closing punctuation or the end of a line was an
      // aside that trailed off: drop it.
      .replace(/[ \t]*[—–][ \t]*(?=[.,;:!?)]|$)/gm, "")
      // Em dash, or a spaced en dash used as one, joining two parts: a comma.
      .replace(/[ \t]*—[ \t]*|[ \t]+–[ \t]+/g, ", ")
      // What's left is an unspaced en dash, a range like "2–5": a hyphen.
      .replace(/–/g, "-")
      // Tidy what the comma swap can leave behind.
      .replace(/,\s*,/g, ",")
      .replace(/,(\s*)([.;:!?])/g, "$2")
      .replace(/^([ \t]*), /gm, "$1")
  );
}
