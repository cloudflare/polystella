import { Badge, Banner, Button, LayerCard, Select, Textarea } from "@cloudflare/kumo";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  MAX_JOB_INSTRUCTION_CHARACTERS,
  MAX_SANDBOX_CHARACTERS,
  type TranslationDebugTrace,
  type TranslationSandboxResponse,
  type TranslationSettingsResponse,
  type TranslationUsage,
} from "../../../../contracts.js";
import { errorMessage, localeLabel, pluginPageUrl, pluginRequest, shortModelName } from "../../../utils.js";
import type { TranslationProgressState } from "../../../types.js";
import { cardStyle, inputStyle, mutedStyle, rowStyle, sectionStyle, stackStyle } from "../../../styles.js";
import { ErrorMessage } from "../../../components/ErrorMessage/ErrorMessage.js";
import { SectionHeader, TextTooltip, UsageTooltip } from "../../../components/PageHeader/PageHeader.js";
import { cardGridStyle } from "../../../components/CollapsibleCard/CollapsibleCard.js";
import { TranslationDebugView } from "../../../components/TranslationDebugView/TranslationDebugView.js";
import { stepProgress, TranslationProgress } from "../../../components/TranslationProgress/TranslationProgress.js";

/** `visible` reloads the settings each time the tab is shown, so a model saved in Translation settings appears here. */
export function SandboxTab({ visible = true }: { visible?: boolean | undefined }): ReactNode {
  const [settings, setSettings] = useState<TranslationSettingsResponse | null>(null);
  const [sourceText, setSourceText] = useState("");
  const [instructions, setInstructions] = useState("");
  const [targetLocale, setTargetLocale] = useState("");
  const [model, setModel] = useState("");
  const [output, setOutput] = useState("");
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<TranslationProgressState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<TranslationDebugTrace | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [usage, setUsage] = useState<TranslationUsage | undefined>(undefined);
  const outputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    pluginRequest<TranslationSettingsResponse>("settings/translation")
      .then((value) => {
        if (!active) return;
        setSettings(value);
        setTargetLocale((current) => {
          const locale = value.locales.find((item) => item.locale === current) ?? value.locales[0];
          setModel(locale?.model ?? value.model ?? locale?.defaultModel ?? "");
          return locale?.locale ?? "";
        });
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [visible]);

  useEffect(() => {
    if (output.length > 0) outputRef.current?.focus();
  }, [output]);

  async function translate(): Promise<void> {
    if (settings === null) return;
    setWorking(true);
    setError(null);
    setDebug(null);
    setOutput("");
    setCopyStatus(null);
    setElapsedMs(null);
    setProgress(stepProgress(SANDBOX_STEPS, 0, "Translating text"));
    const startedAt = performance.now();
    try {
      const result = await pluginRequest<TranslationSandboxResponse>("translation-sandbox", {
        method: "POST",
        body: JSON.stringify({ targetLocale, model, text: sourceText, instructions }),
      });
      if (result.debug !== undefined) setDebug(result.debug);
      if (result.translation === null) {
        setError(result.error);
      } else {
        setOutput(result.translation);
        setElapsedMs(performance.now() - startedAt);
        setUsage(result.usage);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
      setProgress(null);
    }
  }

  async function copyOutput(): Promise<void> {
    try {
      await navigator.clipboard.writeText(output);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Couldn't copy. Select the text and copy it instead.");
    }
  }

  if (settings === null && error === null) return <p style={sectionStyle}>Loading translation settings...</p>;

  const missingSetup =
    settings === null
      ? null
      : settings.locales.length === 0
        ? "target locales"
        : settings.allowedModels.length === 0
          ? "allowed models"
          : null;
  const tooLong = sourceText.length > MAX_SANDBOX_CHARACTERS;
  const characterCount = `${sourceText.length.toLocaleString()}/${MAX_SANDBOX_CHARACTERS.toLocaleString()} characters`;

  return (
    <section style={sectionStyle}>
      <SectionHeader
        title="Translation sandbox"
        description={
          <>
            Translates from the{" "}
            {settings === null ? "default locale" : <TextTooltip content={localeLabel(settings.defaultLocale)}>default locale</TextTooltip>}{" "}
            using the selected language's glossary and the additional instructions.
          </>
        }
      />
      {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
      {missingSetup === null ? null : (
        <Banner
          variant="secondary"
          title={`No ${missingSetup} to try`}
          description={
            <>
              The sandbox needs at least one target locale and one allowed model. Check{" "}
              <a href={pluginPageUrl("/settings", { tab: "translation" })}>Translation settings</a>.
            </>
          }
        />
      )}
      {settings === null || missingSetup !== null ? null : (
        <>
          <LayerCard style={{ ...cardStyle, ...stackStyle }}>
            <div style={rowStyle}>
              <div style={selectBoxStyle}>
                <Select
                  label="Target locale"
                  value={targetLocale}
                  renderValue={(value) => (typeof value === "string" ? localeLabel(value) : "")}
                  disabled={working}
                  onValueChange={(value) => {
                    if (typeof value === "string") {
                      const locale = settings.locales.find((item) => item.locale === value);
                      setTargetLocale(value);
                      setModel(locale?.model ?? settings.model ?? locale?.defaultModel ?? "");
                    }
                  }}
                >
                  {settings.locales.map((locale) => (
                    <Select.Option key={locale.locale} value={locale.locale}>
                      {localeLabel(locale.locale)}
                    </Select.Option>
                  ))}
                </Select>
              </div>
              <div style={selectBoxStyle}>
                <Select
                  label="Translation model"
                  value={model}
                  renderValue={(value) => (typeof value === "string" ? shortModelName(value) : "")}
                  disabled={working}
                  onValueChange={(value) => {
                    if (typeof value === "string") setModel(value);
                  }}
                >
                  {settings.allowedModels.map((allowedModel) => (
                    <Select.Option key={allowedModel} value={allowedModel}>
                      <span style={{ display: "grid" }}>
                        {shortModelName(allowedModel)}
                        {shortModelName(allowedModel) === allowedModel ? null : <small style={mutedStyle}>{allowedModel}</small>}
                      </span>
                    </Select.Option>
                  ))}
                </Select>
              </div>
            </div>
            <Textarea
              label="Additional instructions (optional)"
              placeholder="For example: Use a friendly, informal tone."
              rows={2}
              maxLength={MAX_JOB_INSTRUCTION_CHARACTERS}
              value={instructions}
              disabled={working}
              onValueChange={setInstructions}
            />
          </LayerCard>
          <div style={{ ...cardGridStyle, alignItems: "stretch" }}>
            <LayerCard style={cardStyle}>
              <div style={stackStyle}>
                <Textarea
                  label="Source text"
                  rows={8}
                  value={sourceText}
                  disabled={working}
                  onValueChange={setSourceText}
                  description={characterCount}
                  {...(tooLong ? { error: `${characterCount}. Shorten the text to translate it.` } : {})}
                />
                {progress === null ? null : <TranslationProgress {...progress} />}
                <div style={{ ...rowStyle, justifyContent: "flex-end" }}>
                  <Button
                    variant="primary"
                    loading={working}
                    disabled={sourceText.length === 0 || tooLong || targetLocale.length === 0 || model.length === 0}
                    onClick={() => void translate()}
                  >
                    {working ? "Translating…" : "Translate"}
                  </Button>
                </div>
              </div>
            </LayerCard>
            <LayerCard style={cardStyle}>
              <div style={stackStyle}>
                <Textarea
                  ref={outputRef}
                  label="Output"
                  rows={8}
                  value={output}
                  readOnly
                  description={`${output.length.toLocaleString()} characters`}
                />
                <div style={rowStyle}>
                  {elapsedMs === null || output.length === 0 ? null : (
                    <>
                      <Badge variant="success">Done</Badge>
                      <small style={mutedStyle}>
                        <UsageTooltip usage={usage}>{translatedIn(elapsedMs)}</UsageTooltip>
                      </small>
                    </>
                  )}
                  <small role="status" style={{ ...mutedStyle, marginInlineStart: "auto" }}>
                    {copyStatus}
                  </small>
                  <Button variant="secondary" disabled={output.length === 0} onClick={() => void copyOutput()}>
                    Copy
                  </Button>
                </div>
              </div>
            </LayerCard>
          </div>
          {debug === null ? null : <TranslationDebugView trace={debug} onDismiss={() => setDebug(null)} />}
        </>
      )}
    </section>
  );
}

// One step: the Done badge beside the output marks the finish.
const SANDBOX_STEPS = ["Translating"];

const selectBoxStyle = { ...inputStyle, flex: "1 1 180px", minWidth: 0 };

export function translatedIn(milliseconds: number): string {
  if (milliseconds < 100) return "Translated in under 0.1 s";
  return `Translated in ${(milliseconds / 1000).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}
