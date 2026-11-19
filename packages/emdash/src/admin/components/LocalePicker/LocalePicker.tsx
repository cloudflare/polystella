import { Button, Checkbox } from "@cloudflare/kumo";
import type { CSSProperties, ReactNode } from "react";

import { rowStyle, stackStyle } from "../../styles.js";

const localeGridStyle: CSSProperties = {
  display: "grid",
  gap: "8px 16px",
  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
};

export interface LocaleOption {
  locale: string;
  label: string;
}

export function LocalePicker({
  legend,
  options,
  value,
  disabled,
  onChange,
  actions,
}: {
  legend: string;
  options: readonly LocaleOption[];
  value: readonly string[];
  disabled: boolean;
  onChange(value: string[]): void;
  /** Extra buttons shown after Select all / Clear all. */
  actions?: ReactNode;
}): ReactNode {
  const all = options.map(({ locale }) => locale);
  return (
    <div style={stackStyle}>
      <Checkbox.Group legend={legend} value={[...value]} allValues={all} disabled={disabled} onValueChange={onChange}>
        {/* Kumo always stacks group items in one column; this grid packs them into rows instead. */}
        <div style={localeGridStyle}>
          {options.map(({ locale, label }) => (
            <Checkbox.Item key={locale} value={locale} label={label} />
          ))}
        </div>
      </Checkbox.Group>
      <div style={rowStyle}>
        <Button size="sm" variant="secondary" disabled={disabled || value.length === all.length} onClick={() => onChange(all)}>
          Select all
        </Button>
        <Button size="sm" variant="secondary" disabled={disabled || value.length === 0} onClick={() => onChange([])}>
          Clear all
        </Button>
        {actions}
      </div>
    </div>
  );
}
