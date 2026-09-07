import {
  ApiResponseError,
  apiFetch,
  fetchCollection,
  fetchCollections,
  parseApiResponse,
  useCurrentUser,
  type ContentEditorPanelContext,
  type ContentEditorPanelExtension,
  type ContentItem,
} from "@emdash-cms/admin";
import { Badge, Banner, Button, Checkbox, LayerCard, Select, Switch, Table, Tabs, Textarea } from "@cloudflare/kumo";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import {
  MAX_CATALOG_KEYS,
  MAX_COLLECTION_POLICY_FIELDS,
  MAX_CONTENT_FIELDS,
  POLYSTELLA_API_BASE,
  USE_CODE_DEFAULT_MODEL,
  type CatalogExportResponse,
  type CatalogGenerationResponse,
  type CatalogEntryView,
  type CatalogOverrideMutationResponse,
  type CatalogRuntimeMutationResponse,
  type CatalogViewResponse,
  type CollectionPolicyResponse,
  type CollectionSettingsResponse,
  type CustomizationMode,
  type TranslationLocaleSettings,
  type TranslationDebugTrace,
  type TranslationSettingsResponse,
  type TranslateContentResponse,
} from "./contracts.js";

type CollectionSchema = Awaited<ReturnType<typeof fetchCollection>>;
type SchemaField = CollectionSchema["fields"][number];

interface SavedContentResponse {
  item: ContentItem;
  _rev?: string;
}

interface PanelError {
  message: string;
  details: string;
}

const pageStyle: CSSProperties = { margin: "0 auto", maxWidth: 1280, padding: "32px 24px 64px" };
const sectionStyle: CSSProperties = { display: "grid", gap: 20, marginTop: 24 };
const cardStyle: CSSProperties = { padding: 20 };
const stackStyle: CSSProperties = { display: "grid", gap: 12 };
const rowStyle: CSSProperties = { alignItems: "center", display: "flex", flexWrap: "wrap", gap: 12 };
const inputStyle: CSSProperties = { width: "100%" };
const mutedStyle: CSSProperties = { opacity: 0.7 };
const codeStyle: CSSProperties = { margin: 0, overflowX: "auto", whiteSpace: "pre-wrap" };
const ADMIN_ROLE = 50;

type AdminTab = "catalog" | "collections" | "translation";

export function PolystellaPage(): ReactNode {
  const [activeTab, setActiveTab] = useState<AdminTab>("catalog");
  return (
    <Page title="PolyStella">
      <p style={mutedStyle}>Manage temporary catalog overrides and translation behavior.</p>
      <Tabs
        variant="underline"
        tabs={[
          { value: "catalog", label: "Catalog" },
          { value: "collections", label: "Collections" },
          { value: "translation", label: "Translation settings" },
        ]}
        value={activeTab}
        onValueChange={(value) => {
          if (value === "catalog" || value === "collections" || value === "translation") setActiveTab(value);
        }}
      />
      <div hidden={activeTab !== "catalog"}>
        <CatalogTab />
      </div>
      <div hidden={activeTab !== "collections"}>
        <CollectionsTab />
      </div>
      <div hidden={activeTab !== "translation"}>
        <TranslationSettingsTab />
      </div>
    </Page>
  );
}

function CollectionsTab(): ReactNode {
  const [collections, setCollections] = useState<Awaited<ReturnType<typeof fetchCollections>>>([]);
  const [settings, setSettings] = useState<CollectionSettingsResponse | null>(null);
  const [policies, setPolicies] = useState<CollectionSettingsResponse["policies"]>({});
  const [schemas, setSchemas] = useState<Map<string, CollectionSchema>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([fetchCollections(), pluginRequest<CollectionSettingsResponse>("settings/collections")])
      .then(async ([projectCollections, value]) => {
        if (!active) return;
        const loadedSchemas = await Promise.all(
          projectCollections
            .filter((collection) => Object.hasOwn(value.policies, collection.slug))
            .map((collection) => fetchCollection(collection.slug, true)),
        );
        if (!active) return;
        const schemasBySlug = new Map(loadedSchemas.map((schema) => [schema.slug, schema]));
        const normalizedPolicies = Object.fromEntries(
          Object.entries(value.policies).flatMap(([collection, policy]) => {
            const schema = schemasBySlug.get(collection);
            if (schema === undefined) return [];
            const eligibleFields = new Set(
              schema.fields.filter((field) => supportsTranslation(field) && isTranslatable(field)).map((field) => field.slug),
            );
            const fields = policy.fields.filter((field) => eligibleFields.has(field));
            return fields.length === 0 ? [] : [[collection, { ...policy, fields }]];
          }),
        );
        setCollections(projectCollections);
        setSettings(value);
        setPolicies(normalizedPolicies);
        setSchemas(schemasBySlug);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  async function save(): Promise<void> {
    setWorking(true);
    setError(null);
    try {
      const value = await pluginRequest<CollectionSettingsResponse>("settings/collections", {
        method: "PUT",
        body: JSON.stringify({ policies }),
      });
      setSettings(value);
      setPolicies(value.policies);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  async function setCollectionEnabled(collection: string, enabled: boolean): Promise<void> {
    if (!enabled) {
      setPolicies((current) => Object.fromEntries(Object.entries(current).filter(([slug]) => slug !== collection)));
      return;
    }

    setWorking(true);
    setError(null);
    try {
      const schema = schemas.get(collection) ?? (await fetchCollection(collection, true));
      const fields = schema.fields
        .filter((field) => supportsTranslation(field) && isTranslatable(field))
        .map((field) => field.slug)
        .slice(0, MAX_COLLECTION_POLICY_FIELDS);
      if (fields.length === 0) throw new Error("This collection has no supported translatable fields.");
      setSchemas((current) => new Map(current).set(collection, schema));
      setPolicies((current) => ({
        ...current,
        [collection]: { sourceLocale: settings?.defaultLocale ?? "", fields },
      }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  function updateCollection(collection: string, sourceLocale: string | undefined, fields: string[] | undefined): void {
    setPolicies((current) => {
      const policy = Object.hasOwn(current, collection) ? current[collection] : undefined;
      if (policy === undefined) return current;
      if (fields?.length === 0) return Object.fromEntries(Object.entries(current).filter(([slug]) => slug !== collection));
      return {
        ...current,
        [collection]: {
          sourceLocale: sourceLocale ?? policy.sourceLocale,
          fields: fields ?? policy.fields,
        },
      };
    });
  }

  if (settings === null && error === null) return <p style={sectionStyle}>Loading collections...</p>;

  return (
    <section style={sectionStyle}>
      <div>
        <h2>Collections</h2>
        <p style={mutedStyle}>Choose where PolyStella appears and which saved fields editors may send for translation.</p>
      </div>
      {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
      {collections.map((collection) => {
        const policy = Object.hasOwn(policies, collection.slug) ? policies[collection.slug] : undefined;
        const schema = schemas.get(collection.slug);
        const eligibleFields = schema?.fields.filter((field) => supportsTranslation(field) && isTranslatable(field)) ?? [];
        return (
          <LayerCard key={collection.slug} style={cardStyle}>
            <div style={stackStyle}>
              <Switch
                label={
                  <span>
                    <strong>{collection.label}</strong> <code>{collection.slug}</code>
                  </span>
                }
                checked={policy !== undefined}
                disabled={working}
                onCheckedChange={(enabled) => void setCollectionEnabled(collection.slug, enabled)}
              />
              {policy === undefined ? null : schema === undefined ? (
                <span style={mutedStyle}>Loading fields...</span>
              ) : (
                <>
                  <Select
                    label="Source locale"
                    value={policy.sourceLocale}
                    disabled={working}
                    onValueChange={(value) => {
                      if (typeof value === "string") updateCollection(collection.slug, value, undefined);
                    }}
                  >
                    {settings?.locales.map((locale) => (
                      <Select.Option key={locale} value={locale}>
                        {locale}
                      </Select.Option>
                    ))}
                  </Select>
                  <Checkbox.Group
                    legend="Fields available for translation"
                    value={policy.fields}
                    allValues={eligibleFields.slice(0, MAX_COLLECTION_POLICY_FIELDS).map((field) => field.slug)}
                    disabled={working}
                    onValueChange={(fields) => updateCollection(collection.slug, undefined, fields)}
                  >
                    {eligibleFields.map((field) => (
                      <Checkbox.Item
                        key={field.slug}
                        value={field.slug}
                        label={`${field.label} (${field.slug})`}
                        disabled={policy.fields.length >= MAX_COLLECTION_POLICY_FIELDS && !policy.fields.includes(field.slug)}
                      />
                    ))}
                  </Checkbox.Group>
                </>
              )}
            </div>
          </LayerCard>
        );
      })}
      <Banner
        variant="secondary"
        title="Schema changes"
        description="EmDash 0.36 cannot expose collection schemas to plugin routes. Revisit this tab after changing field types or translatable flags."
      />
      <div>
        <Button variant="primary" loading={working} disabled={settings === null} onClick={() => void save()}>
          Save collections
        </Button>
      </div>
    </section>
  );
}

function TranslationSettingsTab(): ReactNode {
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

export function PolystellaPanel({ collection, entry, locale }: ContentEditorPanelContext): ReactNode {
  const targetLocale = locale ?? entry.locale;
  const currentUser = useCurrentUser();
  const [policy, setPolicy] = useState<CollectionPolicyResponse | null>(null);
  const [schema, setSchema] = useState<CollectionSchema | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<PanelError | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [translating, setTranslating] = useState(false);
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
        "PolyStella translates the latest saved values, replaces the selected fields, and reloads the editor. Unsaved changes will be lost. Continue?",
      )
    ) {
      return;
    }

    setTranslating(true);
    setError(null);
    setDebug(null);
    try {
      const saved = await contentRequest<SavedContentResponse>(collection, entry.id, targetLocale);
      if (saved._rev === undefined) throw new Error("EmDash did not return a revision token; no fields were changed.");
      const result = await pluginRequest<TranslateContentResponse>("translate-content", {
        method: "POST",
        body: JSON.stringify({ collection, entryId: entry.id, targetLocale, fields: selected }),
      });
      if (result.debug !== undefined) setDebug(result.debug);
      if (result.patch === null) {
        setError(panelError(new Error(result.error)));
        return;
      }
      await updateContent(collection, entry.id, targetLocale, result.patch, saved._rev);
      if (result.debug !== undefined && currentUser.data !== undefined && currentUser.data.role >= ADMIN_ROLE) {
        storeTranslationDebug(collection, entry.id, targetLocale, currentUser.data.id, result.debug);
      }
      window.location.reload();
    } catch (cause) {
      setError(panelError(cause));
    } finally {
      setTranslating(false);
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
        Translate saved fields from {policy.sourceLocale} to {targetLocale}.
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

function CatalogTab(): ReactNode {
  const [catalog, setCatalog] = useState<CatalogViewResponse | null>(null);
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [enabledOverrides, setEnabledOverrides] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string[]>([]);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<TranslationDebugTrace | null>(null);

  useEffect(() => {
    void loadCatalog();
  }, []);

  async function loadCatalog(locale?: string): Promise<void> {
    setWorking(true);
    setError(null);
    setDebug(null);
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
    setDrafts(new Map(value.entries.map((entry) => [entry.key, entry.override ?? ""])));
    setEnabledOverrides(new Set(value.entries.flatMap((entry) => (entry.override === null ? [] : [entry.key]))));
    setSelected([]);
    setTouched(new Set());
  }

  async function generate(): Promise<void> {
    if (catalog === null) return;
    setWorking(true);
    setError(null);
    setDebug(null);
    try {
      const result = await pluginRequest<CatalogGenerationResponse>("catalog/generate", {
        method: "POST",
        body: JSON.stringify({ locale: catalog.locale, keys: selected }),
      });
      if (result.debug !== undefined) setDebug(result.debug);
      if (result.translations === null) {
        setError(result.error);
        return;
      }
      setDrafts((current) => {
        const next = new Map(current);
        for (const [key, value] of Object.entries(result.translations)) next.set(key, value);
        return next;
      });
      const generatedEntries = Object.entries(result.translations);
      const originalOverrides = new Map(catalog.entries.map((entry) => [entry.key, entry.override]));
      setEnabledOverrides((current) => new Set([...current, ...Object.keys(result.translations)]));
      setTouched((current) => {
        const next = new Set(current);
        for (const [key, value] of generatedEntries) {
          if (!catalogOverrideChanged(originalOverrides.get(key) ?? null, true, value)) next.delete(key);
          else next.add(key);
        }
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
        const value = enabledOverrides.has(key) ? (drafts.get(key) ?? "") : null;
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
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  function updateOverrideChange(entry: CatalogEntryView, enabled: boolean, value: string): void {
    setTouched((current) => {
      const next = new Set(current);
      if (!catalogOverrideChanged(entry.override, enabled, value)) next.delete(entry.key);
      else next.add(entry.key);
      return next;
    });
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

  if (catalog === null && error === null) return <p style={sectionStyle}>Loading catalog...</p>;
  const localeSummary = catalog?.locales.find((item) => item.locale === catalog.locale);
  const groups = groupCatalogEntries(catalog?.entries ?? []);

  return (
    <section style={sectionStyle}>
      <div>
        <h2>Catalog</h2>
        <p style={mutedStyle}>Generate, edit, and export temporary UI string overrides.</p>
      </div>
      {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
      {debug === null ? null : <TranslationDebugView trace={debug} onDismiss={() => setDebug(null)} />}
      {catalog === null ? null : (
        <>
          <LayerCard style={cardStyle}>
            <div style={rowStyle}>
              <div style={{ minWidth: 180 }}>
                <Select
                  label="Locale"
                  disabled={working || touched.size > 0}
                  value={catalog.locale}
                  onValueChange={(value) => {
                    if (typeof value === "string") void loadCatalog(value);
                  }}
                >
                  {catalog.locales.map((item) => (
                    <Select.Option key={item.locale} value={item.locale}>
                      {item.locale}
                    </Select.Option>
                  ))}
                </Select>
              </div>
              <Switch
                label="Apply temporary overrides at runtime"
                checked={localeSummary?.runtimeEnabled === true}
                disabled={working || touched.size > 0}
                onCheckedChange={(enabled) => void setRuntimeEnabled(enabled)}
              />
              <span style={mutedStyle}>Repository file: {localeSummary?.filePath}</span>
            </div>
          </LayerCard>
          {localeSummary?.runtimeEnabled === true &&
          !catalog.entries.some((entry) => entry.state === "active" || entry.state === "missing") ? (
            <Banner variant="secondary" title="Overrides are synced" description="Runtime overrides can be disabled for this locale." />
          ) : null}
          <div style={rowStyle}>
            <Button
              variant="primary"
              loading={working}
              disabled={working || selected.length === 0 || catalog.locale === catalog.defaultLocale}
              onClick={() => void generate()}
            >
              Generate selected
            </Button>
            <Button variant="secondary" loading={working} disabled={touched.size === 0} onClick={() => void save()}>
              Save changes
            </Button>
            <Button variant="secondary" disabled={working || touched.size > 0} onClick={() => void exportJson()}>
              Export JSON
            </Button>
            <small style={mutedStyle}>
              {selected.length}/{MAX_CATALOG_KEYS} keys selected
            </small>
          </div>
          {groups.map((group) => {
            const groupKeys = new Set(group.entries.map((entry) => entry.key));
            const selectableKeys = group.entries
              .filter((entry) => entry.source !== null && entry.source.length > 0)
              .map((entry) => entry.key);
            const selectedCount = selectableKeys.filter((key) => selected.includes(key)).length;
            return (
              <LayerCard key={group.name}>
                <details>
                  <summary style={{ cursor: "pointer", padding: 20 }}>
                    <strong>{group.name}</strong> <small style={mutedStyle}>{group.entries.length} keys</small>
                  </summary>
                  <div style={{ overflowX: "auto", padding: "0 20px 20px" }}>
                    <Table layout="fixed" style={{ minWidth: 960 }}>
                      <Table.Header>
                        <Table.Row>
                          <Table.CheckHead
                            label={`Select all ${group.name} keys`}
                            checked={selectableKeys.length > 0 && selectedCount === selectableKeys.length}
                            indeterminate={selectedCount > 0 && selectedCount < selectableKeys.length}
                            disabled={working || selectableKeys.length === 0}
                            onCheckedChange={(checked) =>
                              setSelected((current) =>
                                checked
                                  ? [...new Set([...current, ...selectableKeys])].slice(0, MAX_CATALOG_KEYS)
                                  : current.filter((key) => !groupKeys.has(key)),
                              )
                            }
                          />
                          <Table.Head style={{ width: "18%" }}>Key</Table.Head>
                          <Table.Head style={{ width: "22%" }}>Source</Table.Head>
                          <Table.Head style={{ width: "22%" }}>Deployed</Table.Head>
                          <Table.Head style={{ width: "30%" }}>Override</Table.Head>
                          <Table.Head style={{ width: "8%" }}>State</Table.Head>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {group.entries.map((entry) => {
                          const overrideEnabled = enabledOverrides.has(entry.key);
                          return (
                            <Table.Row key={entry.key}>
                              <Table.CheckCell
                                label={`Select ${entry.key}`}
                                checked={selected.includes(entry.key)}
                                disabled={
                                  working ||
                                  entry.source === null ||
                                  entry.source.length === 0 ||
                                  (!selected.includes(entry.key) && selected.length >= MAX_CATALOG_KEYS)
                                }
                                onCheckedChange={(checked) =>
                                  setSelected((current) =>
                                    checked ? [...new Set([...current, entry.key])] : current.filter((key) => key !== entry.key),
                                  )
                                }
                              />
                              <Table.Cell>
                                <strong>{entry.key}</strong>
                              </Table.Cell>
                              <Table.Cell>
                                <span style={mutedStyle}>{entry.source ?? "Missing"}</span>
                              </Table.Cell>
                              <Table.Cell>
                                <span style={mutedStyle}>{entry.deployed ?? "Missing"}</span>
                              </Table.Cell>
                              <Table.Cell>
                                <div style={stackStyle}>
                                  <Switch
                                    label="Enable override"
                                    checked={overrideEnabled}
                                    disabled={working}
                                    onCheckedChange={(enabled) => {
                                      setEnabledOverrides((current) => {
                                        const next = new Set(current);
                                        if (enabled) next.add(entry.key);
                                        else next.delete(entry.key);
                                        return next;
                                      });
                                      updateOverrideChange(entry, enabled, drafts.get(entry.key) ?? "");
                                    }}
                                  />
                                  <Textarea
                                    aria-label={`Override ${entry.key}`}
                                    rows={3}
                                    style={inputStyle}
                                    value={overrideEnabled ? (drafts.get(entry.key) ?? "") : ""}
                                    disabled={working || !overrideEnabled}
                                    onValueChange={(value) => {
                                      setDrafts((current) => new Map(current).set(entry.key, value));
                                      updateOverrideChange(entry, true, value);
                                    }}
                                  />
                                </div>
                              </Table.Cell>
                              <Table.Cell>
                                {entry.state === null ? null : (
                                  <Badge variant={entry.state === "active" ? "orange" : entry.state === "missing" ? "red" : "neutral"}>
                                    {entry.state}
                                  </Badge>
                                )}
                              </Table.Cell>
                            </Table.Row>
                          );
                        })}
                      </Table.Body>
                    </Table>
                  </div>
                </details>
              </LayerCard>
            );
          })}
        </>
      )}
    </section>
  );
}

export function catalogOverrideChanged(originalValue: string | null, enabled: boolean, value: string): boolean {
  return enabled ? value !== originalValue : originalValue !== null;
}

export function groupCatalogEntries(entries: readonly CatalogEntryView[]): Array<{ name: string; entries: CatalogEntryView[] }> {
  const groups = new Map<string, CatalogEntryView[]>();
  for (const entry of entries) {
    const name = entry.key.split(".", 1)[0] ?? entry.key;
    const group = groups.get(name);
    if (group === undefined) groups.set(name, [entry]);
    else group.push(entry);
  }
  return [...groups].map(([name, groupedEntries]) => ({ name, entries: groupedEntries }));
}

export const pages = {
  "/": PolystellaPage,
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
  return <Banner variant="error" title="PolyStella couldn't complete that request" description={children} />;
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

function TranslationDebugView({ trace, onDismiss }: { trace: TranslationDebugTrace; onDismiss(): void }): ReactNode {
  return (
    <LayerCard style={cardStyle}>
      <div style={stackStyle}>
        <div style={rowStyle}>
          <h3 style={{ margin: 0 }}>Translation debug</h3>
          <Button size="sm" variant="secondary" onClick={() => downloadTranslationDebug(trace)}>
            Download JSON
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
        <small style={mutedStyle}>
          ID: {trace.id} | {trace.provider} | {trace.model} | {trace.sourceLocale} to {trace.targetLocale} | {trace.batchCount} batches |{" "}
          {trace.providerCallCount} provider calls | {trace.durationMs} ms
        </small>
        <small style={mutedStyle}>
          Input budget: {trace.inputTokenBudget} estimated tokens
          {trace.maxSegmentsPerBatch === null ? "" : ` | Maximum ${trace.maxSegmentsPerBatch} segments per batch`} | Maximum output:{" "}
          {trace.maxOutputTokens} tokens
        </small>
        {trace.error === null ? null : <pre style={codeStyle}>{trace.error}</pre>}
        {trace.validationIssues.length === 0 ? null : (
          <details>
            <summary>Validation issues</summary>
            <pre style={codeStyle}>{trace.validationIssues.join("\n")}</pre>
          </details>
        )}
        {trace.batches.map((batch) => (
          <details key={batch.batch}>
            <summary>
              Batch {batch.batch}: {batch.segmentCount} segments, {batch.sourceCharacters} source characters, approximately{" "}
              {batch.estimatedInputTokens} input tokens
            </summary>
            <div style={{ ...stackStyle, padding: "12px 0 0 16px" }}>
              <small style={mutedStyle}>{batch.segmentLabels.join(", ")}</small>
              {batch.attempts.map((attempt) => (
                <details key={attempt.attempt}>
                  <summary>
                    Attempt {attempt.attempt}: {attempt.error === null ? "completed" : "failed"} in {attempt.durationMs} ms
                  </summary>
                  <div style={{ ...stackStyle, padding: "12px 0 0 16px" }}>
                    <details>
                      <summary>System prompt</summary>
                      <pre style={codeStyle}>{attempt.systemPrompt}</pre>
                    </details>
                    <details>
                      <summary>User prompt</summary>
                      <pre style={codeStyle}>{attempt.userPrompt}</pre>
                    </details>
                    {attempt.response === null ? null : (
                      <details>
                        <summary>Normalized model response</summary>
                        <pre style={codeStyle}>{attempt.response}</pre>
                      </details>
                    )}
                    {attempt.translations === null ? null : (
                      <details>
                        <summary>Parsed translations</summary>
                        <pre style={codeStyle}>{JSON.stringify(attempt.translations, null, 2)}</pre>
                      </details>
                    )}
                    {attempt.error === null ? null : (
                      <details>
                        <summary>Attempt error</summary>
                        <pre style={codeStyle}>{attempt.error}</pre>
                      </details>
                    )}
                  </div>
                </details>
              ))}
            </div>
          </details>
        ))}
      </div>
    </LayerCard>
  );
}

function downloadTranslationDebug(trace: TranslationDebugTrace): void {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(trace, null, 2)}\n`], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `polystella-${trace.operation}-debug.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function translationDebugStorageKey(collection: string, entryId: string, locale: string, userId: string): string {
  return `polystella:debug:${userId}:${collection}:${entryId}:${locale}`;
}

export function storeTranslationDebug(
  collection: string,
  entryId: string,
  locale: string,
  userId: string,
  trace: TranslationDebugTrace,
): void {
  try {
    sessionStorage.setItem(translationDebugStorageKey(collection, entryId, locale, userId), JSON.stringify(trace));
  } catch {
    // The trace remains available in the current panel when browser storage is unavailable.
  }
}

export function takeTranslationDebug(collection: string, entryId: string, locale: string, userId: string): TranslationDebugTrace | null {
  try {
    const key = translationDebugStorageKey(collection, entryId, locale, userId);
    const stored = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    if (stored === null) return null;
    const value: unknown = JSON.parse(stored);
    return isTranslationDebugTrace(value) ? value : null;
  } catch {
    return null;
  }
}

function removeTranslationDebug(collection: string, entryId: string, locale: string, userId: string): void {
  try {
    sessionStorage.removeItem(translationDebugStorageKey(collection, entryId, locale, userId));
  } catch {
    // Browser storage may be unavailable.
  }
}

export function isTranslationDebugTrace(value: unknown): value is TranslationDebugTrace {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.operation === "content" || value.operation === "catalog") &&
    (value.provider === "workers-ai-binding" || value.provider === "workers-ai-http") &&
    typeof value.model === "string" &&
    typeof value.maxOutputTokens === "number" &&
    typeof value.inputTokenBudget === "number" &&
    (value.maxSegmentsPerBatch === null || typeof value.maxSegmentsPerBatch === "number") &&
    typeof value.sourceLocale === "string" &&
    typeof value.targetLocale === "string" &&
    typeof value.batchCount === "number" &&
    typeof value.providerCallCount === "number" &&
    typeof value.durationMs === "number" &&
    (value.error === null || typeof value.error === "string") &&
    isStringArray(value.validationIssues) &&
    Array.isArray(value.batches) &&
    value.batches.every(isTranslationDebugBatch)
  );
}

function isTranslationDebugBatch(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.batch === "number" &&
    typeof value.segmentCount === "number" &&
    isStringArray(value.segmentIds) &&
    isStringArray(value.segmentLabels) &&
    typeof value.sourceCharacters === "number" &&
    typeof value.estimatedInputTokens === "number" &&
    Array.isArray(value.attempts) &&
    value.attempts.every(isTranslationDebugAttempt)
  );
}

function isTranslationDebugAttempt(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.attempt === "number" &&
    typeof value.durationMs === "number" &&
    typeof value.systemPrompt === "string" &&
    typeof value.userPrompt === "string" &&
    (value.response === null || typeof value.response === "string") &&
    (value.translations === null ||
      (isRecord(value.translations) && Object.values(value.translations).every((item) => typeof item === "string"))) &&
    (value.error === null || typeof value.error === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCustomizationMode(value: unknown): value is CustomizationMode {
  return value === "default" || value === "append" || value === "replace";
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

function panelError(value: unknown): PanelError {
  return {
    message:
      value instanceof ApiResponseError && value.status === 409
        ? "This entry changed while PolyStella was translating it. Retry the translation."
        : errorMessage(value),
    details: formatErrorDetails(value),
  };
}

export function formatErrorDetails(value: unknown): string {
  if (value instanceof ApiResponseError) {
    return [
      `HTTP status: ${value.status}`,
      `Code: ${value.code}`,
      `Message: ${value.message}`,
      ...(value.details === undefined ? [] : [`Details: ${JSON.stringify(value.details, null, 2)}`]),
    ].join("\n");
  }
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  return String(value);
}
