import { Button, LayerCard, Select, Textarea } from "@cloudflare/kumo";
import { useEffect, useState, type ReactNode } from "react";

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
  const [working, setWorking] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locale = query.get("locale");

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

  const localeSettings = locale === null ? undefined : settings?.locales.find((item) => item.locale === locale);
  const title = locale === null ? "Code-defined additional translation instructions" : `Code-defined glossary: ${localeLabel(locale)}`;
  const editable = settings !== null && (locale === null || localeSettings !== undefined);
  const mode = locale === null ? settings?.instructions.mode : localeSettings?.glossaryMode;
  const customText = (locale === null ? settings?.instructions.text : localeSettings?.glossaryText) ?? "";
  const modeLabels = locale === null ? INSTRUCTION_MODE_LABELS : GLOSSARY_MODE_LABELS;
  const codeText =
    settings === null
      ? null
      : locale === null
        ? settings.instructions.defaultText || "No code-defined instructions."
        : localeSettings === undefined
          ? `${locale} is not a configured locale.`
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
    setError(null);
    setSaved(false);
    try {
      setSettings(await saveTranslationSettings(settings));
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
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
              setting as in <a href={pluginPageUrl("/settings", { tab: "translation" })}>Translation settings</a>.
            </>
          }
        />
        {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
        {error !== null && settings === null ? null : (
          <LayerCard style={cardStyle}>
            <pre style={codeStyle}>{codeText ?? "Loading..."}</pre>
          </LayerCard>
        )}
        {!editable || mode === undefined ? null : (
          <LayerCard style={cardStyle}>
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
              <div style={rowStyle}>
                <Button variant="primary" loading={working} onClick={() => void save()}>
                  Save
                </Button>
                {saved ? <small style={mutedStyle}>Saved.</small> : null}
              </div>
            </div>
          </LayerCard>
        )}
      </section>
    </main>
  );
}
