import { Button, Select } from "@cloudflare/kumo";
import type { ReactNode } from "react";

import { rowStyle, stackStyle } from "../../styles.js";

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
      <Select<string, true>
        label={legend}
        multiple
        placeholder="Choose locales"
        value={[...value]}
        disabled={disabled}
        renderValue={(selected) => selectedLocalesLabel(selected, options)}
        onValueChange={(next) => onChange(all.filter((locale) => next.includes(locale)))}
      >
        {options.map(({ locale, label }) => (
          <Select.Option key={locale} value={locale}>
            {label}
          </Select.Option>
        ))}
      </Select>
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

function selectedLocalesLabel(selected: readonly string[], options: readonly LocaleOption[]): string {
  if (selected.length > 2) return `${selected.length} locales`;
  return selected.map((locale) => options.find((option) => option.locale === locale)?.label ?? locale).join(", ");
}
