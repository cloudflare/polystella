import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/** The icon every PolyStella control that opens a new window shows, with the same words for screen readers. */
export function NewWindowIcon(): ReactNode {
  return (
    <>
      <ArrowSquareOutIcon size={14} aria-hidden="true" style={{ marginLeft: 4, verticalAlign: "-2px" }} />
      <span style={visuallyHidden}> (opens in a new window)</span>
    </>
  );
}

export function NewWindowLink({ href, children, title }: { href: string; children: ReactNode; title?: string }): ReactNode {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title}>
      {children}
      <NewWindowIcon />
    </a>
  );
}

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
