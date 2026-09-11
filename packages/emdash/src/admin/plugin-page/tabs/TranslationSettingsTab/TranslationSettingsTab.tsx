import { Button, LayerCard, Select, Switch, Textarea } from "@cloudflare/kumo";
import { useEffect, useState, type ReactNode } from "react";

import {
  USE_CODE_DEFAULT_MODEL,
  type CustomizationMode,
  type TranslationLocaleSettings,
  type TranslationSettingsResponse,
} from "../../../../contracts.js";
import { errorMessage, pluginRequest } from "../../../utils.js";
import { cardStyle, codeStyle, mutedStyle, sectionStyle, stackStyle } from "../../../styles.js";
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
          debugEnabled: settings.debugEnabled,
          locales: Object.fromEntries(
            settings.locales.map((locale) => [
              locale.locale,
              { model: locale.model, glossaryMode: locale.glossaryMode, glossaryText: locale.glossaryText },
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
      {settings?.locales.map((locale) => (
        <LayerCard key={locale.locale}>
          <details>
            <summary style={{ cursor: "pointer", padding: 20 }}>
              <strong>{locale.locale}</strong>
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
                    updateLocale(locale.locale, { model: value === USE_CODE_DEFAULT_MODEL ? null : value });
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
              <Textarea
                label="Custom glossary"
                description="Plain text appended to or used instead of the code-defined glossary."
                rows={5}
                value={locale.glossaryText}
                disabled={working || locale.glossaryMode === "default"}
                onValueChange={(glossaryText) => updateLocale(locale.locale, { glossaryText })}
              />
              <details>
                <summary>View code-defined glossary</summary>
                <pre style={codeStyle}>{locale.defaultGlossary || "No code-defined glossary."}</pre>
              </details>
            </div>
          </details>
        </LayerCard>
      ))}
      {settings === null ? null : (
        <LayerCard style={cardStyle}>
          <div style={stackStyle}>
            <Switch
              label="Debug mode"
              checked={settings.debugEnabled}
              disabled={working}
              onCheckedChange={(debugEnabled) => setSettings((current) => (current === null ? null : { ...current, debugEnabled }))}
            />
            <small style={mutedStyle}>
              Administrators receive request-scoped prompts, normalized model responses, and batch diagnostics. Debug traces are not stored
              on the server.
            </small>
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
            <Textarea
              label="Custom instructions"
              rows={5}
              value={settings.instructions.text}
              disabled={working || settings.instructions.mode === "default"}
              onValueChange={(text) =>
                setSettings((current) => (current === null ? null : { ...current, instructions: { ...current.instructions, text } }))
              }
            />
            <details>
              <summary>View code-defined instructions</summary>
              <pre style={codeStyle}>{settings.instructions.defaultText || "No code-defined instructions."}</pre>
            </details>
          </div>
        </LayerCard>
      )}
      <div>
        <Button variant="primary" loading={working} disabled={settings === null} onClick={() => void save()}>
          Save translation settings
        </Button>
      </div>
    </section>
  );
}

function isCustomizationMode(value: unknown): value is CustomizationMode {
  return value === "default" || value === "append" || value === "replace";
}
