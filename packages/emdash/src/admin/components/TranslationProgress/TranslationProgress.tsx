import { Badge } from "@cloudflare/kumo";
import { Fragment, type CSSProperties, type ReactNode } from "react";

import type { TranslationProgressState } from "../../types.js";
import { mutedStyle } from "../../styles.js";
import { UsageTooltip } from "../PageHeader/PageHeader.js";

const BRAND = "var(--color-kumo-brand, #2563eb)";
const SUCCESS = "var(--color-kumo-success, #1e8e3e)";
const FINISHED = {
  none: SUCCESS,
  some: "var(--color-kumo-warning, #d97706)",
  all: "var(--color-kumo-danger, #d93025)",
} as const;

type StepState = "done" | "current" | "todo";

/** A step list over a slim bar; at 100% every step is done and a Done badge shows. */
export function TranslationProgress({ percent, label, steps, step, detail, failures, usage }: TranslationProgressState): ReactNode {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  const done = value >= 100;
  const names = steps === undefined || steps.length === 0 ? [label] : steps;
  const current = done ? names.length : Math.max(0, Math.min(step ?? 0, names.length - 1));
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={stepRowStyle}>
        {names.map((name, index) => {
          const state: StepState = index < current ? "done" : index === current ? "current" : "todo";
          return (
            <Fragment key={index}>
              {index === 0 ? null : (
                <span aria-hidden="true" style={mutedStyle}>
                  ›
                </span>
              )}
              <span
                aria-current={state === "current" ? "step" : undefined}
                style={{ ...stepStyle, ...(state === "current" ? { fontWeight: 600 } : state === "todo" ? mutedStyle : {}) }}
              >
                <span aria-hidden="true" style={dotStyles[state]} />
                {detail === undefined && index === names.length - 1 ? <UsageTooltip usage={usage}>{name}</UsageTooltip> : name}
              </span>
            </Fragment>
          );
        })}
        {detail === undefined ? null : (
          <span style={mutedStyle}>
            <UsageTooltip usage={usage}>{detail}</UsageTooltip>
          </span>
        )}
        {!done ? null : failures === "all" ? (
          <Badge variant="destructive">Failed</Badge>
        ) : failures === "some" ? (
          <Badge variant="warning">Some failed</Badge>
        ) : (
          <Badge variant="success">Done</Badge>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={detail === undefined ? `${value}%: ${label}` : `${value}%: ${label}, ${detail}`}
        style={trackStyle}
      >
        <div style={{ ...fillStyle, background: done ? FINISHED[failures ?? "none"] : BRAND, width: `${value}%` }} />
      </div>
    </div>
  );
}

/** Progress part-way through `step` of `steps`; `fraction` is how far that step is (default: halfway). */
export function stepProgress(
  steps: readonly string[],
  step: number,
  label: string,
  { fraction = 0.5, detail }: { fraction?: number | undefined; detail?: string | undefined } = {},
): TranslationProgressState {
  return {
    steps,
    step,
    label,
    percent: Math.round(((step + fraction) / steps.length) * 100),
    ...(detail === undefined ? {} : { detail }),
  };
}

const stepRowStyle: CSSProperties = { alignItems: "center", display: "flex", flexWrap: "wrap", fontSize: 14, gap: 8 };
const stepStyle: CSSProperties = { alignItems: "center", display: "inline-flex", gap: 6 };
const dotStyle: CSSProperties = { borderRadius: "50%", display: "inline-block", flex: "none", height: 8, width: 8 };
const dotStyles: Record<StepState, CSSProperties> = {
  done: { ...dotStyle, background: SUCCESS },
  current: { ...dotStyle, background: BRAND, boxShadow: `0 0 0 3px color-mix(in srgb, ${BRAND} 25%, transparent)` },
  todo: { ...dotStyle, background: "var(--color-kumo-badge-neutral, #a3a3a8)" },
};
const trackStyle: CSSProperties = {
  background: "var(--color-kumo-line, #ececef)",
  borderRadius: 999,
  height: 6,
  overflow: "hidden",
  width: "100%",
};
const fillStyle: CSSProperties = { borderRadius: 999, height: "100%", transition: "width 200ms ease-out" };
