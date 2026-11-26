import {
  ApiResponseError,
  entryLockRefusal,
  fetchCollection,
  fetchTranslations,
  useCurrentUser,
  useNavigate,
  type ContentEditorDraft,
  type ContentEditorPanelContext,
} from "@emdash-cms/admin";
import { Banner, Button, Checkbox } from "@cloudflare/kumo";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { isSeoField, MAX_CONTENT_FIELDS, type CollectionPolicyResponse, type TranslationDebugTrace } from "../../contracts.js";
import { createTranslatedEntry, translateExistingEntry, translateIntoDraft, type DraftTranslationResult } from "../content-translation.js";
import {
  errorMessage,
  formatErrorDetails,
  isPolicyField,
  localeLabel,
  plural,
  pluginPageUrl,
  pluginRequest,
  removeTranslationDebug,
  storeTranslationDebug,
  takeTranslationDebug,
} from "../utils.js";
import type { CollectionSchema, TranslationProgressState } from "../types.js";
import { codeStyle, mutedStyle, rowStyle, stackStyle } from "../styles.js";
import { LocalePicker } from "../components/LocalePicker/LocalePicker.js";
import { NewWindowLink } from "../components/NewWindowLink/NewWindowLink.js";
import { TranslationDebugView } from "../components/TranslationDebugView/TranslationDebugView.js";
import { TranslationProgress } from "../components/TranslationProgress/TranslationProgress.js";
import { AiFlagStatus } from "./AiFlagStatus.js";

const ADMIN_ROLE = 50;

interface PanelError {
  message: string;
  /** One line per locale when several drafts failed. */
  items?: string[] | undefined;
  details: string;
}

interface PanelWarning {
  lines: string[];
  /** The editor shows saved values only after a reload. */
  reload: boolean;
}

/** EmDash 1.5+ hides the section until this is true. A failed policy read still shows the panel, so it can show the error. */
export function panelIsVisible({ collection }: ContentEditorPanelContext): Promise<boolean> {
  return pluginRequest<CollectionPolicyResponse>(`policy?collection=${encodeURIComponent(collection)}`).then(
    (policy) => policy.enabled,
    () => true,
  );
}

export function ContentEditorPanel({ collection, entry, locale, editorDraft }: ContentEditorPanelContext): ReactNode {
  const targetLocale = locale ?? entry.locale;
  // `editorDraft` is EmDash 1.6+. Only SEO definitions are kept: `get()` copies every draft value.
  const seoFields = useMemo(
    () => editorDraft?.get().fieldDefinitions.filter((definition) => isSeoField(definition.slug)) ?? [],
    [editorDraft],
  );
  // EmDash saves patched SEO text at once, so on a published or scheduled entry it goes live unreviewed.
  const isLive = entry.status !== "draft";
  const currentUser = useCurrentUser();
  const [policy, setPolicy] = useState<CollectionPolicyResponse | null>(null);
  const [schema, setSchema] = useState<CollectionSchema | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<PanelError | null>(null);
  const [warning, setWarning] = useState<PanelWarning | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
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
        const translatesSource = targetLocale?.toLowerCase() === nextPolicy.sourceLocale?.toLowerCase();
        setSelected(
          [
            ...nextSchema.fields.filter((field) => isPolicyField(field, nextPolicy)).map((field) => field.slug),
            // Live SEO text is never preselected: a patch saves it at once.
            ...(translatesSource || isLive ? [] : seoFields.map((field) => field.slug)),
          ].slice(0, MAX_CONTENT_FIELDS),
        );
      })
      .catch((cause: unknown) => {
        if (active) setError(panelError(cause));
      });
    return () => {
      active = false;
    };
    // Only the initial selection reads `seoFields` and `isLive`; a status change mustn't reset what the user ticked.
  }, [collection, entry.id, loadAttempt]);

  const eligibleFields = policy === null || schema === null ? [] : schema.fields.filter((field) => isPolicyField(field, policy));
  const seoAllowed = !isLive || policy?.translateSeoWhenPublished === true;
  const fieldsToTranslate = selected.filter((field) => !isSeoField(field) || seoAllowed);

  async function translate(): Promise<void> {
    if (targetLocale === undefined || targetLocale === null || targetLocale.length === 0) {
      setError(panelError(new Error("The target locale is unavailable.")));
      return;
    }
    if (editorDraft !== undefined) {
      await translateDraft(editorDraft, targetLocale);
      return;
    }
    if (
      !window.confirm(
        `PolyStella translates the latest saved ${policy === null || policy.sourceLocale === null ? "source" : localeLabel(policy.sourceLocale)} values into this ${localeLabel(targetLocale)} draft, replaces the selected fields, and reloads the editor. Unsaved changes will be lost. Continue?`,
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
      const warning = [result.flagWarning, result.notice].filter((part) => part !== null).join(" ");
      if (warning !== "") {
        setWarning({ lines: [`${warning} Reload the page to see the translated fields.`], reload: true });
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

  async function translateDraft(draft: ContentEditorDraft, target: string): Promise<void> {
    setTranslating(true);
    setTranslationProgress({ percent: 15, label: "Reading the open draft" });
    setError(null);
    setWarning(null);
    setApplied(null);
    setDebug(null);
    try {
      const result = await translateIntoDraft({
        collection,
        entryId: entry.id,
        locale: target,
        fields: fieldsToTranslate,
        editorDraft: draft,
        onTranslating: () => setTranslationProgress({ percent: 45, label: "Translating selected fields" }),
        onPart: (part, partCount) =>
          setTranslationProgress({
            percent: 45 + Math.round((40 * part) / partCount),
            label: `Translating part ${part + 1} of ${partCount}`,
          }),
        onTranslated: (trace) => {
          if (trace !== undefined) setDebug(trace);
          setTranslationProgress({ percent: 85, label: "Putting the translation into the form" });
        },
      });
      if (result.status !== "applied") {
        setError(panelError(new Error(draftFailureMessage(result))));
        return;
      }
      const tooLong = result.tooLong.map((field) => seoFields.find((definition) => definition.slug === field)?.label ?? field);
      setApplied(
        [
          "The translation is in the form. Please review it.",
          ...(tooLong.length === 0 ? [] : [`Left out because the translation is too long: ${tooLong.join(", ")}.`]),
        ].join(" "),
      );
      const warning = [result.flagWarning, result.notice].filter((part) => part !== null).join(" ");
      if (warning !== "") setWarning({ lines: [warning], reload: false });
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
    const failures: Array<{ locale: string; cause: unknown }> = [];
    const warnings: string[] = [];
    let lastCreated: { id: string; locale: string } | null = null;
    try {
      // One locale at a time keeps the progress readable and avoids provider rate limits.
      for (const [index, locale] of createLocales.entries()) {
        const step = (percent: number, label: string) =>
          setTranslationProgress({ percent: Math.round(((index + percent / 100) / createLocales.length) * 100), label });
        const name = localeLabel(locale);
        step(15, `Loading the latest saved entry for ${name}`);
        try {
          const result = await createTranslatedEntry({
            collection,
            sourceEntryId: entry.id,
            sourceLocale: entry.locale ?? undefined,
            locale,
            fields: selected,
            onTranslating: () => step(45, `Translating selected fields into ${name}`),
            onPart: (part, partCount) => step(45, `Translating part ${part + 1} of ${partCount} into ${name}`),
            onTranslated: (trace) => {
              if (trace !== undefined) setDebug(trace);
              step(85, `Creating the ${name} draft`);
            },
          });
          if (result.entry === null) throw new Error(result.error);
          const createdLocale = result.entry.locale ?? locale;
          if (result.debug !== undefined && currentUser.data !== undefined && currentUser.data.role >= ADMIN_ROLE) {
            storeTranslationDebug(collection, result.entry.id, createdLocale, currentUser.data.id, result.debug);
          }
          const warning = [result.flagWarning, result.notice].filter((part) => part !== null).join(" ");
          if (warning !== "") warnings.push(`${localeLabel(createdLocale)}: ${warning}`);
          const draft = { id: result.entry.id, locale: createdLocale };
          lastCreated = draft;
          setCreated((current) => [...current, draft]);
          setExistingLocales((current) => [...current, locale.toLowerCase(), createdLocale.toLowerCase()]);
        } catch (cause) {
          failures.push({ locale, cause });
        }
      }
      setCreateLocales(failures.map(({ locale }) => locale));
      if (warnings.length > 0) setWarning({ lines: warnings, reload: false });
      if (failures.length > 0) {
        setError({
          message: `Couldn't create ${createFailureScope(failures.length, createLocales.length)}:`,
          items: failures.map(({ locale, cause }) => `${localeLabel(locale)}: ${panelErrorMessage(cause, localeLabel(locale))}`),
          details: failures.map(({ locale, cause }) => `${locale}\n${formatErrorDetails(cause)}`).join("\n\n"),
        });
      } else if (createLocales.length === 1 && lastCreated !== null && warnings.length === 0) {
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

  const isAdmin = currentUser.data !== undefined && currentUser.data.role >= ADMIN_ROLE;
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
    return (
      <div style={stackStyle}>
        <small style={mutedStyle}>
          PolyStella isn't enabled for this collection.{" "}
          {isAdmin
            ? "Enable it and choose its fields in PolyStella's Settings, on the Collections tab."
            : "Ask an administrator to enable it."}
        </small>
        {isAdmin ? <SettingsLink tab="collections" /> : null}
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
              Open {localeLabel(draft.locale)}
            </Button>
          ))}
        </div>
      </div>
    );
  // Shown even once every locale has an entry, so a warning about the last created draft isn't lost.
  const notices = (
    <>
      {warning === null ? null : (
        <Banner
          variant="alert"
          size="sm"
          title="Check this translation"
          description={<LinesList lines={warning.lines} />}
          action={
            <div style={rowStyle}>
              {warning.reload ? (
                <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
                  Reload
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setWarning(null)}>
                Dismiss
              </Button>
            </div>
          }
        />
      )}
      {debug === null || !isAdmin ? null : <TranslationDebugView trace={debug} onDismiss={() => setDebug(null)} />}
    </>
  );
  if (isSourceEntry && creatableLocales.length === 0) {
    return (
      <div style={stackStyle}>
        {notices}
        {createdDrafts}
        {policy.targetLocales.length === 0 ? (
          <>
            <small style={mutedStyle}>
              No translation languages are configured, so there's nothing to translate into.{" "}
              {isAdmin ? "Languages come from the site's PolyStella configuration." : "Ask an administrator to add one."}
            </small>
            {isAdmin ? <SettingsLink tab="translation" /> : null}
          </>
        ) : (
          <small style={mutedStyle}>Every configured locale already has an entry. Open one from Translations to update it.</small>
        )}
      </div>
    );
  }
  const run = isSourceEntry ? createTranslations : translate;
  const fieldOptions = [
    ...eligibleFields.map((field) => ({ slug: field.slug, label: `${field.label} (${field.slug})`, disabled: false })),
    ...(isSourceEntry ? [] : seoFields.map((field) => ({ slug: field.slug, label: field.label, disabled: !seoAllowed }))),
  ];

  return (
    <div style={stackStyle}>
      {error === null ? null : <PanelErrorMessage error={error} onDismiss={() => setError(null)} onRetry={() => void run()} />}
      {notices}
      {isSourceEntry ? (
        <>
          <p style={mutedStyle}>Create a translated draft from this entry.</p>
          {createdDrafts}
          <LocalePicker
            legend="Untranslated locales"
            placeholder="Choose languages"
            options={creatableLocales.map((locale) => ({ locale, label: localeLabel(locale) }))}
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
            Translate the latest saved {policy.sourceLocale === null ? "source" : localeLabel(policy.sourceLocale)} values into this{" "}
            {targetLocale === null || targetLocale === undefined ? "" : localeLabel(targetLocale)} {isLive ? "entry" : "draft"}. Please
            review the translation afterwards.
          </p>
        </>
      )}
      {applied === null ? null : (
        <p role="status" style={mutedStyle}>
          {applied}
        </p>
      )}
      {fieldOptions.length === 0 ? null : (
        <Checkbox.Group
          legend="Fields to translate"
          description={
            fieldOptions.length > MAX_CONTENT_FIELDS
              ? `${plural(fieldsToTranslate.length, "field")} selected. One translation takes up to ${MAX_CONTENT_FIELDS} fields, so the rest turn off at that limit.`
              : `${plural(fieldsToTranslate.length, "field")} selected.`
          }
          value={fieldsToTranslate}
          disabled={translating}
          onValueChange={setSelected}
        >
          {fieldOptions.map((option) => (
            <Checkbox.Item
              key={option.slug}
              value={option.slug}
              label={option.label}
              disabled={option.disabled || (!selected.includes(option.slug) && selected.length >= MAX_CONTENT_FIELDS)}
            />
          ))}
        </Checkbox.Group>
      )}
      {!isSourceEntry && seoFields.length > 0 && !seoAllowed ? (
        <details>
          <summary style={{ ...mutedStyle, cursor: "pointer" }}>
            <small>Note: SEO text is off for published and scheduled entries</small>
          </summary>
          <small style={mutedStyle}>
            SEO text changes would be applied automatically to the live site, even if changes were not published, so they're disabled by
            default. You can enable this in{" "}
            <NewWindowLink href={pluginPageUrl("/settings", { tab: "translation" })}>PolyStella settings</NewWindowLink>.
          </small>
        </details>
      ) : null}
      {fieldOptions.length === 0 ? (
        <>
          <small>
            No supported fields are configured for this collection.
            {isAdmin ? " Choose its fields in PolyStella's Settings, on the Collections tab." : " Ask an administrator to choose them."}
          </small>
          {isAdmin ? <SettingsLink tab="collections" /> : null}
        </>
      ) : null}
      {translationProgress === null ? null : <TranslationProgress {...translationProgress} />}
      <Button
        variant="primary"
        loading={translating}
        disabled={fieldsToTranslate.length === 0 || currentUser.data === undefined || (isSourceEntry && createLocales.length === 0)}
        onClick={() => void run()}
      >
        {isSourceEntry
          ? createButtonLabel(createLocales)
          : fieldsToTranslate.length === 0
            ? "Select fields to translate"
            : `Translate ${plural(fieldsToTranslate.length, "field")}`}
      </Button>
    </div>
  );
}

function PanelErrorMessage({ error, onDismiss, onRetry }: { error: PanelError; onDismiss(): void; onRetry(): void }): ReactNode {
  return (
    <Banner
      variant="error"
      size="sm"
      title="PolyStella couldn't complete that request"
      description={
        <div style={stackStyle}>
          <span>{error.message}</span>
          {error.items === undefined ? null : <LinesList lines={error.items} />}
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

function LinesList({ lines }: { lines: readonly string[] }): ReactNode {
  if (lines.length === 1) return <span>{lines[0]}</span>;
  return (
    <ul style={{ margin: 0, paddingInlineStart: 20 }}>
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function SettingsLink({ tab }: { tab: "translation" | "collections" }): ReactNode {
  return (
    <span>
      <NewWindowLink href={pluginPageUrl("/settings", { tab })}>Open PolyStella settings</NewWindowLink>
    </span>
  );
}

/** "the draft", "any of the 3 drafts", "2 of 3 drafts". */
function createFailureScope(failed: number, total: number): string {
  if (failed < total) return `${failed.toLocaleString()} of ${plural(total, "draft")}`;
  return total === 1 ? "the draft" : `any of the ${plural(total, "draft")}`;
}

function draftFailureMessage(result: Exclude<DraftTranslationResult, { status: "applied" }>): string {
  if (result.status === "failed") return result.error;
  switch (result.code) {
    case "EDITOR_DRAFT_STALE":
      return "The entry changed while PolyStella was translating it, so the form wasn't changed. Translate again.";
    case "EDITOR_DRAFT_READ_ONLY":
      return "This editor doesn't accept edits right now, so PolyStella didn't translate anything.";
    case "EDITOR_DRAFT_INVALID":
      return "EmDash couldn't put the translation into the form, so nothing changed.";
  }
}

function createButtonLabel(locales: readonly string[]): string {
  if (locales.length === 0) return "Select locales to translate";
  return locales.length === 1 && locales[0] !== undefined ? `Create ${localeLabel(locales[0])} draft` : `Create ${locales.length} drafts`;
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
