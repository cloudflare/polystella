import { Tooltip } from "@cloudflare/kumo";
import { InfoIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";

import { mutedStyle, pageTitleStyle, sectionHeaderStyle, sectionTitleStyle } from "../../styles.js";

/** An ⓘ that explains the heading it sits next to on hover or focus. */
export function InfoTooltip({ label, content }: { label: string; content: string }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      open={open}
      onOpenChange={setOpen}
      content={content}
      render={
        <button
          type="button"
          aria-label={label}
          onClick={() => setOpen((current) => !current)}
          style={{ background: "none", border: "none", color: "inherit", cursor: "help", display: "inline-flex", padding: 0 }}
        />
      }
    >
      <InfoIcon size={16} />
    </Tooltip>
  );
}

/** The small line naming the plugin page, above its section headings. */
export function PageTitle({ children }: { children: ReactNode }): ReactNode {
  return <h1 style={pageTitleStyle}>{children}</h1>;
}

/** A section's large heading and its one-line description. */
export function SectionHeader({ title, description }: { title: ReactNode; description?: ReactNode }): ReactNode {
  return (
    <div style={sectionHeaderStyle}>
      <h2 style={sectionTitleStyle}>{title}</h2>
      {description === undefined ? null : <p style={{ ...mutedStyle, margin: 0 }}>{description}</p>}
    </div>
  );
}
