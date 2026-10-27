import {
  ApiResponseError,
  createContent,
  entryLockRefusal,
  fetchCollection,
  fetchContent,
  fetchTranslations,
  updateContent,
  useCurrentUser,
  useNavigate,
  type ContentEditorPanelContext,
} from "@emdash-cms/admin";
import { Banner, Button, Checkbox, Select } from "@cloudflare/kumo";
import { useEffect, useState, type ReactNode } from "react";

import {
  MAX_CONTENT_FIELDS,
  type CollectionPolicyResponse,
  type TranslateContentResponse,
  type TranslationDebugTrace,
} from "../../contracts.js";
import {
  errorMessage,
  formatErrorDetails,
  isTranslatable,
  pluginRequest,
  removeTranslationDebug,
  storeTranslationDebug,
  supportsTranslation,
  takeTranslationDebug,
} from "../utils.js";
import type { CollectionSchema, SchemaField, TranslationProgressState } from "../types.js";
import { codeStyle, mutedStyle, rowStyle, stackStyle } from "../styles.js";
import { TranslationDebugView } from "../components/TranslationDebugView/TranslationDebugView.js";
import { TranslationProgress } from "../components/TranslationProgress/TranslationProgress.js";

const ADMIN_ROLE = 50;

interface PanelError {
  message: string;
  details: string;
}

export function ContentEditorPanel({ collection, entry, locale }: ContentEditorPanelContext): ReactNode {
  const targetLocale = locale ?? entry.locale;
  const currentUser = useCurrentUser();
  const [policy, setPolicy] = useState<CollectionPolicyResponse | null>(null);
  const [schema, setSchema] = useState<CollectionSchema | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<PanelError | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translationProgress, setTranslationProgress] = useState<TranslationProgressState | null>(null);
  const [debug, setDebug] = useState<TranslationDebugTrace | null>(null);
  const [existingLocales, setExistingLocales] = useState<string[]>([]);
  const [createLocale, setCreateLocale] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    if (targetLocale === undefined || targetLocale === null || targetLocale.length === 0 || currentUser.data === undefined) return;
    if (currentUser.data.role < ADMIN_ROLE) {
      removeTranslationDebug(collection, entry.id, targetLocale, currentUser.data.id);
      setDebug(null);
      return;
    }
    setDebug(takeTranslationDebug(collection, entry.id, targetLocale, currentUser.data.id));
  }, [collection, currentUser.data, entry.id, targetLocale]);

  useEffect(() => {
    let active = true;
    setPolicy(null);
    setSchema(null);
    setSelected([]);
    setError(null);
    setHidden(false);
    Promise.all([
      pluginRequest<CollectionPolicyResponse>(`policy?collection=${encodeURIComponent(collection)}`),
      fetchCollection(collection, true),
      fetchTranslations(collection, entry.id),
    ])
      .then(([nextPolicy, nextSchema, translations]) => {
        if (!active) return;
        const existing = translations.translations.map((translation) => translation.locale.toLowerCase());
        setExistingLocales(existing);
        setCreateLocale(missingLocales(nextPolicy, existing)[0] ?? "");
        setPolicy(nextPolicy);
        setSchema(nextSchema);
        setSelected(
          nextSchema.fields
            .filter((field) => nextPolicy.fields.includes(field.slug) && supportsTranslation(field) && isTranslatable(field))
            .map((field) => field.slug)
            .slice(0, MAX_CONTENT_FIELDS),
        );
      })
      .catch((cause: unknown) => {
        if (active) setError(panelError(cause));
      });
    return () => {
      active = false;
    };
  }, [collection, entry.id, loadAttempt]);

  const eligibleFields = policy === null || schema === null ? [] : schema.fields.filter((field) => fieldIsEligible(field, policy));

  async function translate(): Promise<void> {
    if (targetLocale === undefined || targetLocale === null || targetLocale.length === 0) {
      setError(panelError(new Error("The target locale is unavailable.")));
      return;
    }
    if (
      !window.confirm(
        `PolyStella translates the latest saved ${policy?.sourceLocale ?? "source"} values into this ${targetLocale} draft, replaces the selected fields, and reloads the editor. Unsaved changes will be lost. Continue?`,
      )
    ) {
      return;
    }

    setTranslating(true);
    setTranslationProgress({ percent: 15, label: "Loading the latest saved entry" });
    setError(null);
    setDebug(null);
    try {
      const saved = await fetchContent(collection, entry.id, { locale: targetLocale });
      if (saved._rev === undefined) throw new Error("EmDash did not return a revision token; no fields were changed.");
      setTranslationProgress({ percent: 45, label: "Translating selected fields" });
      const result = await pluginRequest<TranslateContentResponse>("translate-content", {
        method: "POST",
        body: JSON.stringify({ collection, entryId: entry.id, targetLocale, fields: selected }),
      });
      if (result.debug !== undefined) setDebug(result.debug);
      if (result.patch === null) {
        setError(panelError(new Error(result.error)));
        return;
      }
      setTranslationProgress({ percent: 85, label: "Saving translated fields" });
      await updateContent(collection, entry.id, { data: result.patch, _rev: saved._rev }, { locale: targetLocale });
      if (result.debug !== undefined && currentUser.data !== undefined && currentUser.data.role >= ADMIN_ROLE) {
        storeTranslationDebug(collection, entry.id, targetLocale, currentUser.data.id, result.debug);
      }
      window.location.reload();
    } catch (cause) {
      setError(panelError(cause));
    } finally {
      setTranslating(false);
      setTranslationProgress(null);
    }
  }

  async function createTranslation(): Promise<void> {
    if (createLocale.length === 0) return;
    setTranslating(true);
    setTranslationProgress({ percent: 15, label: "Loading the latest saved entry" });
    setError(null);
    setDebug(null);
    try {
      const source = await fetchContent(collection, entry.id, { locale: entry.locale ?? undefined });
      setTranslationProgress({ percent: 45, label: `Translating selected fields into ${createLocale}` });
      const result = await pluginRequest<TranslateContentResponse>("translate-content", {
        method: "POST",
        body: JSON.stringify({ collection, entryId: entry.id, targetLocale: createLocale, fields: selected }),
      });
      if (result.debug !== undefined) setDebug(result.debug);
      if (result.patch === null) {
        setError(panelError(new Error(result.error)));
        return;
      }
      setTranslationProgress({ percent: 85, label: `Creating the ${createLocale} draft` });
      // Same payload as EmDash's own "Create translation" button, with the selected fields translated.
      const created = await createContent(collection, {
        data: { ...source.data, ...result.patch },
        slug: source.slug,
        locale: createLocale,
        translationOf: entry.id,
      });
      const createdLocale = created.locale ?? createLocale;
      if (result.debug !== undefined && currentUser.data !== undefined && currentUser.data.role >= ADMIN_ROLE) {
        storeTranslationDebug(collection, created.id, createdLocale, currentUser.data.id, result.debug);
      }
      await navigate({ to: "/content/$collection/$id", params: { collection, id: created.id }, search: { locale: createdLocale } });
    } catch (cause) {
      setError(panelError(cause, createLocale));
    } finally {
      setTranslating(false);
      setTranslationProgress(null);
    }
  }

  if (hidden) return null;
  if (policy === null || schema === null) {
    return error === null ? (
      <small style={mutedStyle}>Loading PolyStella...</small>
    ) : (
      <PanelErrorMessage error={error} onDismiss={() => setHidden(true)} onRetry={() => setLoadAttempt((current) => current + 1)} />
    );
  }
  // EmDash always renders the section header, so explain an empty panel instead of hiding it.
  if (!policy.enabled) {
    const isAdmin = currentUser.data !== undefined && currentUser.data.role >= ADMIN_ROLE;
    return (
      <div style={stackStyle}>
        <small style={mutedStyle}>
          PolyStella isn't enabled for this collection.{" "}
          {isAdmin ? "Enable it and choose its fields in the PolyStella Collections tab." : "Ask an administrator to enable it."}
        </small>
        {isAdmin ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void navigate({ to: "/plugins/$pluginId/$", params: { pluginId: "polystella", _splat: "" } })}
          >
            Open PolyStella settings
          </Button>
        ) : null}
      </div>
    );
  }
  const isSourceEntry = targetLocale?.toLowerCase() === policy.sourceLocale?.toLowerCase();
  const creatableLocales = missingLocales(policy, existingLocales);
  if (isSourceEntry && creatableLocales.length === 0) {
    return <small style={mutedStyle}>Every configured locale already has an entry. Open one from Translations to update it.</small>;
  }
  const run = isSourceEntry ? createTranslation : translate;

  return (
    <div style={stackStyle}>
      {error === null ? null : <PanelErrorMessage error={error} onDismiss={() => setError(null)} onRetry={() => void run()} />}
      {debug === null || currentUser.data === undefined || currentUser.data.role < ADMIN_ROLE ? null : (
        <TranslationDebugView trace={debug} onDismiss={() => setDebug(null)} />
      )}
      {isSourceEntry ? (
        <>
          <p style={mutedStyle}>Create a translated draft from the latest saved {policy.sourceLocale} values.</p>
          <Select
            label="New locale"
            value={createLocale}
            disabled={translating}
            onValueChange={(value) => {
              if (typeof value === "string") setCreateLocale(value);
            }}
          >
            {creatableLocales.map((locale) => (
              <Select.Option key={locale} value={locale}>
                {locale}
              </Select.Option>
            ))}
          </Select>
        </>
      ) : (
        <p style={mutedStyle}>
          Translate the latest saved {policy.sourceLocale} values into this {targetLocale} draft.
        </p>
      )}
      {eligibleFields.map((field) => (
        <Checkbox
          key={field.slug}
          label={`${field.label} (${field.slug})`}
          checked={selected.includes(field.slug)}
          disabled={translating || (!selected.includes(field.slug) && selected.length >= MAX_CONTENT_FIELDS)}
          onCheckedChange={(checked) =>
            setSelected((current) => (checked ? [...new Set([...current, field.slug])] : current.filter((value) => value !== field.slug)))
          }
        />
      ))}
      {eligibleFields.length === 0 ? <small>No supported fields are configured for this collection.</small> : null}
      {translationProgress === null ? null : <TranslationProgress {...translationProgress} />}
      <Button
        variant="primary"
        loading={translating}
        disabled={selected.length === 0 || currentUser.data === undefined}
        onClick={() => void run()}
      >
        {isSourceEntry ? `Create ${createLocale} draft` : "Translate with PolyStella"}
      </Button>
    </div>
  );
}

function PanelErrorMessage({ error, onDismiss, onRetry }: { error: PanelError; onDismiss(): void; onRetry(): void }): ReactNode {
  return (
    <Banner
      variant="error"
      title="PolyStella couldn't complete that request"
      description={
        <div style={stackStyle}>
          <span>{error.message}</span>
          <details>
            <summary>Show error details</summary>
            <pre style={codeStyle}>{error.details}</pre>
          </details>
        </div>
      }
      action={
        <div style={rowStyle}>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      }
    />
  );
}

function fieldIsEligible(field: SchemaField, policy: CollectionPolicyResponse): boolean {
  return policy.fields.includes(field.slug) && supportsTranslation(field) && isTranslatable(field);
}

function missingLocales(policy: CollectionPolicyResponse, existingLocales: readonly string[]): string[] {
  return policy.targetLocales
    .filter(({ locale, code }) => !existingLocales.includes(locale.toLowerCase()) && !existingLocales.includes(code.toLowerCase()))
    .map(({ locale }) => locale);
}

export function panelErrorMessage(value: unknown, createdLocale?: string | undefined): string {
  if (createdLocale !== undefined && value instanceof ApiResponseError && value.code === "CONFLICT") {
    return `A ${createdLocale} translation already exists. Open it from Translations instead.`;
  }
  const lock = entryLockRefusal(value);
  if (lock !== null) {
    return `${lock.userName ?? "Another editor"} is editing this entry, so PolyStella didn't save the translation. Retry after they finish.`;
  }
  if (value instanceof ApiResponseError && value.status === 409) {
    return "This entry changed while PolyStella was translating it. Retry the translation.";
  }
  return errorMessage(value);
}

function panelError(value: unknown, createdLocale?: string | undefined): PanelError {
  return { message: panelErrorMessage(value, createdLocale), details: formatErrorDetails(value) };
}
