/** Small pieces every /health card shares. */
import type { DrillRequest } from "./drill-sheet";

export const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);

/** Opens the tickets behind a number. */
export type Open = (r: DrillRequest) => void;
