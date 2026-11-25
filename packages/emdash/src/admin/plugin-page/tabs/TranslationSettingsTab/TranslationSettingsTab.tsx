import { Button, Input, LayerCard, Select, Switch, Textarea } from "@cloudflare/kumo";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import {
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  USE_CODE_DEFAULT_MODEL,
  type CustomizationMode,
  type ModelReasoningResponse,
  type TranslationLocaleSettings,
  type TranslationSettingsResponse,
} from "../../../../contracts.js";
import { errorMessage, localeLabel, pluginPageUrl, pluginRequest } from "../../../utils.js";
import { cardStyle, mutedStyle, rowStyle, sectionStyle, stackStyle, subheadingStyle } from "../../../styles.js";
import { ErrorMessage } from "../../../components/ErrorMessage/ErrorMessage.js";
import { NewWindowLink } from "../../../components/NewWindowLink/NewWindowLink.js";
import { InfoTooltip, SectionHeader } from "../../../components/PageHeader/PageHeader.js";
import { cardGridStyle, CollapsibleCard } from "../../../components/CollapsibleCard/CollapsibleCard.js";

export function TranslationSettingsTab(): ReactNode {
  const [settings, setSettings] = useState<TranslationSettingsResponse | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openLocales, setOpenLocales] = useState<ReadonlySet<string>>(new Set());

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
          translateSeoWhenPublished: settings.translateSeoWhenPublished,
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
      <SectionHeader title="Translation settings" description="Choose a model and customize code-defined guidance without redeploying." />
      {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
      {settings === null ? null : (
        <div style={cardGridStyle}>
          <LayerCard style={cardStyle}>
            <div style={stackStyle}>
              <h3 style={cardHeadingStyle}>General</h3>
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
              <Switch
                label="Translate the SEO title and meta description of published and scheduled entries"
                labelTooltip="Off: the PolyStella panel translates SEO text only on drafts. On: it also translates it on published and scheduled entries. EmDash saves SEO text as soon as it changes, so on those entries the translation takes effect before anyone reviews it."
                checked={settings.translateSeoWhenPublished}
                disabled={working}
                onCheckedChange={(translateSeoWhenPublished) =>
                  setSettings((current) => (current === null ? null : { ...current, translateSeoWhenPublished }))
                }
              />
            </div>
          </LayerCard>
          <LayerCard style={cardStyle}>
            <div style={stackStyle}>
              <div style={{ alignItems: "center", display: "flex", gap: 6 }}>
                <h3 style={cardHeadingStyle}>Additional translation instructions</h3>
                <InfoTooltip
                  label="About additional translation instructions"
                  content="Sent with every translation in every language, together with that language's glossary."
                />
              </div>
              <Select
                label="Instruction behavior"
                value={settings.instructions.mode}
                renderValue={(value) => (isCustomizationMode(value) ? INSTRUCTION_MODE_LABELS[value] : "")}
                disabled={working}
                onValueChange={(value) => {
                  if (isCustomizationMode(value)) {
                    setSettings((current) =>
                      current === null ? null : { ...current, instructions: { ...current.instructions, mode: value } },
                    );
                  }
                }}
              >
                {CUSTOMIZATION_MODES.map((mode) => (
                  <Select.Option key={mode} value={mode}>
                    {INSTRUCTION_MODE_LABELS[mode]}
                  </Select.Option>
                ))}
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
              <span>
                <NewWindowLink href={pluginPageUrl("/code-defaults")}>View code-defined additional translation instructions</NewWindowLink>
              </span>
            </div>
          </LayerCard>
        </div>
      )}
      {settings === null || settings.locales.length === 0 ? null : <h3 style={subheadingStyle}>Languages</h3>}
      <div style={cardGridStyle}>
        {settings?.locales.map((locale) => (
          <CollapsibleCard
            key={locale.locale}
            label={localeLabel(locale.locale)}
            open={openLocales.has(locale.locale)}
            onOpenChange={(open) =>
              setOpenLocales((current) => {
                const next = new Set(current);
                if (open) next.add(locale.locale);
                else next.delete(locale.locale);
                return next;
              })
            }
            header={
              <>
                <strong>{localeLabel(locale.locale)}</strong>
                <small style={mutedStyle}>{locale.model ?? `Code default (${locale.defaultModel})`}</small>
              </>
            }
          >
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
              renderValue={(value) => (isCustomizationMode(value) ? GLOSSARY_MODE_LABELS[value] : "")}
              disabled={working}
              onValueChange={(value) => {
                if (isCustomizationMode(value)) updateLocale(locale.locale, { glossaryMode: value });
              }}
            >
              {CUSTOMIZATION_MODES.map((mode) => (
                <Select.Option key={mode} value={mode}>
                  {GLOSSARY_MODE_LABELS[mode]}
                </Select.Option>
              ))}
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
            <span>
              <NewWindowLink href={pluginPageUrl("/code-defaults", { locale: locale.locale })}>View code-defined glossary</NewWindowLink>
            </span>
          </CollapsibleCard>
        ))}
      </div>
      <div>
        <Button variant="primary" loading={working} disabled={settings === null} onClick={() => void save()}>
          Save translation settings
        </Button>
      </div>
    </section>
  );
}

const cardHeadingStyle: CSSProperties = { fontSize: 18, margin: 0 };

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
            Remove override
          </Button>
        )}
      </div>
    );
  }
  return (
    <Select
      label="Thinking"
      labelTooltip="Off makes translations faster and cheaper. More thinking can help with tricky text, but it also uses output tokens. No override sends what the code sets for this model, or nothing."
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

function effortLabel(effort: string): string {
  const label = EFFORT_LABELS[effort] ?? effort.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const CUSTOMIZATION_MODES: readonly CustomizationMode[] = ["default", "append", "replace"];
const INSTRUCTION_MODE_LABELS: Record<CustomizationMode, string> = {
  default: "Use code defaults",
  append: "Append custom instructions",
  replace: "Replace code instructions",
};
const GLOSSARY_MODE_LABELS: Record<CustomizationMode, string> = {
  default: "Use code default",
  append: "Append custom glossary",
  replace: "Replace code glossary",
};

function isCustomizationMode(value: unknown): value is CustomizationMode {
  return typeof value === "string" && (CUSTOMIZATION_MODES as readonly string[]).includes(value);
}
