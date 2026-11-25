import { LayerCard } from "@cloudflare/kumo";
import { useEffect, useState, type ReactNode } from "react";

import type { TranslationSettingsResponse } from "../../contracts.js";
import { ErrorMessage } from "../components/ErrorMessage/ErrorMessage.js";
import { PageTitle, SectionHeader } from "../components/PageHeader/PageHeader.js";
import { cardStyle, codeStyle, pageStyle, sectionStyle } from "../styles.js";
import { errorMessage, localeLabel, pluginPageUrl, pluginRequest } from "../utils.js";

/** The code-defined instructions, or one locale's code-defined glossary, opened from Translation settings. */
export function CodeDefaultsPage(): ReactNode {
  const [query] = useState(() => new URLSearchParams(window.location.search));
  const [settings, setSettings] = useState<TranslationSettingsResponse | null>(null);
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
  const text =
    settings === null
      ? null
      : locale === null
        ? settings.instructions.defaultText || "No code-defined instructions."
        : localeSettings === undefined
          ? `${locale} is not a configured locale.`
          : localeSettings.defaultGlossary || "No code-defined glossary.";

  return (
    <main style={pageStyle}>
      <PageTitle>PolyStella</PageTitle>
      <section style={sectionStyle}>
        <SectionHeader
          title={title}
          description={
            <>
              Read-only: these come from the site's code. Change what is sent in{" "}
              <a href={pluginPageUrl("/settings", { tab: "translation" })}>Translation settings</a>.
            </>
          }
        />
        {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
        {error === null ? (
          <LayerCard style={cardStyle}>
            <pre style={codeStyle}>{text ?? "Loading..."}</pre>
          </LayerCard>
        ) : null}
      </section>
    </main>
  );
}
