import { Badge, Button, Input, Select, Textarea } from "@cloudflare/kumo";
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";

import {
  MAX_JOB_INSTRUCTION_CHARACTERS,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  type BatchJobSettings,
  type TranslationSettingsResponse,
} from "../../../contracts.js";
import { errorMessage, maxTokensError, pluginRequest, shortModelName } from "../../utils.js";
import { mutedStyle, stackStyle } from "../../styles.js";
import { ErrorMessage } from "../ErrorMessage/ErrorMessage.js";
import { InfoLabel } from "../PageHeader/PageHeader.js";
import { effortLabel, ThinkingSelect } from "../ThinkingSelect/ThinkingSelect.js";

export const EMPTY_JOB_SETTINGS: BatchJobSettings = { model: null, reasoning: null, maxTokens: null, instructions: "" };

const TRANSLATION_SETTINGS_MODEL = "__polystella_translation_settings__";
const SAME_AS_SETTINGS = "Same as translation settings";
let translationSettingsRequest: Promise<TranslationSettingsResponse> | null = null;

/** Run settings show the saved models and token limit, so a save replaces the copy they share. */
export function rememberTranslationSettings(settings: TranslationSettingsResponse): void {
  translationSettingsRequest = Promise.resolve(settings);
}

/** Run settings folded into a bordered row that names what this run changes; opens to `JobSettingsFields`. */
export function JobSettingsSection({
  value,
  disabled,
  onChange,
}: {
  value: BatchJobSettings;
  disabled: boolean;
  onChange(value: BatchJobSettings): void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const changes = jobSettingsChanges(value);
  return (
    <div style={sectionBoxStyle}>
      <div style={{ position: "relative" }}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={() => setOpen((current) => !current)}
          style={sectionHeaderStyle}
        >
          <span style={sectionSummaryStyle}>
            <strong>Run settings</strong>
            {changes.map((change) => (
              <Badge key={change} variant="info">
                {change}
              </Badge>
            ))}
          </span>
          {changes.length === 0 ? null : <span aria-hidden="true" style={{ flexShrink: 0, width: RESET_WIDTH }} />}
          {open ? <CaretUpIcon size={12} aria-hidden="true" /> : <CaretDownIcon size={12} aria-hidden="true" />}
        </button>
        {changes.length === 0 ? null : (
          <button type="button" disabled={disabled} onClick={() => onChange(EMPTY_JOB_SETTINGS)} style={resetButtonStyle}>
            Reset
          </button>
        )}
      </div>
      {open ? (
        <div id={bodyId} style={sectionBodyStyle}>
          <span style={mutedStyle}>For this run only. Anything left empty uses the translation settings.</span>
          <JobSettingsFields value={value} disabled={disabled} onChange={onChange} />
        </div>
      ) : null}
    </div>
  );
}

/** One short label per setting that differs from Translation settings, such as "Max tokens: 16,000". */
export function jobSettingsChanges(settings: BatchJobSettings): string[] {
  return [
    settings.model === null ? null : `Model: ${shortModelName(settings.model)}`,
    settings.reasoning === null ? null : `Thinking: ${effortLabel(settings.reasoning)}`,
    settings.maxTokens === null ? null : `Max tokens: ${settings.maxTokens.toLocaleString()}`,
    settings.instructions.trim().length === 0 ? null : "Instructions",
  ].filter((change) => change !== null);
}

/** Model, thinking, token limit, and additional instructions for one batch run; empty fields keep translation settings. */
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
  const [loadAttempt, setLoadAttempt] = useState(0);

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
  }, [loadAttempt]);

  if (error !== null) {
    return (
      <div style={stackStyle}>
        <ErrorMessage>Translation settings could not be loaded: {error}</ErrorMessage>
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setError(null);
              setLoadAttempt((current) => current + 1);
            }}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (defaults === null) return <span style={mutedStyle}>Loading translation settings...</span>;
  const tokensError = jobSettingsError(value);
  return (
    <div style={stackStyle}>
      <Select
        label={
          <InfoLabel label="Model" info="Used for every target locale of this run. Translation settings uses each locale's own model." />
        }
        value={value.model ?? TRANSLATION_SETTINGS_MODEL}
        renderValue={(selected) => (selected === TRANSLATION_SETTINGS_MODEL || typeof selected !== "string" ? SAME_AS_SETTINGS : selected)}
        disabled={disabled}
        onValueChange={(selected) => {
          if (typeof selected === "string")
            onChange({ ...value, model: selected === TRANSLATION_SETTINGS_MODEL ? null : selected, reasoning: null });
        }}
      >
        <Select.Option value={TRANSLATION_SETTINGS_MODEL}>{SAME_AS_SETTINGS}</Select.Option>
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
        aria-label="Max output tokens"
        type="number"
        min={MIN_MAX_TOKENS}
        max={MAX_MAX_TOKENS}
        step={1}
        placeholder={`${SAME_AS_SETTINGS} (${(defaults.maxTokens ?? defaults.defaultMaxTokens).toLocaleString()})`}
        value={value.maxTokens?.toString() ?? ""}
        disabled={disabled}
        {...(tokensError === undefined ? {} : { error: tokensError })}
        onChange={(event) => {
          const text = event.target.value.trim();
          onChange({ ...value, maxTokens: text.length === 0 ? null : Number(text) });
        }}
      />
      <Textarea
        label="Additional instructions"
        placeholder="For example: Use a friendly, informal tone."
        rows={3}
        maxLength={MAX_JOB_INSTRUCTION_CHARACTERS}
        value={value.instructions}
        disabled={disabled}
        onValueChange={(instructions) => onChange({ ...value, instructions })}
      />
    </div>
  );
}

/** Why the run can't start with these settings, or `undefined`. */
export function jobSettingsError(settings: BatchJobSettings): string | undefined {
  return maxTokensError(settings.maxTokens);
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
      : `${shortModelName(settings.model)}${settings.reasoning === null ? "" : `, thinking ${effortLabel(settings.reasoning)}`}`,
    settings.maxTokens === null ? null : `${settings.maxTokens.toLocaleString()} max output tokens`,
    settings.instructions.length === 0 ? null : "additional instructions",
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(", ");
}

const HEADER_PADDING = 14;
const CARET_SIZE = 12;
const RESET_WIDTH = 48;
const sectionBoxStyle: CSSProperties = {
  marginTop: 8,
  border: "1px solid var(--color-kumo-line, #e4e4e7)",
  borderRadius: 12,
  overflow: "hidden",
};
const sectionHeaderStyle: CSSProperties = {
  alignItems: "center",
  background: "none",
  border: 0,
  color: "inherit",
  cursor: "pointer",
  display: "flex",
  font: "inherit",
  gap: 8,
  padding: `10px ${HEADER_PADDING}px`,
  textAlign: "start",
  width: "100%",
};
const sectionSummaryStyle: CSSProperties = { alignItems: "center", display: "flex", flex: 1, flexWrap: "wrap", gap: 8, minWidth: 0 };
// Sits over the header's empty slot left of the caret; a button can't hold another button.
const resetButtonStyle: CSSProperties = {
  background: "none",
  border: 0,
  color: "inherit",
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
  padding: 0,
  position: "absolute",
  insetInlineEnd: HEADER_PADDING + CARET_SIZE + 8,
  textDecorationLine: "underline",
  textDecorationStyle: "dotted",
  textUnderlineOffset: 3,
  top: "50%",
  transform: "translateY(-50%)",
  width: RESET_WIDTH,
};
const sectionBodyStyle: CSSProperties = {
  ...stackStyle,
  background: "var(--color-kumo-tint, #f7f7f8)",
  borderTop: "1px solid var(--color-kumo-line, #e4e4e7)",
  padding: 14,
};
