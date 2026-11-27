import { Button } from "@cloudflare/kumo";
import { useId, type CSSProperties, type ReactNode } from "react";

import { MAX_CONTENT_FIELDS } from "../../../contracts.js";
import { mutedStyle, rowStyle, SWITCH_ON_CLASS } from "../../styles.js";

export interface FieldOption {
  slug: string;
  label: string;
  disabled: boolean;
  title?: string | undefined;
}

/** The current choice plus every other field that can be chosen, up to `max`. */
export function selectAllFields(options: readonly FieldOption[], selected: readonly string[] = [], max = MAX_CONTENT_FIELDS): string[] {
  const rest = options.filter((option) => !option.disabled && !selected.includes(option.slug)).map((option) => option.slug);
  return [...selected, ...rest].slice(0, max);
}

/** Fields as toggle chips, with Select all and Clear all, up to `max` chosen. */
export function FieldChips({
  options,
  selected,
  disabled,
  label = "Fields to translate",
  max = MAX_CONTENT_FIELDS,
  description,
  labelStyle,
  trailing,
  onChange,
}: {
  options: readonly FieldOption[];
  selected: readonly string[];
  disabled: boolean;
  label?: string | undefined;
  max?: number | undefined;
  description?: string | undefined;
  labelStyle?: CSSProperties | undefined;
  /** A second control joined to the right of a chip, such as a caret opening its options. */
  trailing?: ((option: FieldOption, pressed: boolean) => ReactNode) | undefined;
  onChange(selected: string[]): void;
}): ReactNode {
  const labelId = useId();
  const full = selected.length >= max;
  const allSelected = options.every((option) => option.disabled || selected.includes(option.slug));
  return (
    <div role="group" aria-labelledby={labelId} style={{ display: "grid", gap: 8 }}>
      <div style={{ ...rowStyle, gap: 4, justifyContent: "space-between" }}>
        <span id={labelId} className={FIELD_LABEL_CLASS} style={labelStyle}>
          {label}
        </span>
        <span style={{ display: "inline-flex", gap: 4 }}>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || full || allSelected}
            onClick={() => onChange(selectAllFields(options, selected, max))}
          >
            Select all
          </Button>
          <Button size="sm" variant="ghost" disabled={disabled || selected.length === 0} onClick={() => onChange([])}>
            Clear all
          </Button>
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {options.map((option) => {
          const pressed = selected.includes(option.slug);
          const chipDisabled = disabled || option.disabled || (!pressed && full);
          const extra = trailing?.(option, pressed) ?? null;
          const chip = (
            <button
              key={option.slug}
              type="button"
              aria-pressed={pressed}
              title={option.title}
              disabled={chipDisabled}
              onClick={() => onChange(pressed ? selected.filter((slug) => slug !== option.slug) : [...selected, option.slug])}
              className={pressed ? SWITCH_ON_CLASS : undefined}
              style={{
                ...chipStyle,
                ...(pressed ? selectedChipStyle : toggleChipStyle),
                ...(chipDisabled ? disabledChipStyle : {}),
                ...(extra === null ? {} : joinedChipStyle),
              }}
            >
              {option.label}
            </button>
          );
          return extra === null ? (
            chip
          ) : (
            <span key={option.slug} style={{ display: "inline-flex" }}>
              {chip}
              {extra}
            </span>
          );
        })}
      </div>
      {description === undefined ? null : <small style={mutedStyle}>{description}</small>}
    </div>
  );
}

// Kumo's field label classes, so this heading matches a Select's label such as "Untranslated locales".
const FIELD_LABEL_CLASS = "text-base font-medium text-kumo-default";
// Selected chips take their colours from SWITCH_ON_CLASS, so their style sets none.
const chipStyle: CSSProperties = {
  border: "1px solid",
  borderRadius: 999,
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
  lineHeight: 1.4,
  padding: "4px 10px",
};
const toggleChipStyle: CSSProperties = { background: "transparent", borderColor: "var(--color-kumo-line, #d4d4d8)", color: "inherit" };
const selectedChipStyle: CSSProperties = { borderColor: "transparent" };
const disabledChipStyle: CSSProperties = { cursor: "not-allowed", opacity: 0.5 };
const joinedChipStyle: CSSProperties = { borderEndEndRadius: 0, borderStartEndRadius: 0 };
