import { Badge, Button, Input, LayerCard, Select, Switch, Textarea, Tooltip } from "@cloudflare/kumo";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import {
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  USE_CODE_DEFAULT_MODEL,
  type CustomizationMode,
  type TranslationLocaleSettings,
  type TranslationSettingsResponse,
} from "../../../../contracts.js";
import { errorMessage, localeLabel, maxTokensError, pluginPageUrl, pluginRequest, shortModelName } from "../../../utils.js";
import { cardStyle, mutedStyle, rowStyle, sectionStyle, stackStyle, subheadingStyle } from "../../../styles.js";
import { ErrorMessage } from "../../../components/ErrorMessage/ErrorMessage.js";
import { NewWindowLink } from "../../../components/NewWindowLink/NewWindowLink.js";
import { InfoLabel, InfoTooltip, SectionHeader } from "../../../components/PageHeader/PageHeader.js";
import { cardGridStyle, CollapsibleCard } from "../../../components/CollapsibleCard/CollapsibleCard.js";
import { rememberTranslationSettings } from "../../../components/JobSettings/JobSettings.js";
import { effortLabel, ThinkingSelect } from "../../../components/ThinkingSelect/ThinkingSelect.js";

export function TranslationSettingsTab(): ReactNode {
  const [settings, setSettings] = useState<TranslationSettingsResponse | null>(null);
  // The last saved response; "Saved" shows until an edit replaces `settings`.
  const [savedSettings, setSavedSettings] = useState<TranslationSettingsResponse | null>(null);
  const [working, setWorking] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [openLocales, setOpenLocales] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let active = true;
    setLoadError(null);
    pluginRequest<TranslationSettingsResponse>("settings/translation")
      .then((value) => {
        if (active) setSettings(value);
      })
      .catch((cause: unknown) => {
        if (active) setLoadError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [loadAttempt]);

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
    setSaveError(null);
    try {
      const saved = await saveTranslationSettings(settings);
      setSettings(saved);
      setSavedSettings(saved);
    } catch (cause) {
      setSaveError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  if (settings === null && loadError === null) return <p style={sectionStyle}>Loading translation settings...</p>;
  const tokensError = settings === null ? undefined : maxTokensError(settings.maxTokens);

  return (
    <section style={sectionStyle}>
      <SectionHeader title="Translation settings" description="Choose a model and customize code-defined guidance without redeploying." />
      {loadError === null ? null : (
        <>
          <ErrorMessage>{loadError}</ErrorMessage>
          <div>
            <Button variant="secondary" onClick={() => setLoadAttempt((current) => current + 1)}>
              Retry
            </Button>
          </div>
        </>
      )}
      {settings === null ? null : (
        <div style={{ ...cardGridStyle, alignItems: "stretch" }}>
          <LayerCard style={cardStyle}>
            <div style={stackStyle}>
              <h3 style={cardHeadingStyle}>General</h3>
              <div style={{ alignItems: "end", display: "flex", flexWrap: "wrap", gap: 8 }}>
                <Select
                  label={
                    <InfoLabel
                      label="Default model"
                      info="The model every language uses unless it picks its own under Languages. Only models the deployment allows are listed. From code: no model is picked here, so the site's code decides."
                    />
                  }
                  value={settings.model ?? USE_CODE_DEFAULT_MODEL}
                  renderValue={(value) => (
                    <ModelValue model={value === USE_CODE_DEFAULT_MODEL ? settings.defaultModel : typeof value === "string" ? value : ""} />
                  )}
                  disabled={working}
                  onValueChange={(value) => {
                    if (typeof value === "string") {
                      const model = value === USE_CODE_DEFAULT_MODEL ? null : value;
                      setSettings((current) => (current === null ? null : { ...current, model, reasoning: null }));
                    }
                  }}
                >
                  <Select.Option value={USE_CODE_DEFAULT_MODEL}>{shortModelName(settings.defaultModel)} (default)</Select.Option>
                  {settings.allowedModels.map((model) => (
                    <Select.Option key={model} value={model}>
                      {shortModelName(model)}
                    </Select.Option>
                  ))}
                </Select>
                {settings.model === null ? (
                  <span style={{ paddingBottom: 8 }}>
                    <Badge variant="secondary">From code</Badge>
                  </span>
                ) : null}
              </div>
              {settings.model === null ? null : (
                <ThinkingSelect
                  model={settings.model}
                  value={settings.reasoning}
                  disabled={working}
                  onChange={(reasoning) => setSettings((current) => (current === null ? null : { ...current, reasoning }))}
                />
              )}
              <Switch
                aria-label="Debug mode"
                label={
                  <InfoLabel
                    label="Debug mode"
                    info="Administrators receive request-scoped prompts, normalized model responses, and batch diagnostics. Debug traces are not stored on the server."
                  />
                }
                checked={settings.debugEnabled}
                disabled={working}
                onCheckedChange={(debugEnabled) => setSettings((current) => (current === null ? null : { ...current, debugEnabled }))}
              />
              <Input
                label="Max output tokens"
                description={`Raise this if long entries fail with truncated responses. ${MIN_MAX_TOKENS.toLocaleString()}–${MAX_MAX_TOKENS.toLocaleString()}; leave empty to use the code default (${settings.defaultMaxTokens.toLocaleString()}).`}
                {...(tokensError === undefined ? {} : { error: tokensError })}
                type="number"
                min={MIN_MAX_TOKENS}
                max={MAX_MAX_TOKENS}
                step={1}
                placeholder={`Default (${settings.defaultMaxTokens.toLocaleString()})`}
                value={settings.maxTokens?.toString() ?? ""}
                disabled={working}
                onChange={(event) => {
                  const text = event.target.value.trim();
                  const maxTokens = text.length === 0 ? null : Number(text);
                  setSettings((current) => (current === null ? null : { ...current, maxTokens }));
                }}
              />
              <Switch
                aria-label="Remove AI flag on edit"
                label={
                  <InfoLabel
                    label="Remove AI flag on edit"
                    info="Removes the AI-translated flag when an editor changes AI text. Off: the flag stays, and the PolyStella panel on the entry shows which AI-written fields were edited, with Keep AI flag and Remove AI flag. On: saving different text in an AI-written field removes the flag right away."
                  />
                }
                checked={settings.clearAiFlagOnEdit}
                disabled={working}
                onCheckedChange={(clearAiFlagOnEdit) =>
                  setSettings((current) => (current === null ? null : { ...current, clearAiFlagOnEdit }))
                }
              />
              <Switch
                aria-label="Translate SEO on published entries"
                label={
                  <InfoLabel
                    label="Translate SEO on published entries"
                    info="Covers the SEO title and meta description of published and scheduled entries. Off: the PolyStella panel translates SEO text only on drafts. On: it also translates it on published and scheduled entries. EmDash saves SEO text as soon as it changes, so on those entries the translation takes effect before anyone reviews it."
                  />
                }
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
      {settings === null ? null : <h3 style={subheadingStyle}>Languages</h3>}
      {settings === null || settings.locales.length > 0 ? null : (
        <p style={{ ...mutedStyle, margin: 0 }}>
          No translation languages are configured. They come from the site's PolyStella configuration, not from these settings.
        </p>
      )}
      <div style={cardGridStyle}>
        {settings?.locales.map((locale) => {
          const inheritedModel = settings.model ?? locale.defaultModel;
          const customization = localeCustomization(settings, locale);
          return (
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
                  <SummaryBadge
                    label={customization.custom ? "Custom" : "Default"}
                    variant={customization.custom ? "info" : "secondary"}
                    summary={customization.summary}
                  />
                </>
              }
            >
              <Select
                label="Translation model"
                value={locale.model ?? USE_CODE_DEFAULT_MODEL}
                renderValue={(value) => (
                  <ModelValue model={value === USE_CODE_DEFAULT_MODEL ? inheritedModel : typeof value === "string" ? value : ""} />
                )}
                disabled={working}
                onValueChange={(value) => {
                  if (typeof value === "string") {
                    updateLocale(locale.locale, { model: value === USE_CODE_DEFAULT_MODEL ? null : value, reasoning: null });
                  }
                }}
              >
                <Select.Option value={USE_CODE_DEFAULT_MODEL}>{shortModelName(inheritedModel)} (default)</Select.Option>
                {settings.allowedModels.map((model) => (
                  <Select.Option key={model} value={model}>
                    {shortModelName(model)}
                  </Select.Option>
                ))}
              </Select>
              {locale.model === null ? null : (
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
          );
        })}
      </div>
      {saveError === null ? null : <ErrorMessage>{saveError}</ErrorMessage>}
      <div style={rowStyle}>
        <Button variant="primary" loading={working} disabled={settings === null || tokensError !== undefined} onClick={() => void save()}>
          Save translation settings
        </Button>
        <small role="status" style={mutedStyle}>
          {settings !== null && settings === savedSettings ? "Saved" : null}
        </small>
      </div>
    </section>
  );
}

const cardHeadingStyle: CSSProperties = { fontSize: 18, margin: 0 };
// Kumo's Select trigger grows with its text, so a long model id would push it past the card.
const triggerValueStyle: CSSProperties = { display: "block", maxWidth: "min(320px, 60vw)", overflow: "hidden", textOverflow: "ellipsis" };
const badgeButtonStyle: CSSProperties = { background: "none", border: "none", cursor: "help", display: "inline-flex", padding: 0 };

/** A model's short name in a Select trigger, with the full id on hover. */
function ModelValue({ model }: { model: string }): ReactNode {
  return (
    <span style={triggerValueStyle} title={model}>
      {shortModelName(model)}
    </span>
  );
}

/** A badge that explains itself on hover, focus, or click, like `TextTooltip`. */
function SummaryBadge({ label, summary, variant }: { label: string; summary: string; variant: "secondary" | "info" }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      open={open}
      onOpenChange={setOpen}
      delay={150}
      content={summary}
      render={
        <button type="button" aria-label={`${label}: ${summary}`} onClick={() => setOpen((current) => !current)} style={badgeButtonStyle} />
      }
    >
      <Badge variant={variant}>{label}</Badge>
    </Tooltip>
  );
}

/** Whether a language overrides anything in these settings, and a one-line summary of what it uses or changed. */
export function localeCustomization(
  settings: Pick<TranslationSettingsResponse, "model" | "reasoning">,
  locale: TranslationLocaleSettings,
): { custom: boolean; summary: string } {
  const changes: string[] = [];
  if (locale.model !== null) {
    changes.push(`Model: ${shortModelName(locale.model)}`);
    if (locale.reasoning !== null) changes.push(`Thinking: ${effortLabel(locale.reasoning)}`);
  }
  // Empty text changes nothing, except that replacing with it removes a code glossary.
  const hasText = locale.glossaryText.trim().length > 0;
  if (
    (locale.glossaryMode === "replace" && (locale.defaultGlossary !== null || hasText)) ||
    (locale.glossaryMode === "append" && hasText)
  ) {
    changes.push(
      locale.defaultGlossary === null
        ? "Glossary: custom"
        : locale.glossaryMode === "replace"
          ? "Glossary: replaces the code glossary"
          : "Glossary: added to the code glossary",
    );
  }
  if (changes.length > 0) return { custom: true, summary: changes.join(" · ") };
  const model = settings.model ?? locale.defaultModel;
  const thinking = settings.model === null ? locale.defaultReasoning : settings.reasoning;
  const glossary = locale.defaultGlossary === null ? "no glossary" : "the code glossary";
  return {
    custom: false,
    summary: `Uses the default model, ${shortModelName(model)}, ${thinking === null ? "and" : `with thinking ${effortLabel(thinking).toLowerCase()} and`} ${glossary}.`,
  };
}

/** Saves every editable field of `settings`; the stored revision must still match. */
export async function saveTranslationSettings(settings: TranslationSettingsResponse): Promise<TranslationSettingsResponse> {
  const saved = await pluginRequest<TranslationSettingsResponse>("settings/translation", {
    method: "PUT",
    body: JSON.stringify({
      revision: settings.revision,
      debugEnabled: settings.debugEnabled,
      maxTokens: settings.maxTokens,
      clearAiFlagOnEdit: settings.clearAiFlagOnEdit,
      translateSeoWhenPublished: settings.translateSeoWhenPublished,
      model: settings.model,
      reasoning: settings.reasoning,
      locales: Object.fromEntries(
        settings.locales.map((locale) => [
          locale.locale,
          { model: locale.model, reasoning: locale.reasoning, glossaryMode: locale.glossaryMode, glossaryText: locale.glossaryText },
        ]),
      ),
      instructions: { mode: settings.instructions.mode, text: settings.instructions.text },
    }),
  });
  rememberTranslationSettings(saved);
  return saved;
}

export const CUSTOMIZATION_MODES: readonly CustomizationMode[] = ["default", "append", "replace"];
export const INSTRUCTION_MODE_LABELS: Record<CustomizationMode, string> = {
  default: "Use code defaults",
  append: "Append custom instructions",
  replace: "Replace code instructions",
};
export const GLOSSARY_MODE_LABELS: Record<CustomizationMode, string> = {
  default: "Use the code glossary",
  append: "Append custom glossary",
  replace: "Replace code glossary",
};

export function isCustomizationMode(value: unknown): value is CustomizationMode {
  return typeof value === "string" && (CUSTOMIZATION_MODES as readonly string[]).includes(value);
}
