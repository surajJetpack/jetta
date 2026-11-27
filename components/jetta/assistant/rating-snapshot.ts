import type { TranscriptLine } from "./live-voice";

export interface AnswerSnapshot {
  question: string;
  answer: string;
  steps: string[];
}

/**
 * Which transcript lines end an answer, and what that answer was. Pure.
 *
 * An answer is everything Jetta said after the last question, with the
 * lookups she ran on the way. It can span several lines (she speaks, looks
 * something up, speaks again), so the rating goes on the last one, and the
 * snapshot joins them. A line still being spoken is not finished: no rating
 * until it is.
 */
export function answerEnds(lines: TranscriptLine[]): Map<number, AnswerSnapshot> {
  const out = new Map<number, AnswerSnapshot>();
  let question = "";
  let said: string[] = [];
  let steps: string[] = [];
  let lastJetta: TranscriptLine | null = null;
  const close = () => {
    if (lastJetta && !lastJetta.partial && said.length) {
      out.set(lastJetta.id, { question, answer: said.join("\n\n"), steps });
    }
  };
  for (const l of lines) {
    if (l.who === "you") {
      close();
      question = l.text;
      said = [];
      steps = [];
      lastJetta = null;
    } else if (l.who === "tool") {
      steps.push(l.links?.length ? `${l.text}: ${l.links.map((k) => k.label).join(", ")}` : l.text);
    } else {
      if (l.text.trim()) said.push(l.text.trim());
      lastJetta = l;
    }
  }
  close();
  return out;
}
