import {
  ApiResponseError,
  apiFetch,
  fetchCollection,
  fetchCollections,
  parseApiResponse,
  type ContentEditorPanelContext,
  type ContentEditorPanelExtension,
  type ContentItem,
} from "@emdash-cms/admin";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import {
  MAX_CATALOG_KEYS,
  MAX_CONTENT_FIELDS,
  POLYSTELLA_API_BASE,
  type CatalogExportResponse,
  type CatalogGenerationResponse,
  type CatalogOverrideMutationResponse,
  type CatalogRuntimeMutationResponse,
  type CatalogViewResponse,
  type CollectionPolicyResponse,
  type CollectionSettingsResponse,
  type TranslateContentResponse,
} from "./contracts.js";

type CollectionSchema = Awaited<ReturnType<typeof fetchCollection>>;
type SchemaField = CollectionSchema["fields"][number];

interface SavedContentResponse {
  item: ContentItem;
  _rev?: string;
}

const pageStyle: CSSProperties = { margin: "0 auto", maxWidth: 1100, padding: 24 };
const cardStyle: CSSProperties = {
  border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
  borderRadius: 8,
  marginBlock: 16,
  padding: 16,
};
const stackStyle: CSSProperties = { display: "grid", gap: 12 };
const rowStyle: CSSProperties = { alignItems: "center", display: "flex", flexWrap: "wrap", gap: 12 };
const buttonStyle: CSSProperties = { cursor: "pointer", minHeight: 36, padding: "6px 12px" };
const inputStyle: CSSProperties = { boxSizing: "border-box", minHeight: 36, padding: "6px 8px", width: "100%" };
const mutedStyle: CSSProperties = { opacity: 0.7 };

export function PolystellaSettingsPage(): ReactNode {
  const [collections, setCollections] = useState<Awaited<ReturnType<typeof fetchCollections>>>([]);
  const [settings, setSettings] = useState<CollectionSettingsResponse | null>(null);
  const [enabled, setEnabled] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([fetchCollections(), pluginRequest<CollectionSettingsResponse>("settings/collections")])
      .then(([projectCollections, value]) => {
        if (!active) return;
        setCollections(projectCollections);
        setSettings(value);
        setEnabled(value.enabled);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const value = await pluginRequest<CollectionSettingsResponse>("settings/collections", {
        method: "PUT",
        body: JSON.stringify({ collections: enabled }),
      });
      setSettings(value);
      setEnabled(value.enabled);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  if (settings === null && error === null) return <Page title="PolyStella settings">Loading collections...</Page>;

  return (
    <Page title="PolyStella settings">
      <p style={mutedStyle}>Choose which deployment-allowlisted collections show PolyStella translation controls.</p>
      {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
      <fieldset style={cardStyle}>
        <legend>Enabled collections</legend>
        <div style={stackStyle}>
          {collections.map((collection) => {
            const configured = settings?.configured.includes(collection.slug) === true;
            return (
              <label key={collection.slug} style={rowStyle}>
                <input
                  type="checkbox"
                  checked={enabled.includes(collection.slug)}
                  disabled={!configured || saving}
                  onChange={(event) => {
                    setEnabled((current) =>
                      event.target.checked
                        ? [...new Set([...current, collection.slug])].sort()
                        : current.filter((value) => value !== collection.slug),
                    );
                  }}
                />
                <span>
                  {collection.label} <code>{collection.slug}</code>
                </span>
                {configured ? null : <small style={mutedStyle}>Not enabled by deployment policy</small>}
              </label>
            );
          })}
        </div>
      </fieldset>
      <button type="button" style={buttonStyle} disabled={saving || settings === null} onClick={() => void save()}>
        {saving ? "Saving..." : "Save collections"}
      </button>
      <p style={mutedStyle}>Model, glossary, and translation instructions remain in EmDash's generated plugin settings.</p>
    </Page>
  );
}

export function PolystellaPanel({ collection, entry, locale }: ContentEditorPanelContext): ReactNode {
  const targetLocale = locale ?? entry.locale;
  const [policy, setPolicy] = useState<CollectionPolicyResponse | null>(null);
  const [schema, setSchema] = useState<CollectionSchema | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);

  useEffect(() => {
    let active = true;
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
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [collection]);

  if (error !== null) return <ErrorMessage>{error}</ErrorMessage>;
  if (policy === null || schema === null) return <small style={mutedStyle}>Loading PolyStella...</small>;
  if (!policy.enabled || targetLocale === policy.sourceLocale) return null;

  const eligibleFields = schema.fields.filter((field) => fieldIsEligible(field, policy));

  async function translate(): Promise<void> {
    if (targetLocale === undefined || targetLocale === null || targetLocale.length === 0) {
      setError("The target locale is unavailable.");
      return;
    }
    if (
      !window.confirm(
        "PolyStella translates the latest saved values, replaces the selected fields, and reloads the editor. Unsaved changes will be lost. Continue?",
      )
    ) {
      return;
    }

    setTranslating(true);
    setError(null);
    try {
      const saved = await contentRequest<SavedContentResponse>(collection, entry.id, targetLocale);
      if (saved._rev === undefined) throw new Error("EmDash did not return a revision token; no fields were changed.");
      const result = await pluginRequest<TranslateContentResponse>("translate-content", {
        method: "POST",
        body: JSON.stringify({ collection, entryId: entry.id, targetLocale, fields: selected }),
      });
      await updateContent(collection, entry.id, targetLocale, result.patch, saved._rev);
      window.location.reload();
    } catch (cause) {
      setError(
        cause instanceof ApiResponseError && cause.status === 409
          ? "This entry changed while PolyStella was translating it. Reload and try again."
          : errorMessage(cause),
      );
    } finally {
      setTranslating(false);
    }
  }

  return (
    <div style={stackStyle}>
      <p style={mutedStyle}>
        Translate saved fields from {policy.sourceLocale} to {targetLocale}.
      </p>
      {schema.fields.map((field) => {
        const eligible = fieldIsEligible(field, policy);
        return (
          <label key={field.slug} style={rowStyle}>
            <input
              type="checkbox"
              checked={selected.includes(field.slug)}
              disabled={!eligible || translating || (!selected.includes(field.slug) && selected.length >= MAX_CONTENT_FIELDS)}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked ? [...new Set([...current, field.slug])] : current.filter((value) => value !== field.slug),
                )
              }
            />
            {field.label} <code>{field.slug}</code>
            {eligible ? null : <small style={mutedStyle}>Not available for translation</small>}
          </label>
        );
      })}
      <small style={mutedStyle}>
        {selected.length}/{MAX_CONTENT_FIELDS} fields selected
      </small>
      {eligibleFields.length === 0 ? <small>No supported fields are configured for this collection.</small> : null}
      <button type="button" style={buttonStyle} disabled={translating || selected.length === 0} onClick={() => void translate()}>
        {translating ? "Translating..." : "Translate with PolyStella"}
      </button>
    </div>
  );
}

export function CatalogPage(): ReactNode {
  const [catalog, setCatalog] = useState<CatalogViewResponse | null>(null);
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<string[]>([]);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadCatalog();
  }, []);

  async function loadCatalog(locale?: string): Promise<void> {
    setWorking(true);
    setError(null);
    try {
      const value = await pluginRequest<CatalogViewResponse>(
        `catalog${locale === undefined ? "" : `?locale=${encodeURIComponent(locale)}`}`,
      );
      applyCatalog(value);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  function applyCatalog(value: CatalogViewResponse): void {
    setCatalog(value);
    setDrafts(new Map(value.entries.map((entry) => [entry.key, entry.override ?? entry.deployed ?? ""])));
    setSelected([]);
    setTouched(new Set());
    setCleared(new Set());
  }

  async function generate(): Promise<void> {
    if (catalog === null) return;
    setWorking(true);
    setError(null);
    try {
      const result = await pluginRequest<CatalogGenerationResponse>("catalog/generate", {
        method: "POST",
        body: JSON.stringify({ locale: catalog.locale, keys: selected }),
      });
      setDrafts((current) => {
        const next = new Map(current);
        for (const [key, value] of Object.entries(result.translations)) next.set(key, value);
        return next;
      });
      setTouched((current) => new Set([...current, ...Object.keys(result.translations)]));
      setCleared((current) => {
        const next = new Set(current);
        for (const key of Object.keys(result.translations)) next.delete(key);
        return next;
      });
      if (result.tokenFailures.length > 0) {
        setError(`Placeholder validation failed for: ${result.tokenFailures.map((failure) => failure.key).join(", ")}`);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  async function save(): Promise<void> {
    if (catalog === null) return;
    setWorking(true);
    setError(null);
    try {
      for (const key of [...touched]) {
        const value = cleared.has(key) ? null : (drafts.get(key) ?? "");
        await pluginRequest<CatalogOverrideMutationResponse>("catalog/overrides", {
          method: "PUT",
          body: JSON.stringify({ locale: catalog.locale, overrides: { [key]: value } }),
        });
        setCatalog((current) =>
          current === null
            ? null
            : {
                ...current,
                entries: current.entries.map((entry) =>
                  entry.key === key
                    ? {
                        ...entry,
                        override: value,
                        state: value === null ? null : entry.deployed === null ? "missing" : value === entry.deployed ? "synced" : "active",
                      }
                    : entry,
                ),
              },
        );
        setTouched((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
        setCleared((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  async function setRuntimeEnabled(enabled: boolean): Promise<void> {
    if (catalog === null) return;
    setWorking(true);
    setError(null);
    try {
      const result = await pluginRequest<CatalogRuntimeMutationResponse>("catalog/runtime", {
        method: "PUT",
        body: JSON.stringify({ locale: catalog.locale, enabled }),
      });
      setCatalog((current) =>
        current === null
          ? null
          : {
              ...current,
              locales: current.locales.map((item) => (item.locale === result.locale ? { ...item, runtimeEnabled: result.enabled } : item)),
            },
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  async function exportJson(): Promise<void> {
    if (catalog === null) return;
    setWorking(true);
    setError(null);
    try {
      const result = await pluginRequest<CatalogExportResponse>(`catalog/export?locale=${encodeURIComponent(catalog.locale)}`);
      const url = URL.createObjectURL(new Blob([result.json], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  if (catalog === null && error === null) return <Page title="PolyStella catalog">Loading catalog...</Page>;
  const localeSummary = catalog?.locales.find((item) => item.locale === catalog.locale);

  return (
    <Page title="PolyStella catalog">
      {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
      {catalog === null ? null : (
        <>
          <div style={rowStyle}>
            <label>
              Locale{" "}
              <select
                disabled={working || touched.size > 0}
                value={catalog.locale}
                onChange={(event) => void loadCatalog(event.target.value)}
              >
                {catalog.locales.map((item) => (
                  <option key={item.locale} value={item.locale}>
                    {item.locale}
                  </option>
                ))}
              </select>
            </label>
            <label style={rowStyle}>
              <input
                type="checkbox"
                checked={localeSummary?.runtimeEnabled === true}
                disabled={working || touched.size > 0}
                onChange={(event) => void setRuntimeEnabled(event.target.checked)}
              />
              Apply temporary overrides at runtime
            </label>
          </div>
          {localeSummary?.runtimeEnabled === true &&
          !catalog.entries.some((entry) => entry.state === "active" || entry.state === "missing") ? (
            <p>All stored overrides are synced. Runtime overrides can be disabled.</p>
          ) : null}
          <p style={mutedStyle}>Repository file: {localeSummary?.filePath}</p>
          <div style={rowStyle}>
            <button
              type="button"
              style={buttonStyle}
              disabled={working || selected.length === 0 || catalog.locale === catalog.defaultLocale}
              onClick={() => void generate()}
            >
              Generate selected
            </button>
            <button type="button" style={buttonStyle} disabled={working || touched.size === 0} onClick={() => void save()}>
              Save changes
            </button>
            <button type="button" style={buttonStyle} disabled={working || touched.size > 0} onClick={() => void exportJson()}>
              Export JSON
            </button>
            <small style={mutedStyle}>
              {selected.length}/{MAX_CATALOG_KEYS} keys selected
            </small>
          </div>
          <div style={{ ...stackStyle, marginTop: 16 }}>
            {catalog.entries.map((entry) => (
              <article key={entry.key} style={cardStyle}>
                <div style={rowStyle}>
                  <input
                    aria-label={`Select ${entry.key}`}
                    type="checkbox"
                    checked={selected.includes(entry.key)}
                    disabled={
                      working ||
                      entry.source === null ||
                      entry.source.length === 0 ||
                      (!selected.includes(entry.key) && selected.length >= MAX_CATALOG_KEYS)
                    }
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked ? [...new Set([...current, entry.key])] : current.filter((key) => key !== entry.key),
                      )
                    }
                  />
                  <strong>{entry.key}</strong>
                  {entry.state === null ? null : <small>{entry.state}</small>}
                </div>
                <p style={mutedStyle}>Source: {entry.source ?? "Missing"}</p>
                <p style={mutedStyle}>Deployed: {entry.deployed ?? "Missing"}</p>
                <label>
                  Override
                  <input
                    style={inputStyle}
                    value={drafts.get(entry.key) ?? ""}
                    disabled={working}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDrafts((current) => new Map(current).set(entry.key, value));
                      setTouched((current) => new Set(current).add(entry.key));
                      setCleared((current) => {
                        const next = new Set(current);
                        next.delete(entry.key);
                        return next;
                      });
                    }}
                  />
                </label>
                <button
                  type="button"
                  style={{ ...buttonStyle, marginTop: 8 }}
                  disabled={working || (entry.override === null && !touched.has(entry.key))}
                  onClick={() => {
                    setDrafts((current) => new Map(current).set(entry.key, entry.deployed ?? ""));
                    setTouched((current) => new Set(current).add(entry.key));
                    setCleared((current) => new Set(current).add(entry.key));
                  }}
                >
                  Clear override
                </button>
              </article>
            ))}
          </div>
        </>
      )}
    </Page>
  );
}

export const pages = {
  "/catalog": CatalogPage,
  "/settings": PolystellaSettingsPage,
};

export const contentEditorPanels = [
  {
    id: "polystella",
    title: "PolyStella",
    component: PolystellaPanel,
    minRole: 40,
  },
] satisfies readonly ContentEditorPanelExtension[];

function Page({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <main style={pageStyle}>
      <h1>{title}</h1>
      {children}
    </main>
  );
}

function ErrorMessage({ children }: { children: ReactNode }): ReactNode {
  return (
    <p role="alert" style={{ ...cardStyle, borderColor: "currentColor" }}>
      {children}
    </p>
  );
}

function supportsTranslation(field: SchemaField): boolean {
  return field.type === "string" || field.type === "text" || field.type === "portableText";
}

function isTranslatable(field: SchemaField): boolean {
  return !("translatable" in field) || field.translatable !== false;
}

function fieldIsEligible(field: SchemaField, policy: CollectionPolicyResponse): boolean {
  return policy.fields.includes(field.slug) && supportsTranslation(field) && isTranslatable(field);
}

async function pluginRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`${POLYSTELLA_API_BASE}/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  return parseApiResponse<T>(response, "PolyStella request failed");
}

async function contentRequest<T>(collection: string, id: string, locale: string): Promise<T> {
  const response = await apiFetch(
    `/_emdash/api/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}?locale=${encodeURIComponent(locale)}`,
  );
  return parseApiResponse<T>(response, "Could not load the latest saved entry");
}

async function updateContent(
  collection: string,
  id: string,
  locale: string,
  data: Record<string, unknown>,
  revision: string,
): Promise<void> {
  const response = await apiFetch(
    `/_emdash/api/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}?locale=${encodeURIComponent(locale)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data, _rev: revision }),
    },
  );
  await parseApiResponse(response, "Could not update the saved entry");
}

function errorMessage(value: unknown): string {
  if (value instanceof ApiResponseError && value.status === 403) return "Administrator access is required.";
  return value instanceof Error ? value.message : "An unexpected error occurred.";
}
