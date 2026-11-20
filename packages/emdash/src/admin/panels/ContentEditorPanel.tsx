import {
  ApiResponseError,
  entryLockRefusal,
  fetchCollection,
  fetchTranslations,
  useCurrentUser,
  useNavigate,
  type ContentEditorPanelContext,
} from "@emdash-cms/admin";
import { Banner, Button, Checkbox } from "@cloudflare/kumo";
import { useEffect, useState, type ReactNode } from "react";

import { MAX_CONTENT_FIELDS, type CollectionPolicyResponse, type TranslationDebugTrace } from "../../contracts.js";
import { createTranslatedEntry, translateExistingEntry } from "../content-translation.js";
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
import { LocalePicker } from "../components/LocalePicker/LocalePicker.js";
import { TranslationDebugView } from "../components/TranslationDebugView/TranslationDebugView.js";
import { TranslationProgress } from "../components/TranslationProgress/TranslationProgress.js";
import { AiFlagStatus } from "./AiFlagStatus.js";

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
  const [warning, setWarning] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translationProgress, setTranslationProgress] = useState<TranslationProgressState | null>(null);
  const [debug, setDebug] = useState<TranslationDebugTrace | null>(null);
  const [existingLocales, setExistingLocales] = useState<string[]>([]);
  const [createLocales, setCreateLocales] = useState<string[]>([]);
  const [created, setCreated] = useState<Array<{ id: string; locale: string }>>([]);
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
        setCreateLocales([]);
        setCreated([]);
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
    setWarning(null);
    setDebug(null);
    try {
      const result = await translateExistingEntry({
        collection,
        entryId: entry.id,
        locale: targetLocale,
        fields: selected,
        onTranslating: () => setTranslationProgress({ percent: 45, label: "Translating selected fields" }),
        onPart: (part, partCount) =>
          setTranslationProgress({
            percent: 45 + Math.round((40 * part) / partCount),
            label: `Translating part ${part + 1} of ${partCount}`,
          }),
        onTranslated: (trace) => {
          if (trace !== undefined) setDebug(trace);
          setTranslationProgress({ percent: 85, label: "Saving translated fields" });
        },
      });
      if (result.entry === null) {
        setError(panelError(new Error(result.error)));
        return;
      }
      if (result.debug !== undefined && currentUser.data !== undefined && currentUser.data.role >= ADMIN_ROLE) {
        storeTranslationDebug(collection, entry.id, targetLocale, currentUser.data.id, result.debug);
      }
      // A reload would hide the warning, so the editor asks for one instead.
      if (result.flagWarning !== null) {
        setWarning(`${result.flagWarning} Reload the page to see the translated fields.`);
        return;
      }
      window.location.reload();
    } catch (cause) {
      setError(panelError(cause));
    } finally {
      setTranslating(false);
      setTranslationProgress(null);
    }
  }

  async function createTranslations(): Promise<void> {
    if (createLocales.length === 0) return;
    setTranslating(true);
    setError(null);
    setWarning(null);
    setDebug(null);
    setCreated([]);
    const failed: string[] = [];
    const unflagged: string[] = [];
    let flagWarning = "";
    let lastError = "";
    let lastCreated: { id: string; locale: string } | null = null;
    try {
      // One locale at a time keeps the progress readable and avoids provider rate limits.
      for (const [index, locale] of createLocales.entries()) {
        const step = (percent: number, label: string) =>
          setTranslationProgress({ percent: Math.round(((index + percent / 100) / createLocales.length) * 100), label });
        step(15, `Loading the latest saved entry for ${locale}`);
        try {
          const result = await createTranslatedEntry({
            collection,
            sourceEntryId: entry.id,
            sourceLocale: entry.locale ?? undefined,
            locale,
            fields: selected,
            onTranslating: () => step(45, `Translating selected fields into ${locale}`),
            onPart: (part, partCount) => step(45, `Translating part ${part + 1} of ${partCount} into ${locale}`),
            onTranslated: (trace) => {
              if (trace !== undefined) setDebug(trace);
              step(85, `Creating the ${locale} draft`);
            },
          });
          if (result.entry === null) throw new Error(result.error);
          const createdLocale = result.entry.locale ?? locale;
          if (result.debug !== undefined && currentUser.data !== undefined && currentUser.data.role >= ADMIN_ROLE) {
            storeTranslationDebug(collection, result.entry.id, createdLocale, currentUser.data.id, result.debug);
          }
          if (result.flagWarning !== null) {
            unflagged.push(createdLocale);
            flagWarning = result.flagWarning;
          }
          const draft = { id: result.entry.id, locale: createdLocale };
          lastCreated = draft;
          setCreated((current) => [...current, draft]);
          setExistingLocales((current) => [...current, locale.toLowerCase(), createdLocale.toLowerCase()]);
        } catch (cause) {
          failed.push(locale);
          lastError = panelErrorMessage(cause, locale);
        }
      }
      setCreateLocales(failed);
      if (unflagged.length > 0) setWarning(`${flagWarning} Affected locales: ${unflagged.join(", ")}.`);
      if (failed.length > 0) {
        setError(panelError(new Error(`${failed.length} of ${createLocales.length} drafts failed (${failed.join(", ")}): ${lastError}`)));
      } else if (createLocales.length === 1 && lastCreated !== null && unflagged.length === 0) {
        await navigate({
          to: "/content/$collection/$id",
          params: { collection, id: lastCreated.id },
          search: { locale: lastCreated.locale },
        });
      }
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
  const createdDrafts =
    created.length === 0 ? null : (
      <div style={stackStyle}>
        <small style={mutedStyle}>Created drafts:</small>
        <div style={rowStyle}>
          {created.map((draft) => (
            <Button
              key={draft.id}
              size="sm"
              variant="secondary"
              onClick={() =>
                void navigate({ to: "/content/$collection/$id", params: { collection, id: draft.id }, search: { locale: draft.locale } })
              }
            >
              Open {draft.locale}
            </Button>
          ))}
        </div>
      </div>
    );
  if (isSourceEntry && creatableLocales.length === 0) {
    return (
      <div style={stackStyle}>
        {createdDrafts}
        <small style={mutedStyle}>Every configured locale already has an entry. Open one from Translations to update it.</small>
      </div>
    );
  }
  const run = isSourceEntry ? createTranslations : translate;

  return (
    <div style={stackStyle}>
      {error === null ? null : <PanelErrorMessage error={error} onDismiss={() => setError(null)} onRetry={() => void run()} />}
      {warning === null ? null : (
        <Banner
          variant="alert"
          title="Translation saved without the AI-translated flag"
          description={warning}
          action={
            <Button size="sm" variant="secondary" onClick={() => setWarning(null)}>
              Dismiss
            </Button>
          }
        />
      )}
      {debug === null || currentUser.data === undefined || currentUser.data.role < ADMIN_ROLE ? null : (
        <TranslationDebugView trace={debug} onDismiss={() => setDebug(null)} />
      )}
      {isSourceEntry ? (
        <>
          <p style={mutedStyle}>Create translated drafts from the latest saved {policy.sourceLocale} values.</p>
          {createdDrafts}
          <LocalePicker
            legend="Untranslated locales"
            options={creatableLocales.map((locale) => ({ locale, label: locale }))}
            value={createLocales}
            disabled={translating}
            onChange={setCreateLocales}
          />
        </>
      ) : (
        <>
          <AiFlagStatus
            collection={collection}
            entryId={entry.id}
            savedAt={entry.updatedAt}
            fieldLabel={(slug) => schema.fields.find((field) => field.slug === slug)?.label ?? slug}
          />
          <p style={mutedStyle}>
            Translate the latest saved {policy.sourceLocale} values into this {targetLocale} draft.
          </p>
        </>
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
        disabled={selected.length === 0 || currentUser.data === undefined || (isSourceEntry && createLocales.length === 0)}
        onClick={() => void run()}
      >
        {isSourceEntry ? createButtonLabel(createLocales) : "Translate with PolyStella"}
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

function createButtonLabel(locales: readonly string[]): string {
  if (locales.length === 0) return "Select locales to translate";
  return locales.length === 1 ? `Create ${locales[0]} draft` : `Create ${locales.length} drafts`;
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
