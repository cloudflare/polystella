import { Button, LayerCard, Select, Textarea } from "@cloudflare/kumo";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import type { CustomizationMode, TranslationSettingsResponse } from "../../contracts.js";
import { ErrorMessage } from "../components/ErrorMessage/ErrorMessage.js";
import { PageTitle, SectionHeader } from "../components/PageHeader/PageHeader.js";
import { cardStyle, codeStyle, mutedStyle, pageStyle, rowStyle, sectionStyle, stackStyle } from "../styles.js";
import { errorMessage, localeLabel, pluginPageUrl, pluginRequest } from "../utils.js";
import {
  CUSTOMIZATION_MODES,
  GLOSSARY_MODE_LABELS,
  INSTRUCTION_MODE_LABELS,
  isCustomizationMode,
  saveTranslationSettings,
} from "./tabs/TranslationSettingsTab/TranslationSettingsTab.js";

/** The code-defined instructions, or one locale's code-defined glossary, opened from Translation settings, with the admin's changes. */
export function CodeDefaultsPage(): ReactNode {
  const [query] = useState(() => new URLSearchParams(window.location.search));
  const [settings, setSettings] = useState<TranslationSettingsResponse | null>(null);
  // As loaded or last saved, to tell whether there are unsaved changes.
  const [storedSettings, setStoredSettings] = useState<TranslationSettingsResponse | null>(null);
  const [working, setWorking] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const locale = query.get("locale");

  useEffect(() => {
    let active = true;
    setLoadError(null);
    pluginRequest<TranslationSettingsResponse>("settings/translation")
      .then((value) => {
        if (!active) return;
        setSettings(value);
        setStoredSettings(value);
      })
      .catch((cause: unknown) => {
        if (active) setLoadError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [loadAttempt]);

  const current = editableText(settings, locale);
  const stored = editableText(storedSettings, locale);
  const dirty = current.mode !== stored.mode || current.text !== stored.text;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const localeSettings = locale === null ? undefined : settings?.locales.find((item) => item.locale === locale);
  const title = locale === null ? "Code-defined additional translation instructions" : `Code-defined glossary: ${localeLabel(locale)}`;
  const editable = settings !== null && (locale === null || localeSettings !== undefined);
  const mode = current.mode;
  const customText = current.text;
  const modeLabels = locale === null ? INSTRUCTION_MODE_LABELS : GLOSSARY_MODE_LABELS;
  const codeText =
    settings === null
      ? null
      : locale === null
        ? settings.instructions.defaultText || "No code-defined instructions."
        : localeSettings === undefined
          ? `${localeLabel(locale)} is not a configured locale.`
          : localeSettings.defaultGlossary || "No code-defined glossary.";

  function update(change: { mode?: CustomizationMode; text?: string }): void {
    setSaved(false);
    setSettings((current) => {
      if (current === null) return null;
      if (locale === null) return { ...current, instructions: { ...current.instructions, ...change } };
      return {
        ...current,
        locales: current.locales.map((item) =>
          item.locale !== locale
            ? item
            : {
                ...item,
                ...(change.mode === undefined ? {} : { glossaryMode: change.mode }),
                ...(change.text === undefined ? {} : { glossaryText: change.text }),
              },
        ),
      };
    });
  }

  async function save(): Promise<void> {
    if (settings === null) return;
    setWorking(true);
    setSaveError(null);
    setSaved(false);
    try {
      const next = await saveTranslationSettings(settings);
      setSettings(next);
      setStoredSettings(next);
      setSaved(true);
    } catch (cause) {
      setSaveError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  return (
    <main style={pageStyle}>
      <PageTitle>PolyStella</PageTitle>
      <section style={sectionStyle}>
        <SectionHeader
          title={title}
          description={
            <>
              The code-defined text comes from the site's code and can't be changed here. Add to it or replace it below; this is the same
              setting as in{" "}
              <a
                href={pluginPageUrl("/settings", { tab: "translation" })}
                onClick={(event) => {
                  if (dirty && !window.confirm("Leave without saving your changes?")) event.preventDefault();
                }}
              >
                Translation settings
              </a>
              .
            </>
          }
        />
        {loadError === null ? null : (
          <>
            <ErrorMessage>{loadError}</ErrorMessage>
            <div>
              <Button variant="secondary" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
                Retry
              </Button>
            </div>
          </>
        )}
        {loadError !== null && settings === null ? null : (
          <LayerCard style={readingCardStyle}>
            <pre style={codeStyle}>{codeText ?? "Loading..."}</pre>
          </LayerCard>
        )}
        {!editable || mode === undefined ? null : (
          <LayerCard style={readingCardStyle}>
            <div style={stackStyle}>
              <Select
                label={locale === null ? "Instruction behavior" : "Glossary behavior"}
                value={mode}
                renderValue={(value) => (isCustomizationMode(value) ? modeLabels[value] : "")}
                disabled={working}
                onValueChange={(value) => {
                  if (isCustomizationMode(value)) update({ mode: value });
                }}
              >
                {CUSTOMIZATION_MODES.map((option) => (
                  <Select.Option key={option} value={option}>
                    {modeLabels[option]}
                  </Select.Option>
                ))}
              </Select>
              {mode === "default" ? null : (
                <Textarea
                  label={locale === null ? "Custom instructions" : "Custom glossary"}
                  rows={8}
                  value={customText}
                  disabled={working}
                  onValueChange={(text) => update({ text })}
                />
              )}
              {saveError === null ? null : <ErrorMessage>{saveError}</ErrorMessage>}
              <div style={rowStyle}>
                <Button variant="primary" loading={working} disabled={!dirty} onClick={() => void save()}>
                  Save
                </Button>
                <small role="status" style={mutedStyle}>
                  {saved ? "Saved" : null}
                </small>
              </div>
            </div>
          </LayerCard>
        )}
      </section>
    </main>
  );
}

const readingCardStyle: CSSProperties = { ...cardStyle, maxWidth: 880 };

/** The mode and custom text this page edits: the instructions, or `locale`'s glossary. */
function editableText(
  settings: TranslationSettingsResponse | null,
  locale: string | null,
): { mode: CustomizationMode | undefined; text: string } {
  if (locale === null) return { mode: settings?.instructions.mode, text: settings?.instructions.text ?? "" };
  const item = settings?.locales.find((candidate) => candidate.locale === locale);
  return { mode: item?.glossaryMode, text: item?.glossaryText ?? "" };
}
