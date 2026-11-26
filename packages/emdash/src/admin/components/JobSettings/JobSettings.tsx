import { Input, Select, Textarea } from "@cloudflare/kumo";
import { useEffect, useState, type ReactNode } from "react";

import {
  MAX_JOB_INSTRUCTION_CHARACTERS,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  type BatchJobSettings,
  type TranslationSettingsResponse,
} from "../../../contracts.js";
import { errorMessage, pluginRequest } from "../../utils.js";
import { mutedStyle, stackStyle } from "../../styles.js";
import { InfoLabel } from "../PageHeader/PageHeader.js";
import { effortLabel, ThinkingSelect } from "../ThinkingSelect/ThinkingSelect.js";

export const EMPTY_JOB_SETTINGS: BatchJobSettings = { model: null, reasoning: null, maxTokens: null, instructions: "" };

const TRANSLATION_SETTINGS_MODEL = "__polystella_translation_settings__";
let translationSettingsRequest: Promise<TranslationSettingsResponse> | null = null;

/** Model, thinking, token limit, and extra instructions for one batch run; empty fields keep Translation settings. */
export function JobSettingsFields({
  value,
  disabled,
  onChange,
}: {
  value: BatchJobSettings;
  disabled: boolean;
  onChange(value: BatchJobSettings): void;
}): ReactNode {
  const [defaults, setDefaults] = useState<TranslationSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    translationSettingsRequest ??= pluginRequest<TranslationSettingsResponse>("settings/translation");
    translationSettingsRequest
      .then((response) => {
        if (active) setDefaults(response);
      })
      .catch((cause: unknown) => {
        translationSettingsRequest = null;
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  if (error !== null) return <span style={mutedStyle}>Translation settings could not be loaded: {error}</span>;
  if (defaults === null) return <span style={mutedStyle}>Loading translation settings...</span>;
  return (
    <div style={stackStyle}>
      <Select
        label={
          <InfoLabel label="Model" info="Used for every target locale of this run. Translation settings uses each locale's own model." />
        }
        value={value.model ?? TRANSLATION_SETTINGS_MODEL}
        renderValue={(selected) =>
          selected === TRANSLATION_SETTINGS_MODEL || typeof selected !== "string" ? "Translation settings" : selected
        }
        disabled={disabled}
        onValueChange={(selected) => {
          if (typeof selected === "string")
            onChange({ ...value, model: selected === TRANSLATION_SETTINGS_MODEL ? null : selected, reasoning: null });
        }}
      >
        <Select.Option value={TRANSLATION_SETTINGS_MODEL}>Translation settings</Select.Option>
        {defaults.allowedModels.map((model) => (
          <Select.Option key={model} value={model}>
            {model}
          </Select.Option>
        ))}
      </Select>
      {value.model === null ? null : (
        <ThinkingSelect
          model={value.model}
          value={value.reasoning}
          disabled={disabled}
          onChange={(reasoning) => onChange({ ...value, reasoning })}
        />
      )}
      <Input
        label={<InfoLabel label="Max output tokens" info="Raise this if long entries fail with truncated responses." />}
        type="number"
        min={MIN_MAX_TOKENS}
        max={MAX_MAX_TOKENS}
        step={1}
        placeholder={`Translation settings (${defaults.maxTokens ?? defaults.defaultMaxTokens})`}
        value={value.maxTokens?.toString() ?? ""}
        disabled={disabled}
        onChange={(event) => {
          const text = event.target.value.trim();
          onChange({ ...value, maxTokens: text.length === 0 ? null : Number(text) });
        }}
      />
      <Textarea
        label="Extra instructions"
        description="Added after the translation instructions, for this run only. For example: Don't translate “PolyStella” or “Workers”."
        rows={3}
        maxLength={MAX_JOB_INSTRUCTION_CHARACTERS}
        value={value.instructions}
        disabled={disabled}
        onValueChange={(instructions) => onChange({ ...value, instructions })}
      />
    </div>
  );
}

/** What to send: `null` when nothing differs from Translation settings. */
export function jobSettingsPayload(settings: BatchJobSettings): BatchJobSettings | null {
  const instructions = settings.instructions.trim();
  if (settings.model === null && settings.maxTokens === null && instructions.length === 0) return null;
  return { ...settings, instructions };
}

export function jobSettingsSummary(settings: BatchJobSettings | null): string | null {
  if (settings === null) return null;
  const parts = [
    settings.model === null
      ? null
      : `${settings.model}${settings.reasoning === null ? "" : `, thinking ${effortLabel(settings.reasoning)}`}`,
    settings.maxTokens === null ? null : `${settings.maxTokens} max output tokens`,
    settings.instructions.length === 0 ? null : "extra instructions",
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(", ");
}
