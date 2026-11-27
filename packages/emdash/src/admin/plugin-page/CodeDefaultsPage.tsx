import { Badge, Button, Input, LayerCard, Select, Tabs, Textarea } from "@cloudflare/kumo";
import type { Glossary } from "@cloudflare/polystella-core";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import type { CustomizationMode, TranslationLocaleSettings, TranslationSettingsResponse } from "../../contracts.js";
import { ErrorMessage } from "../components/ErrorMessage/ErrorMessage.js";
import { PageTitle, SectionHeader } from "../components/PageHeader/PageHeader.js";
import { cardStyle, codeStyle, mutedStyle, pageStyle, rowStyle, sectionStyle, stackStyle } from "../styles.js";
import { errorMessage, localeLabel, plural, pluginPageUrl, pluginRequest } from "../utils.js";
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
  // Only the load asks for the file text; saves don't return it.
  const [glossarySource, setGlossarySource] = useState<GlossarySource | null>(null);
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
    const sourceQuery = locale === null ? "" : `?${new URLSearchParams({ glossarySource: locale }).toString()}`;
    pluginRequest<TranslationSettingsResponse>(`settings/translation${sourceQuery}`)
      .then((value) => {
        if (!active) return;
        setSettings(value);
        setGlossarySource(value.locales.find((item) => item.locale === locale)?.defaultGlossarySource ?? null);
        setStoredSettings(value);
      })
      .catch((cause: unknown) => {
        if (active) setLoadError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [loadAttempt, locale]);

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
  const glossary = localeSettings?.defaultGlossary ?? null;
  const codeText =
    settings === null
      ? null
      : locale === null
        ? settings.instructions.defaultText || "No code-defined instructions."
        : localeSettings === undefined
          ? `${localeLabel(locale)} is not a configured locale.`
          : "No code-defined glossary.";
  const settingsLink = (
    <a
      href={pluginPageUrl("/settings", { tab: "translation" })}
      onClick={(event) => {
        if (dirty && !window.confirm("Leave without saving your changes?")) event.preventDefault();
      }}
    >
      Translation settings
    </a>
  );

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
            locale === null ? (
              <>
                The code-defined text comes from the site's code and can't be changed here. Add to it or replace it below; this is the same
                setting as in {settingsLink}.
              </>
            ) : (
              <>Set in the site's code. To add terms or override this glossary, use Glossary behavior below.</>
            )
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
        {loadError !== null && settings === null ? null : glossary !== null && glossarySource !== null ? (
          <CodeGlossaryView glossary={glossary} source={glossarySource} />
        ) : (
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
const glossaryViewStyle: CSSProperties = { ...stackStyle, maxWidth: 880 };
const rawStyle: CSSProperties = { margin: 0, maxHeight: 640, overflow: "auto" };
const overviewHeadingStyle: CSSProperties = { fontSize: 16, margin: 0 };
const chipsStyle: CSSProperties = { alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8 };
const pairListStyle: CSSProperties = { display: "grid", maxHeight: 480, overflowY: "auto" };
const pairRowStyle: CSSProperties = {
  borderTop: "1px solid var(--color-kumo-line, #ececef)",
  display: "grid",
  gap: 12,
  gridTemplateColumns: "1fr auto 1fr",
  padding: "8px 4px",
};
const TERM_PREVIEW_COUNT = 40;

type GlossarySource = NonNullable<TranslationLocaleSettings["defaultGlossarySource"]>;

/** A code glossary as Overview cards per section, or Raw: the file as written, with a copy button. */
export function CodeGlossaryView({ glossary, source }: { glossary: Glossary; source: GlossarySource }): ReactNode {
  const [tab, setTab] = useState<"overview" | "raw">("overview");
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const format = source.format === "yaml" ? "YAML" : "JSON";

  useEffect(() => {
    if (copy === "idle") return;
    const timer = window.setTimeout(() => setCopy("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copy]);

  return (
    <div style={glossaryViewStyle}>
      <div style={{ ...rowStyle, justifyContent: "space-between" }}>
        <Tabs
          variant="segmented"
          size="sm"
          tabs={[
            { value: "overview", label: "Overview" },
            { value: "raw", label: "Raw" },
          ]}
          value={tab}
          onValueChange={(value) => setTab(value === "raw" ? "raw" : "overview")}
        />
        <div style={rowStyle}>
          {tab === "raw" ? (
            <Badge variant="secondary">{format}</Badge>
          ) : glossary.version.length === 0 ? null : (
            <small style={mutedStyle}>Version {glossary.version}</small>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void copyText(source.text).then(
                () => setCopy("copied"),
                () => setCopy("failed"),
              )
            }
          >
            {copy === "copied" ? "Copied" : copy === "failed" ? "Couldn't copy" : `Copy ${format}`}
          </Button>
        </div>
      </div>
      <div style={stackStyle}>
        {tab === "raw" ? (
          <LayerCard style={cardStyle}>
            <pre style={rawStyle}>{source.text}</pre>
          </LayerCard>
        ) : (
          <GlossaryOverview glossary={glossary} />
        )}
      </div>
    </div>
  );
}

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

function GlossaryOverview({ glossary }: { glossary: Glossary }): ReactNode {
  const preferred = Object.entries(glossary.preferredTranslations);
  const notes = glossary.notes.trim();
  if (glossary.doNotTranslate.length === 0 && preferred.length === 0 && glossary.styleRules.length === 0 && notes.length === 0) {
    return (
      <LayerCard style={cardStyle}>
        <p style={{ ...mutedStyle, margin: 0 }}>This glossary has no terms, rules, or notes.</p>
      </LayerCard>
    );
  }
  return (
    <>
      {glossary.doNotTranslate.length === 0 ? null : <DoNotTranslateCard terms={glossary.doNotTranslate} />}
      {preferred.length === 0 ? null : (
        <OverviewCard title="Preferred translations" count={preferred.length.toLocaleString()}>
          <div style={pairListStyle}>
            {preferred.map(([term, translation]) => (
              <div key={term} style={pairRowStyle}>
                <span>{term}</span>
                <span role="img" aria-label="translates to" style={mutedStyle}>
                  →
                </span>
                <span>{translation}</span>
              </div>
            ))}
          </div>
        </OverviewCard>
      )}
      {glossary.styleRules.length === 0 ? null : (
        <OverviewCard title="Style rules">
          <ul style={{ display: "grid", gap: 6, margin: 0, paddingLeft: 20 }}>
            {glossary.styleRules.map((rule, index) => (
              <li key={index}>
                <strong>{rule.category}:</strong> {rule.instruction}
                {rule.example === undefined ? null : <span style={mutedStyle}> Example: {rule.example}</span>}
              </li>
            ))}
          </ul>
        </OverviewCard>
      )}
      {notes.length === 0 ? null : (
        <OverviewCard title="Notes">
          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{notes}</p>
        </OverviewCard>
      )}
    </>
  );
}

function OverviewCard({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: string;
  action?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <LayerCard style={cardStyle}>
      <div style={stackStyle}>
        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
          <div style={{ alignItems: "baseline", display: "flex", gap: 8 }}>
            <h3 style={overviewHeadingStyle}>{title}</h3>
            {count === undefined ? null : <span style={mutedStyle}>{count}</span>}
          </div>
          {action}
        </div>
        {children}
      </div>
    </LayerCard>
  );
}

function DoNotTranslateCard({ terms }: { terms: readonly string[] }): ReactNode {
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);
  const needle = filter.trim().toLowerCase();
  const matches = needle.length === 0 ? terms : terms.filter((term) => term.toLowerCase().includes(needle));
  const shown = showAll ? matches : matches.slice(0, TERM_PREVIEW_COUNT);
  return (
    <OverviewCard
      title="Don't translate"
      count={plural(terms.length, "term")}
      action={
        <Input
          size="sm"
          aria-label="Filter terms"
          placeholder="Filter terms"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      }
    >
      {matches.length === 0 ? (
        <small style={mutedStyle}>No terms match.</small>
      ) : (
        <div style={chipsStyle}>
          {shown.map((term, index) => (
            <Badge key={index} variant="outline">
              {term}
            </Badge>
          ))}
          {shown.length < matches.length ? (
            <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
              Show all {matches.length.toLocaleString()}
            </Button>
          ) : null}
        </div>
      )}
    </OverviewCard>
  );
}

/** The mode and custom text this page edits: the instructions, or `locale`'s glossary. */
function editableText(
  settings: TranslationSettingsResponse | null,
  locale: string | null,
): { mode: CustomizationMode | undefined; text: string } {
  if (locale === null) return { mode: settings?.instructions.mode, text: settings?.instructions.text ?? "" };
  const item = settings?.locales.find((candidate) => candidate.locale === locale);
  return { mode: item?.glossaryMode, text: item?.glossaryText ?? "" };
}
