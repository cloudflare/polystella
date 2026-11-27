import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/** The icon every PolyStella control that opens a new window shows, with the same words for screen readers. */
export function NewWindowIcon(): ReactNode {
  return (
    <>
      <ArrowSquareOutIcon size={14} aria-hidden="true" style={{ display: "inline-block", marginLeft: 4, verticalAlign: "-2px" }} />
      <span style={visuallyHidden}> (opens in a new window)</span>
    </>
  );
}

export function NewWindowLink({ href, children, title }: { href: string; children: ReactNode; title?: string }): ReactNode {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title} style={linkStyle}>
      {children}
      <NewWindowIcon />
    </a>
  );
}

// The host's own link colour is its accent; Kumo's link token keeps these links blue like Kumo's Link.
const linkStyle = { color: "var(--text-color-kumo-link, var(--color-kumo-brand))" } as const;

export const visuallyHidden = {
  border: 0,
  clip: "rect(0 0 0 0)",
  height: 1,
  margin: -1,
  overflow: "hidden",
  padding: 0,
  position: "absolute",
  whiteSpace: "nowrap",
  width: 1,
} as const;
