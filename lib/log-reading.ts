/**
 * Reading a customer's log failures against what they reported, for a dev item.
 *
 * A dev item used to carry every kind of failure the customer's account had
 * in the last 72 hours, as raw lines. Most had nothing to do with the report,
 * and the developer had to find the one that did (Swejal, 2026-11-17: "match
 * the logs with the issue description … then summarize the issue rather than
 * pushing actual logs"). So the failures are put next to the report, the ones
 * that fit it are kept, and what they say is written in two or three
 * sentences. The kept lines stay on the item, shortened and linked, so the
 * reading can be checked.
 *
 * Like the evidence itself, this goes on the item only: the ticket agent
 * never sees it, so nothing a log says can reach a customer.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "./llm";

export interface FailureRow {
  at: string;
  group: string;
  message: string;
  count: number;
}

export interface LogReading {
  /** 1-based positions of the rows that fit the report. May be empty. */
  related: number[];
  /** What those rows say, in plain words. */
  summary: string;
}

export type LogReader = (issue: string, rows: FailureRow[]) => Promise<LogReading>;

const Schema = z.object({
  related: z.array(z.number().int()).describe("Numbers of the failures that fit the report. Empty when none does."),
  summary: z.string().describe("Two or three plain sentences on what the related failures show. Empty when none is related."),
});

const SYSTEM = `You read server log failures for a developer who is about to look at a customer's bug report.

You get THE REPORT (what the customer says went wrong) and numbered FAILURES from that customer's account in the app's logs.

1. Pick the failures that fit the report: the same feature or action going wrong, on the board, item or time the report names when it names one. A failure from the same account about something else does not fit. Most accounts have unrelated failures; leaving them out is the point.
2. Write what the picked failures show, for the developer: which operation failed, the error in its own words (quote the key part), how many times and when. Two or three sentences.

Rules:
- Say only what the lines say. No cause, no fix, no guess beyond them.
- Keep ids (account, board, item) exactly as written.
- If nothing fits, return an empty list and an empty summary. That is a common, correct answer.`;

/** The model reader. Throws on a model failure; the caller falls back to the plain list. */
export const modelLogReader: LogReader = async (issue, rows) => {
  const prompt = [
    `THE REPORT\n${issue.slice(0, 3000)}`,
    "FAILURES",
    ...rows.map((r, i) => `${i + 1}. ${r.count > 1 ? `${r.count}×, newest ` : ""}${r.at} [${r.group}] ${r.message.slice(0, 600)}`),
  ].join("\n\n");
  const { object } = await generateObject({ model: getModel("standard"), schema: Schema, system: SYSTEM, prompt });
  return object;
};

/**
 * The failure section of the evidence. Pure.
 *
 * With a reading: its summary, the related rows (shortened, each with a link
 * when `link` gives one) and a count of what was left out. Without one (no
 * model, or the read failed): the grouped rows as before, so a dev item never
 * loses its evidence to a model error.
 */
export function failureSection<R extends FailureRow>(
  rows: R[],
  reading: LogReading | null,
  searchedFor: string,
  link?: (row: R) => string | null,
): string[] {
  if (!rows.length) return ["No error or failure lines for this customer in that window."];
  const row = (g: R, max: number) => {
    const url = link?.(g);
    return `- ${g.count > 1 ? `${g.count}× (newest ${g.at})` : g.at} [${g.group}] ${g.message.slice(0, max)}${g.message.length > max ? "…" : ""}${url ? ` ${url}` : ""}`;
  };
  if (!reading) return [`Newest error/failure lines for ${searchedFor}:`, ...rows.map((g) => row(g, 300))];
  const picked = [...new Set(reading.related)].filter((n) => Number.isInteger(n) && n >= 1 && n <= rows.length).map((n) => rows[n - 1]);
  const others = rows.length - picked.length;
  const kinds = (n: number) => `${n} ${n === 1 ? "kind" : "kinds"} of failure`;
  const leftOut = others
    ? `${kinds(others)} for this customer in that window ${others === 1 ? "does" : "do"} not look related to the report and ${others === 1 ? "is" : "are"} left out (ask Jetta in Slack or the console for the full list).`
    : "";
  if (!picked.length || !reading.summary.trim()) {
    return [`No failure in the logs matches what the customer reports (looked at ${searchedFor}).`, ...(leftOut ? [leftOut] : [])];
  }
  return [
    `What the logs show for this report (Jetta's reading, matched against ${searchedFor}; check the lines before relying on it):`,
    reading.summary.trim(),
    "The lines behind it:",
    ...picked.map((g) => row(g, 160)),
    ...(leftOut ? [`Also: ${leftOut}`] : []),
  ];
}
