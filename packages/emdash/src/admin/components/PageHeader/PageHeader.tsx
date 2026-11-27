import { Tooltip } from "@cloudflare/kumo";
import { InfoIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";

import type { TranslationUsage } from "../../../contracts.js";
import { mutedStyle, pageTitleStyle, sectionHeaderStyle, sectionTitleStyle } from "../../styles.js";
import { usageTooltipText } from "../../utils.js";

/** An ⓘ that explains what it sits next to on hover, focus, or click (Kumo's `labelTooltip` ignores clicks). */
export function InfoTooltip({ label, content }: { label: string; content: string }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      open={open}
      onOpenChange={setOpen}
      delay={150}
      content={content}
      render={
        <button
          type="button"
          aria-label={label}
          onClick={() => setOpen((current) => !current)}
          style={{
            alignItems: "center",
            background: "none",
            border: "none",
            color: "inherit",
            cursor: "help",
            display: "inline-flex",
            justifyContent: "center",
            // WCAG 2.2 minimum target size, without changing the icon's visible size.
            margin: -4,
            minHeight: 24,
            minWidth: 24,
            padding: 0,
          }}
        />
      }
    >
      <InfoIcon size={16} />
    </Tooltip>
  );
}

/** Text with a dotted underline that explains itself like `InfoTooltip`, for short summaries such as "18 locales". */
export function TextTooltip({ children, content, label }: { children: string; content: string; label?: string | undefined }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      open={open}
      onOpenChange={setOpen}
      delay={150}
      content={content}
      render={
        <button
          type="button"
          aria-label={label}
          onClick={() => setOpen((current) => !current)}
          style={{
            background: "none",
            border: "none",
            borderBottom: "1px dotted currentColor",
            color: "inherit",
            cursor: "help",
            font: "inherit",
            padding: 0,
          }}
        />
      }
    >
      {children}
    </Tooltip>
  );
}

/** Existing text that shows a translation's token usage and cost estimate on hover; plain text without usage. */
export function UsageTooltip({ usage, children }: { usage: TranslationUsage | undefined; children: string }): ReactNode {
  if (usage === undefined || usage.calls === 0) return children;
  const text = usageTooltipText(usage);
  return (
    <TextTooltip content={text} label={`${children}. ${text}`}>
      {children}
    </TextTooltip>
  );
}

/** A control's label followed by an ⓘ; a button inside a `<label>` doesn't toggle the control. */
export function InfoLabel({ label, info }: { label: string; info: string }): ReactNode {
  return (
    <span style={{ alignItems: "center", display: "inline-flex", gap: 4 }}>
      {label}
      <InfoTooltip label={`About ${label}`} content={info} />
    </span>
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
