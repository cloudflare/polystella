import { Banner, Button, Input, LayerCard, Select, Switch, Table, Textarea, Tooltip } from "@cloudflare/kumo";
import { QuestionIcon } from "@phosphor-icons/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  MAX_CATALOG_KEYS,
  type CatalogClearSyncedResponse,
  type CatalogExportResponse,
  type CatalogGenerationResponse,
  type CatalogEntryView,
  type CatalogOverrideMutationResponse,
  type CatalogRuntimeMutationResponse,
  type CatalogViewResponse,
  type TranslationDebugTrace,
} from "../../../../contracts.js";
import { errorMessage, localeLabel, plural, pluginRequest } from "../../../utils.js";
import type { CatalogGroup, TranslationProgressState } from "../../../types.js";
import { cardStyle, inputStyle, mutedStyle, rowStyle, sectionStyle, stackStyle } from "../../../styles.js";
import { ErrorMessage } from "../../../components/ErrorMessage/ErrorMessage.js";
import { SectionHeader } from "../../../components/PageHeader/PageHeader.js";
import { TranslationDebugView } from "../../../components/TranslationDebugView/TranslationDebugView.js";
import { TranslationProgress } from "../../../components/TranslationProgress/TranslationProgress.js";
import { catalogOverrideChanged, filterCatalogGroups, groupCatalogEntries, keyWithinGroup, sourceContainsTokens } from "./helpers.js";

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function CatalogTab(): ReactNode {
  const [catalog, setCatalog] = useState<CatalogViewResponse | null>(null);
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [enabledOverrides, setEnabledOverrides] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string[]>([]);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<TranslationProgressState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<TranslationDebugTrace | null>(null);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 200);

  useEffect(() => {
    void loadCatalog();
  }, []);

  useEffect(() => {
    if (catalog === null) return;
    const runtimeOn = catalog.locales.find((item) => item.locale === catalog.locale)?.runtimeEnabled === true;
    if (enabledOverrides.size > 0 !== runtimeOn) void setRuntimeEnabled(enabledOverrides.size > 0);
  }, [enabledOverrides]);

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
    setGenerationProgress({ percent: 50, label: "Translating selected catalog strings" });
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
        setGenerationProgress(null);
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
      setGenerationProgress({ percent: 100, label: "Catalog generation complete" });
    } catch (cause) {
      setError(errorMessage(cause));
      setGenerationProgress(null);
    } finally {
      setWorking(false);
    }
  }

  async function save(): Promise<void> {
    if (catalog === null) return;
    setWorking(true);
    setError(null);
    try {
      const loadedOverrides = new Map(catalog.entries.map((entry) => [entry.key, entry.override]));
      for (const key of [...touched]) {
        const value = enabledOverrides.has(key) ? (drafts.get(key) ?? "") : null;
        await pluginRequest<CatalogOverrideMutationResponse>("catalog/overrides", {
          method: "PUT",
          body: JSON.stringify({ locale: catalog.locale, overrides: { [key]: value }, expected: loadedOverrides.get(key) ?? null }),
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

  async function clearSynced(): Promise<void> {
    if (catalog === null) return;
    if (!window.confirm(`Delete every ${catalog.locale} override that already matches the deployed catalog?`)) return;
    setWorking(true);
    setError(null);
    try {
      const result = await pluginRequest<CatalogClearSyncedResponse>("catalog/clear-synced", {
        method: "POST",
        body: JSON.stringify({ locale: catalog.locale }),
      });
      await loadCatalog(result.locale);
      if (result.skipped.length > 0) {
        setError(`These overrides changed while clearing and were kept: ${result.skipped.join(", ")}`);
      }
    } catch (cause) {
      setError(errorMessage(cause));
      setWorking(false);
    }
  }

  const updateOverrideChange = useCallback((entry: CatalogEntryView, enabled: boolean, value: string): void => {
    setTouched((current) => {
      const changed = catalogOverrideChanged(entry.override, enabled, value);
      if (changed === current.has(entry.key)) return current;
      const next = new Set(current);
      if (changed) next.add(entry.key);
      else next.delete(entry.key);
      return next;
    });
  }, []);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const toggleOverride = useCallback(
    (entry: CatalogEntryView, enabled: boolean): void => {
      setEnabledOverrides((current) => {
        const next = new Set(current);
        if (enabled) next.add(entry.key);
        else next.delete(entry.key);
        return next;
      });
      updateOverrideChange(entry, enabled, draftsRef.current.get(entry.key) ?? "");
    },
    [updateOverrideChange],
  );
  const changeDraft = useCallback(
    (entry: CatalogEntryView, value: string): void => {
      setDrafts((current) => new Map(current).set(entry.key, value));
      updateOverrideChange(entry, true, value);
    },
    [updateOverrideChange],
  );
  const toggleSelected = useCallback((keys: readonly string[], checked: boolean): void => {
    setSelected((current) =>
      checked ? [...new Set([...current, ...keys])].slice(0, MAX_CATALOG_KEYS) : current.filter((key) => !keys.includes(key)),
    );
  }, []);
  const selectedKeys = useMemo(() => new Set(selected), [selected]);
  const groups = useMemo(
    () => filterCatalogGroups(groupCatalogEntries(catalog?.entries ?? [], catalog?.groups ?? []), debouncedSearch),
    [catalog, debouncedSearch],
  );

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
  const actions = (
    <div style={rowStyle}>
      <Button
        variant="primary"
        loading={working}
        disabled={working || selected.length === 0 || catalog?.locale === catalog?.defaultLocale}
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
      <Button
        variant="secondary"
        disabled={working || touched.size > 0 || !catalog?.entries.some((entry) => entry.state === "synced")}
        onClick={() => void clearSynced()}
      >
        Clear synced overrides
      </Button>
      <small style={mutedStyle}>
        {selected.length}/{MAX_CATALOG_KEYS} keys selected
      </small>
    </div>
  );

  return (
    <section style={sectionStyle}>
      <SectionHeader title="Catalog" description="Generate, edit, and export temporary UI string overrides." />
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
                  renderValue={(value) => (typeof value === "string" ? localeLabel(value) : "")}
                  onValueChange={(value) => {
                    if (typeof value === "string") void loadCatalog(value);
                  }}
                >
                  {catalog.locales.map((item) => (
                    <Select.Option key={item.locale} value={item.locale}>
                      {localeLabel(item.locale)}
                    </Select.Option>
                  ))}
                </Select>
              </div>
              <Switch
                label="Apply overrides"
                checked={localeSummary?.runtimeEnabled === true}
                disabled={working || touched.size > 0 || enabledOverrides.size === 0}
                onCheckedChange={(enabled) => void setRuntimeEnabled(enabled)}
              />
            </div>
          </LayerCard>
          {localeSummary?.runtimeEnabled === true &&
          !catalog.entries.some((entry) => entry.state === "active" || entry.state === "missing") ? (
            <Banner variant="secondary" title="Overrides are synced" description="Runtime overrides can be disabled for this locale." />
          ) : null}
          {actions}
          <Input
            label="Search catalog"
            placeholder="Filter groups by title, key, source text, or keys within groups"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {generationProgress === null ? null : <TranslationProgress {...generationProgress} />}
          {groups.map((group) => (
            <CatalogGroupCard
              key={group.key}
              group={group}
              messageSyntax={catalog.messageSyntax}
              selectedKeys={selectedKeys}
              selectionFull={selected.length >= MAX_CATALOG_KEYS}
              drafts={drafts}
              enabledOverrides={enabledOverrides}
              working={working}
              onToggleSelected={toggleSelected}
              onToggleOverride={toggleOverride}
              onDraftChange={changeDraft}
            />
          ))}
          {actions}
        </>
      )}
    </section>
  );
}

interface CatalogRowHandlers {
  onToggleSelected(keys: readonly string[], checked: boolean): void;
  onToggleOverride(entry: CatalogEntryView, enabled: boolean): void;
  onDraftChange(entry: CatalogEntryView, value: string): void;
}

/** Mounts its table only while open, so typing in one override doesn't re-render every key of every group. */
const CatalogGroupCard = memo(function CatalogGroupCard({
  group,
  messageSyntax,
  selectedKeys,
  selectionFull,
  drafts,
  enabledOverrides,
  working,
  onToggleSelected,
  onToggleOverride,
  onDraftChange,
}: CatalogRowHandlers & {
  group: CatalogGroup;
  messageSyntax: CatalogViewResponse["messageSyntax"];
  selectedKeys: ReadonlySet<string>;
  selectionFull: boolean;
  drafts: ReadonlyMap<string, string>;
  enabledOverrides: ReadonlySet<string>;
  working: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const selectableKeys = useMemo(
    () => group.entries.filter((entry) => entry.source !== null && entry.source.length > 0).map((entry) => entry.key),
    [group],
  );
  const groupKeys = useMemo(() => group.entries.map((entry) => entry.key), [group]);
  const selectedCount = selectableKeys.filter((key) => selectedKeys.has(key)).length;
  return (
    <LayerCard>
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary style={{ cursor: "pointer", padding: 20 }}>
          <strong>{group.title ?? group.key}</strong> {group.title === null ? null : <small style={mutedStyle}>({group.key}) </small>}
          <small style={mutedStyle}>{plural(group.entries.length, "key")}</small>
        </summary>
        {open ? (
          <div style={{ overflowX: "auto", padding: "0 20px 20px" }}>
            <Table layout="fixed" style={{ minWidth: 960 }}>
              <Table.Header>
                <Table.Row>
                  <Table.CheckHead
                    label={`Select all ${group.key} keys`}
                    checked={selectableKeys.length > 0 && selectedCount === selectableKeys.length}
                    indeterminate={selectedCount > 0 && selectedCount < selectableKeys.length}
                    disabled={working || selectableKeys.length === 0}
                    style={{ width: 48 }}
                    onCheckedChange={(checked) => onToggleSelected(checked ? selectableKeys : groupKeys, checked)}
                  />
                  <Table.Head style={{ width: "19%" }}>Key</Table.Head>
                  <Table.Head style={{ width: "26%" }}>Source</Table.Head>
                  <Table.Head style={{ width: "26%" }}>Deployed</Table.Head>
                  <Table.Head>Override</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {group.entries.map((entry) => {
                  const checked = selectedKeys.has(entry.key);
                  return (
                    <CatalogRow
                      key={entry.key}
                      entry={entry}
                      keyLabel={keyWithinGroup(entry.key, group.key)}
                      messageSyntax={messageSyntax}
                      checked={checked}
                      selectDisabled={working || entry.source === null || entry.source.length === 0 || (!checked && selectionFull)}
                      overrideEnabled={enabledOverrides.has(entry.key)}
                      draft={drafts.get(entry.key) ?? ""}
                      working={working}
                      onToggleSelected={onToggleSelected}
                      onToggleOverride={onToggleOverride}
                      onDraftChange={onDraftChange}
                    />
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        ) : null}
      </details>
    </LayerCard>
  );
});

const CatalogRow = memo(function CatalogRow({
  entry,
  keyLabel,
  messageSyntax,
  checked,
  selectDisabled,
  overrideEnabled,
  draft,
  working,
  onToggleSelected,
  onToggleOverride,
  onDraftChange,
}: CatalogRowHandlers & {
  entry: CatalogEntryView;
  keyLabel: string;
  messageSyntax: CatalogViewResponse["messageSyntax"];
  checked: boolean;
  selectDisabled: boolean;
  overrideEnabled: boolean;
  draft: string;
  working: boolean;
}): ReactNode {
  return (
    <Table.Row>
      <Table.CheckCell
        label={`Select ${entry.key}`}
        checked={checked}
        disabled={selectDisabled}
        onCheckedChange={(next) => onToggleSelected([entry.key], next)}
      />
      <Table.Cell>
        <strong style={{ overflowWrap: "anywhere" }} title={entry.key}>
          {keyLabel}
        </strong>
      </Table.Cell>
      <Table.Cell>
        <TokenGuidance source={entry.source} messageSyntax={messageSyntax} />
      </Table.Cell>
      <Table.Cell>
        <span style={mutedStyle}>{entry.deployed ?? "Missing"}</span>
      </Table.Cell>
      <Table.Cell>
        <div style={stackStyle}>
          <Switch
            aria-label={`Override ${entry.key}`}
            label={overrideEnabled ? "Enabled" : "Disabled"}
            checked={overrideEnabled}
            disabled={working}
            onCheckedChange={(enabled) => onToggleOverride(entry, enabled)}
          />
          {overrideEnabled ? (
            <Textarea
              aria-label={`Override ${entry.key}`}
              rows={3}
              style={inputStyle}
              value={draft}
              disabled={working}
              onValueChange={(value) => onDraftChange(entry, value)}
            />
          ) : null}
        </div>
      </Table.Cell>
    </Table.Row>
  );
});

function TokenGuidance({
  source,
  messageSyntax,
}: {
  source: string | null;
  messageSyntax: CatalogViewResponse["messageSyntax"];
}): ReactNode {
  const [open, setOpen] = useState(false);
  const variables = messageSyntax === "icu" ? "{variables}" : "{{variables}}";
  if (!sourceContainsTokens(source, messageSyntax)) return <span style={mutedStyle}>{source ?? "Missing"}</span>;
  return (
    <>
      <Tooltip
        open={open}
        onOpenChange={setOpen}
        content={`This string contains ${variables}. Overrides should retain them.`}
        render={
          <button
            type="button"
            aria-label={`Contains ${variables} placeholders`}
            onClick={() => setOpen((current) => !current)}
            style={{
              background: "none",
              border: "none",
              color: "inherit",
              cursor: "help",
              marginRight: 4,
              padding: 0,
              verticalAlign: "middle",
            }}
          />
        }
      >
        <QuestionIcon size={14} />
      </Tooltip>
      <span style={mutedStyle}>{source}</span>
    </>
  );
}
