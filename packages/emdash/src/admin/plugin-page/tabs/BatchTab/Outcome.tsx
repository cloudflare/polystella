import { Badge } from "@cloudflare/kumo";
import type { CSSProperties, ReactNode } from "react";

import type { BatchJobOutcome } from "../../../../contracts.js";
import { rowStyle } from "../../../styles.js";
import { TextTooltip } from "../../../components/PageHeader/PageHeader.js";

export const OUTCOMES: ReadonlyArray<{ outcome: BatchJobOutcome; color: string; info: string }> = [
  { outcome: "created", color: "var(--color-kumo-success, #1e8e3e)", info: "New translations this job saved." },
  { outcome: "updated", color: "var(--color-kumo-badge-purple, #8e4ec6)", info: "Existing translations this job translated again." },
  {
    outcome: "skipped",
    color: "var(--color-kumo-badge-neutral, #a3a3a8)",
    info: "Already translated, or edited while the job ran. Nothing was changed.",
  },
  { outcome: "failed", color: "var(--color-kumo-danger, #d93025)", info: "Results says why. Retry... runs them again." },
];

/** One bar split by outcome; the rest of the track is work still to do. */
export function OutcomeBar({
  counts,
  total,
  width,
}: {
  counts: Readonly<Record<BatchJobOutcome, number>>;
  total: number;
  width: CSSProperties["width"];
}): ReactNode {
  const done = OUTCOMES.reduce((sum, { outcome }) => sum + counts[outcome], 0);
  const track = Math.max(total, done, 1);
  const summary = OUTCOMES.map(({ outcome }) => `${counts[outcome]} ${outcome}`).join(", ");
  return (
    <div role="img" aria-label={`${done} of ${total} done: ${summary}`} style={{ ...barStyle, width }}>
      {OUTCOMES.map(({ outcome, color }) =>
        counts[outcome] === 0 ? null : <span key={outcome} style={{ background: color, width: `${(counts[outcome] / track) * 100}%` }} />,
      )}
    </div>
  );
}

/** A dot and count per outcome, each with what it means. */
export function OutcomeCounts({ counts }: { counts: Readonly<Record<BatchJobOutcome, number>> }): ReactNode {
  return (
    <div style={{ ...rowStyle, columnGap: 14, rowGap: 4 }}>
      {OUTCOMES.map(({ outcome, color, info }) => (
        <small key={outcome} style={{ alignItems: "center", display: "inline-flex", gap: 6 }}>
          <span aria-hidden="true" style={{ ...dotStyle, background: color }} />
          <TextTooltip content={info}>{`${counts[outcome]} ${outcome}`}</TextTooltip>
        </small>
      ))}
    </div>
  );
}

export function OutcomeBadge({ outcome }: { outcome: BatchJobOutcome }): ReactNode {
  const variant = outcome === "created" ? "success" : outcome === "updated" ? "purple" : outcome === "failed" ? "error" : "secondary";
  return <Badge variant={variant}>{outcome.charAt(0).toUpperCase() + outcome.slice(1)}</Badge>;
}

const barStyle: CSSProperties = {
  background: "var(--color-kumo-fill, #e9e9ec)",
  borderRadius: 999,
  display: "flex",
  height: 6,
  overflow: "hidden",
};
const dotStyle: CSSProperties = { borderRadius: "50%", display: "inline-block", height: 8, width: 8 };
/** Kept in the accessibility tree for live announcements, but not drawn. */
export const visuallyHiddenStyle: CSSProperties = {
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  height: 1,
  overflow: "hidden",
  position: "absolute",
  whiteSpace: "nowrap",
  width: 1,
};
