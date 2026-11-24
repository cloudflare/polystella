import { Button, Input, LayerCard, Select, Switch, Textarea } from "@cloudflare/kumo";
import { useEffect, useState, type ReactNode } from "react";

import {
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  USE_CODE_DEFAULT_MODEL,
  type CustomizationMode,
  type ModelReasoningResponse,
  type TranslationLocaleSettings,
  type TranslationSettingsResponse,
} from "../../../../contracts.js";
import { errorMessage, localeLabel, pluginRequest } from "../../../utils.js";
import { cardStyle, codeStyle, mutedStyle, rowStyle, sectionStyle, stackStyle } from "../../../styles.js";
import { ErrorMessage } from "../../../components/ErrorMessage/ErrorMessage.js";

export function TranslationSettingsTab(): ReactNode {
  const [settings, setSettings] = useState<TranslationSettingsResponse | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    pluginRequest<TranslationSettingsResponse>("settings/translation")
      .then((value) => {
        if (active) setSettings(value);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  function updateLocale(locale: string, update: Partial<TranslationLocaleSettings>): void {
    setSettings((current) =>
      current === null
        ? null
        : { ...current, locales: current.locales.map((settings) => (settings.locale === locale ? { ...settings, ...update } : settings)) },
    );
  }

  async function save(): Promise<void> {
    if (settings === null) return;
    setWorking(true);
    setError(null);
    try {
      const value = await pluginRequest<TranslationSettingsResponse>("settings/translation", {
        method: "PUT",
        body: JSON.stringify({
          revision: settings.revision,
          debugEnabled: settings.debugEnabled,
          maxTokens: settings.maxTokens,
          clearAiFlagOnEdit: settings.clearAiFlagOnEdit,
          locales: Object.fromEntries(
            settings.locales.map((locale) => [
              locale.locale,
              {
                model: locale.model,
                reasoning: locale.reasoning,
                glossaryMode: locale.glossaryMode,
                glossaryText: locale.glossaryText,
              },
            ]),
          ),
          instructions: { mode: settings.instructions.mode, text: settings.instructions.text },
        }),
      });
      setSettings(value);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  if (settings === null && error === null) return <p style={sectionStyle}>Loading translation settings...</p>;

  return (
    <section style={sectionStyle}>
      <div>
        <h2>Translation settings</h2>
        <p style={mutedStyle}>Choose a model and customize code-defined guidance without redeploying.</p>
      </div>
      {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
      {settings === null ? null : (
        <LayerCard style={cardStyle}>
          <div style={stackStyle}>
            <Switch
              label="Debug mode"
              labelTooltip="Administrators receive request-scoped prompts, normalized model responses, and batch diagnostics. Debug traces are not stored on the server."
              checked={settings.debugEnabled}
              disabled={working}
              onCheckedChange={(debugEnabled) => setSettings((current) => (current === null ? null : { ...current, debugEnabled }))}
            />
            <Input
              label="Max output tokens"
              type="number"
              min={MIN_MAX_TOKENS}
              max={MAX_MAX_TOKENS}
              step={1}
              placeholder={`Default (${settings.defaultMaxTokens})`}
              labelTooltip={`Raise this if long entries fail with truncated responses. Leave empty to use the default (${settings.defaultMaxTokens}).`}
              value={settings.maxTokens?.toString() ?? ""}
              disabled={working}
              onChange={(event) => {
                const text = event.target.value.trim();
                const maxTokens = text.length === 0 ? null : Number(text);
                setSettings((current) => (current === null ? null : { ...current, maxTokens }));
              }}
            />
            <Switch
              label="Remove the AI-translated flag when an editor changes AI text"
              labelTooltip="Off: the flag stays, and the PolyStella panel on the entry shows which AI-written fields were edited, with Keep AI flag and Remove AI flag. On: saving different text in an AI-written field removes the flag right away."
              checked={settings.clearAiFlagOnEdit}
              disabled={working}
              onCheckedChange={(clearAiFlagOnEdit) =>
                setSettings((current) => (current === null ? null : { ...current, clearAiFlagOnEdit }))
              }
            />
            <h3>Shared translation instructions</h3>
            <Select
              label="Instruction behavior"
              value={settings.instructions.mode}
              disabled={working}
              onValueChange={(value) => {
                if (isCustomizationMode(value)) {
                  setSettings((current) =>
                    current === null ? null : { ...current, instructions: { ...current.instructions, mode: value } },
                  );
                }
              }}
            >
              <Select.Option value="default">Use code defaults</Select.Option>
              <Select.Option value="append">Append custom instructions</Select.Option>
              <Select.Option value="replace">Replace code instructions</Select.Option>
            </Select>
            {settings.instructions.mode === "default" ? null : (
              <Textarea
                label="Custom instructions"
                rows={5}
                value={settings.instructions.text}
                disabled={working}
                onValueChange={(text) =>
                  setSettings((current) => (current === null ? null : { ...current, instructions: { ...current.instructions, text } }))
                }
              />
            )}
            <details>
              <summary>View code-defined instructions</summary>
              <pre style={codeStyle}>{settings.instructions.defaultText || "No code-defined instructions."}</pre>
            </details>
          </div>
        </LayerCard>
      )}
      {settings?.locales.map((locale) => (
        <LayerCard key={locale.locale}>
          <details>
            <summary style={{ cursor: "pointer", padding: 20 }}>
              <strong>{localeLabel(locale.locale)}</strong>
            </summary>
            <div style={{ ...stackStyle, padding: "0 20px 20px" }}>
              <Select
                label="Translation model"
                value={locale.model ?? USE_CODE_DEFAULT_MODEL}
                renderValue={(value) =>
                  value === USE_CODE_DEFAULT_MODEL ? `Code default (${locale.defaultModel})` : typeof value === "string" ? value : ""
                }
                disabled={working}
                onValueChange={(value) => {
                  if (typeof value === "string") {
                    updateLocale(locale.locale, { model: value === USE_CODE_DEFAULT_MODEL ? null : value, reasoning: null });
                  }
                }}
              >
                <Select.Option value={USE_CODE_DEFAULT_MODEL}>Code default ({locale.defaultModel})</Select.Option>
                {settings.allowedModels.map((model) => (
                  <Select.Option key={model} value={model}>
                    {model}
                  </Select.Option>
                ))}
              </Select>
              {locale.model === null ? (
                locale.defaultReasoning === null ? null : (
                  <span style={mutedStyle}>Thinking: code default ({effortLabel(locale.defaultReasoning)})</span>
                )
              ) : (
                <ThinkingSelect
                  model={locale.model}
                  value={locale.reasoning}
                  disabled={working}
                  onChange={(reasoning) => updateLocale(locale.locale, { reasoning })}
                />
              )}
              <Select
                label="Glossary behavior"
                value={locale.glossaryMode}
                disabled={working}
                onValueChange={(value) => {
                  if (isCustomizationMode(value)) updateLocale(locale.locale, { glossaryMode: value });
                }}
              >
                <Select.Option value="default">Use code default</Select.Option>
                <Select.Option value="append">Append custom glossary</Select.Option>
                <Select.Option value="replace">Replace code glossary</Select.Option>
              </Select>
              {locale.glossaryMode === "default" ? null : (
                <Textarea
                  label="Custom glossary"
                  description="Plain text appended to or used instead of the code-defined glossary."
                  rows={5}
                  value={locale.glossaryText}
                  disabled={working}
                  onValueChange={(glossaryText) => updateLocale(locale.locale, { glossaryText })}
                />
              )}
              <details>
                <summary>View code-defined glossary</summary>
                <pre style={codeStyle}>{locale.defaultGlossary || "No code-defined glossary."}</pre>
              </details>
            </div>
          </details>
        </LayerCard>
      ))}
      <div>
        <Button variant="primary" loading={working} disabled={settings === null} onClick={() => void save()}>
          Save translation settings
        </Button>
      </div>
    </section>
  );
}

const MODEL_DEFAULT_REASONING = "__polystella_model_default__";
const reasoningRequests = new Map<string, Promise<ModelReasoningResponse>>();

/** The thinking efforts Workers AI lists for `model`, loaded once per page. */
function ThinkingSelect({
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
            Reset to model default
          </Button>
        )}
      </div>
    );
  }
  return (
    <Select
      label="Thinking"
      labelTooltip="Off makes translations faster and cheaper. More thinking can help with tricky text, but it also uses output tokens."
      value={value ?? MODEL_DEFAULT_REASONING}
      renderValue={(selected) =>
        selected === MODEL_DEFAULT_REASONING || typeof selected !== "string" ? "Model default" : effortLabel(selected)
      }
      disabled={disabled}
      onValueChange={(selected) => {
        if (typeof selected === "string") onChange(selected === MODEL_DEFAULT_REASONING ? null : selected);
      }}
    >
      <Select.Option value={MODEL_DEFAULT_REASONING}>Model default</Select.Option>
      {options.efforts.map((effort) => (
        <Select.Option key={effort} value={effort}>
          {effortLabel(effort)}
        </Select.Option>
      ))}
    </Select>
  );
}

function effortLabel(effort: string): string {
  if (effort === "none") return "Off";
  if (effort === "on") return "On";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

function isCustomizationMode(value: unknown): value is CustomizationMode {
  return value === "default" || value === "append" || value === "replace";
}
