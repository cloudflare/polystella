import {
  ApiResponseError,
  entryLockRefusal,
  fetchCollection,
  fetchContent,
  updateContent,
  useCurrentUser,
  type ContentEditorPanelContext,
} from "@emdash-cms/admin";
import { Banner, Button, Checkbox } from "@cloudflare/kumo";
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
    ])
      .then(([nextPolicy, nextSchema]) => {
        if (!active) return;
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
  }, [collection, loadAttempt]);

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

  if (hidden) return null;
  if (policy === null || schema === null) {
    return error === null ? (
      <small style={mutedStyle}>Loading PolyStella...</small>
    ) : (
      <PanelErrorMessage error={error} onDismiss={() => setHidden(true)} onRetry={() => setLoadAttempt((current) => current + 1)} />
    );
  }
  if (!policy.enabled || targetLocale === policy.sourceLocale) return null;

  return (
    <div style={stackStyle}>
      {error === null ? null : <PanelErrorMessage error={error} onDismiss={() => setError(null)} onRetry={() => void translate()} />}
      {debug === null || currentUser.data === undefined || currentUser.data.role < ADMIN_ROLE ? null : (
        <TranslationDebugView trace={debug} onDismiss={() => setDebug(null)} />
      )}
      <p style={mutedStyle}>
        Translate the latest saved {policy.sourceLocale} values into this {targetLocale} draft.
      </p>
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
        onClick={() => void translate()}
      >
        Translate with PolyStella
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

export function panelErrorMessage(value: unknown): string {
  const lock = entryLockRefusal(value);
  if (lock !== null) {
    return `${lock.userName ?? "Another editor"} is editing this entry, so PolyStella didn't save the translation. Retry after they finish.`;
  }
  if (value instanceof ApiResponseError && value.status === 409) {
    return "This entry changed while PolyStella was translating it. Retry the translation.";
  }
  return errorMessage(value);
}

function panelError(value: unknown): PanelError {
  return { message: panelErrorMessage(value), details: formatErrorDetails(value) };
}
