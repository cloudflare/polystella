import { Button, Select } from "@cloudflare/kumo";
import { useEffect, useState, type ReactNode } from "react";

import type { ModelReasoningResponse } from "../../../contracts.js";
import { errorMessage, pluginRequest } from "../../utils.js";
import { mutedStyle, rowStyle } from "../../styles.js";

const MODEL_DEFAULT_REASONING = "__polystella_model_default__";
const reasoningRequests = new Map<string, Promise<ModelReasoningResponse>>();

/** The thinking efforts Workers AI lists for `model`, loaded once per page. */
export function ThinkingSelect({
  model,
  value,
  disabled,
  onChange,
}: {
  model: string;
  value: string | null;
  disabled: boolean;
  onChange(value: string | null): void;
}): ReactNode {
  const [options, setOptions] = useState<ModelReasoningResponse | null>(null);

  useEffect(() => {
    let active = true;
    setOptions(null);
    let request = reasoningRequests.get(model);
    if (request === undefined) {
      request = pluginRequest<ModelReasoningResponse>(`models/reasoning?${new URLSearchParams({ model }).toString()}`);
      reasoningRequests.set(model, request);
      request.then(
        (response) => {
          if (response.error !== undefined) reasoningRequests.delete(model);
        },
        () => reasoningRequests.delete(model),
      );
    }
    request
      .then((next) => {
        if (active) setOptions(next);
      })
      .catch((cause: unknown) => {
        if (active) setOptions({ efforts: null, error: errorMessage(cause) });
      });
    return () => {
      active = false;
    };
  }, [model]);

  if (options === null) return <span style={mutedStyle}>Loading thinking options...</span>;
  if (options.efforts === null) {
    return (
      <div style={rowStyle}>
        <span style={mutedStyle}>
          {options.error === undefined
            ? "This model's thinking can't be changed; it uses its own default."
            : `Thinking options are unavailable: ${options.error}`}
          {value === null ? "" : ` Saved setting: ${effortLabel(value)}.`}
        </span>
        {value === null ? null : (
          <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onChange(null)}>
            Remove override
          </Button>
        )}
      </div>
    );
  }
  return (
    <Select
      label="Thinking"
      description="Off is faster and cheaper. More thinking can help with tricky text but uses output tokens. No override uses what the code sets for this model, if anything."
      value={value ?? MODEL_DEFAULT_REASONING}
      renderValue={(selected) =>
        selected === MODEL_DEFAULT_REASONING || typeof selected !== "string" ? "No override" : effortLabel(selected)
      }
      disabled={disabled}
      onValueChange={(selected) => {
        if (typeof selected === "string") onChange(selected === MODEL_DEFAULT_REASONING ? null : selected);
      }}
    >
      <Select.Option value={MODEL_DEFAULT_REASONING}>No override</Select.Option>
      {options.efforts.map((effort) => (
        <Select.Option key={effort} value={effort}>
          {effortLabel(effort)}
        </Select.Option>
      ))}
    </Select>
  );
}

const EFFORT_LABELS: Record<string, string> = { none: "Off", on: "On", xhigh: "Extra high" };

export function effortLabel(effort: string): string {
  const label = EFFORT_LABELS[effort] ?? effort.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
