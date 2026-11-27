import { ApiResponseError } from "@emdash-cms/admin";
import { Badge, Banner, Button, Checkbox, Input, LayerCard, Select, Switch, Table, Textarea } from "@cloudflare/kumo";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

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
import { InfoLabel, InfoTooltip, SectionHeader, TextTooltip } from "../../../components/PageHeader/PageHeader.js";
import { TranslationDebugView } from "../../../components/TranslationDebugView/TranslationDebugView.js";
import { TranslationProgress } from "../../../components/TranslationProgress/TranslationProgress.js";
import {
  applyOverridesInfo,
  catalogActionHint,
  catalogOverrideChanged,
  filterCatalogGroups,
  groupCatalogEntries,
  keyWithinGroup,
  listKeys,
  shortenText,
  sourceContainsTokens,
} from "./helpers.js";

const NARROW_WIDTH = 720;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** True while the measured element is narrower than `width`; the admin column, not the window, decides the layout. */
function useNarrowContainer(width: number): [(node: HTMLElement | null) => void, boolean] {
  const [narrow, setNarrow] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback(
    (node: HTMLElement | null) => {
      observer.current?.disconnect();
      if (node === null || typeof ResizeObserver === "undefined") return;
      observer.current = new ResizeObserver(([entry]) => {
        if (entry !== undefined) setNarrow(entry.contentRect.width < width);
      });
      observer.current.observe(node);
    },
    [width],
  );
  return [ref, narrow];
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
  const [errorOffersReload, setErrorOffersReload] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Kept out of the status region, so a screen reader hears only the result of a save, not every key.
  const [saveProgress, setSaveProgress] = useState<string | null>(null);
  const [debug, setDebug] = useState<TranslationDebugTrace | null>(null);
  const [search, setSearch] = useState("");
  const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(search, 200);
  const [sectionRef, narrow] = useNarrowContainer(NARROW_WIDTH);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeadingRef = useRef(false);

  useEffect(() => {
    void loadCatalog();
  }, []);

  useEffect(() => {
    if (!focusHeadingRef.current) return;
    focusHeadingRef.current = false;
    // Waits a frame so the Select's own focus return doesn't win.
    requestAnimationFrame(() => {
      headingRef.current?.scrollIntoView({ block: "start" });
      headingRef.current?.focus({ preventScroll: true });
    });
  }, [activeGroupKey]);

  function showError(message: string | null, offerReload = false): void {
    setError(message);
    setErrorOffersReload(offerReload);
  }

  async function loadCatalog(locale?: string): Promise<void> {
    setWorking(true);
    showError(null);
    setStatus(null);
    setDebug(null);
    try {
      const value = await pluginRequest<CatalogViewResponse>(
        `catalog${locale === undefined ? "" : `?locale=${encodeURIComponent(locale)}`}`,
      );
      applyCatalog(value);
    } catch (cause) {
      showError(errorMessage(cause));
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

  function confirmDiscard(action: string): boolean {
    return touched.size === 0 || window.confirm(`${action} discards ${plural(touched.size, "unsaved change")}.`);
  }

  async function generate(): Promise<void> {
    if (catalog === null) return;
    setWorking(true);
    setGenerationProgress({ percent: 50, label: "Translating selected catalog strings" });
    showError(null);
    setStatus(null);
    setDebug(null);
    try {
      const result = await pluginRequest<CatalogGenerationResponse>("catalog/generate", {
        method: "POST",
        body: JSON.stringify({ locale: catalog.locale, keys: selected }),
      });
      if (result.debug !== undefined) setDebug(result.debug);
      if (result.translations === null) {
        showError(result.error);
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
        showError(`Placeholder validation failed for: ${listKeys(result.tokenFailures.map((failure) => failure.key))}`);
      }
      setGenerationProgress({ percent: 100, label: "Catalog generation complete", usage: result.usage });
    } catch (cause) {
      showError(errorMessage(cause));
      setGenerationProgress(null);
    } finally {
      setWorking(false);
    }
  }

  async function save(): Promise<void> {
    if (catalog === null) return;
    const keys = [...touched];
    let saved = 0;
    setWorking(true);
    setStatus(null);
    showError(null);
    try {
      const loadedOverrides = new Map(catalog.entries.map((entry) => [entry.key, entry.override]));
      for (const key of keys) {
        setSaveProgress(`Saving ${saved + 1}/${keys.length}`);
        const value = enabledOverrides.has(key) ? (drafts.get(key) ?? "") : null;
        await pluginRequest<CatalogOverrideMutationResponse>("catalog/overrides", {
          method: "PUT",
          body: JSON.stringify({ locale: catalog.locale, overrides: { [key]: value }, expected: loadedOverrides.get(key) ?? null }),
        });
        saved += 1;
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
      setStatus(`Saved ${plural(saved, "override")}`);
    } catch (cause) {
      setStatus(saved === 0 ? null : `Saved ${plural(saved, "override")}`);
      showError(errorMessage(cause), cause instanceof ApiResponseError && cause.status === 409);
    } finally {
      setSaveProgress(null);
      setWorking(false);
    }
  }

  async function clearSynced(): Promise<void> {
    if (catalog === null) return;
    if (!window.confirm(`Delete every ${catalog.locale} override that already matches the current translation?`)) return;
    setWorking(true);
    showError(null);
    try {
      const result = await pluginRequest<CatalogClearSyncedResponse>("catalog/clear-synced", {
        method: "POST",
        body: JSON.stringify({ locale: catalog.locale }),
      });
      await loadCatalog(result.locale);
      setStatus(`Cleared ${plural(result.cleared.length, "synced override")}`);
      if (result.skipped.length > 0) {
        showError(`These overrides changed while clearing and were kept: ${listKeys(result.skipped)}`);
      }
    } catch (cause) {
      showError(errorMessage(cause));
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
    showError(null);
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
      showError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  async function exportJson(): Promise<void> {
    if (catalog === null) return;
    setWorking(true);
    showError(null);
    try {
      const result = await pluginRequest<CatalogExportResponse>(`catalog/export?locale=${encodeURIComponent(catalog.locale)}`);
      const url = URL.createObjectURL(new Blob([result.json], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      showError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  if (catalog === null && error === null) return <p style={sectionStyle}>Loading catalog...</p>;
  const errorView =
    error === null ? null : (
      <ErrorMessage>
        {error}
        {errorOffersReload && catalog !== null ? (
          <span style={{ display: "block", marginTop: 8 }}>
            <Button
              size="sm"
              variant="secondary"
              disabled={working}
              onClick={() => {
                if (confirmDiscard("Reloading")) void loadCatalog(catalog.locale);
              }}
            >
              Reload catalog
            </Button>
          </span>
        ) : null}
      </ErrorMessage>
    );
  if (catalog === null) {
    return (
      <section style={sectionStyle}>
        <SectionHeader title="Catalog" description="Generate, edit, and export temporary UI string overrides." />
        {errorView}
      </section>
    );
  }

  const localeSummary = catalog.locales.find((item) => item.locale === catalog.locale);
  const runtimeOn = localeSummary?.runtimeEnabled === true;
  const savedOverrides = catalog.entries.filter((entry) => entry.override !== null).length;
  const hasSavedOverrides = savedOverrides > 0;
  const hasSynced = catalog.entries.some((entry) => entry.state === "synced");
  const isDefaultLocale = catalog.locale === catalog.defaultLocale;
  // Falls back to the first group alphabetically, on first load and when a search hides the chosen one.
  const activeGroup = groups.find((group) => group.key === activeGroupKey) ?? groups[0];
  const noGroupsMessage = (
    <span style={mutedStyle}>{catalog.entries.length === 0 ? "No catalog entries." : "No keys match your search."}</span>
  );
  const actionHint = catalogActionHint({ unsaved: touched.size, selected: selected.length, isDefaultLocale, hasSynced });

  return (
    <section ref={sectionRef} style={sectionStyle}>
      <SectionHeader title="Catalog" description="Generate, edit, and export temporary UI string overrides." />
      <LayerCard style={cardStyle}>
        <div style={rowStyle}>
          <div style={narrow ? inputStyle : { minWidth: 180 }}>
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
          <div style={{ display: "grid", gap: 4 }}>
            <Switch
              aria-label="Apply overrides"
              label={<InfoLabel label="Apply overrides" info={applyOverridesInfo(runtimeOn, savedOverrides)} />}
              checked={runtimeOn}
              disabled={working || touched.size > 0 || (!runtimeOn && !hasSavedOverrides)}
              onCheckedChange={(enabled) => void setRuntimeEnabled(enabled)}
            />
          </div>
        </div>
      </LayerCard>
      <LayerCard style={actionBarStyle}>
        {errorView}
        {generationProgress === null ? null : <TranslationProgress {...generationProgress} />}
        <div style={rowStyle}>
          <Button
            variant="primary"
            loading={working}
            disabled={working || selected.length === 0 || isDefaultLocale}
            onClick={() => void generate()}
          >
            Generate selected
          </Button>
          <Button variant="secondary" loading={working} disabled={touched.size === 0} onClick={() => void save()}>
            Save changes
          </Button>
          <Button
            variant="secondary"
            disabled={working || touched.size === 0}
            onClick={() => {
              if (!confirmDiscard("Discarding")) return;
              applyCatalog(catalog);
              showError(null);
              setStatus(null);
            }}
          >
            Discard
          </Button>
          <Button variant="secondary" disabled={working || touched.size > 0} onClick={() => void exportJson()}>
            Export JSON
          </Button>
          <Button variant="secondary" disabled={working || touched.size > 0 || !hasSynced} onClick={() => void clearSynced()}>
            Clear synced overrides
          </Button>
          {touched.size === 0 ? null : <Badge variant="warning">{touched.size} unsaved</Badge>}
        </div>
        <small style={mutedStyle}>
          Up to {MAX_CATALOG_KEYS} keys per request · {selected.length}/{MAX_CATALOG_KEYS} selected
          {actionHint === null ? "" : ` · ${actionHint}`}
        </small>
        {saveProgress === null ? null : <small style={mutedStyle}>{saveProgress}</small>}
        <small role="status" style={mutedStyle}>
          {status}
        </small>
      </LayerCard>
      {runtimeOn && !catalog.entries.some((entry) => entry.state === "active" || entry.state === "missing") ? (
        <Banner variant="secondary" title="Overrides are synced" description="Runtime overrides can be disabled for this locale." />
      ) : null}
      <div style={catalogLayoutStyle}>
        <LayerCard style={{ ...cardStyle, flex: "1 1 240px", minWidth: 0 }}>
          <div style={stackStyle}>
            <Input
              label="Search catalog"
              placeholder="Title, key or source text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {groups.length === 0 ? (
              noGroupsMessage
            ) : narrow ? (
              <Select
                label="Translation group"
                value={activeGroup?.key ?? ""}
                renderValue={(value) => {
                  const group = groups.find((item) => item.key === value);
                  return group === undefined ? "" : (group.title ?? group.key);
                }}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  focusHeadingRef.current = true;
                  setActiveGroupKey(value);
                }}
              >
                {groups.map((group) => (
                  <Select.Option key={group.key} value={group.key}>
                    {group.title ?? group.key} ({plural(group.entries.length, "key")})
                  </Select.Option>
                ))}
              </Select>
            ) : (
              <div role="group" aria-label="Translation groups" style={groupListStyle}>
                {groups.map((group) => {
                  const active = group.key === activeGroup?.key;
                  const selectedInGroup = group.entries.filter((entry) => selectedKeys.has(entry.key)).length;
                  return (
                    <button
                      key={group.key}
                      type="button"
                      aria-pressed={active}
                      style={active ? activeGroupButtonStyle : groupButtonStyle}
                      onClick={() => setActiveGroupKey(group.key)}
                    >
                      <span style={{ overflowWrap: "anywhere" }}>{group.title ?? group.key}</span>
                      <small style={mutedStyle}>
                        {plural(group.entries.length, "key")}
                        {selectedInGroup === 0 ? "" : `, ${selectedInGroup} selected`}
                      </small>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </LayerCard>
        {activeGroup === undefined ? null : (
          <CatalogGroupCard
            key={activeGroup.key}
            group={activeGroup}
            narrow={narrow}
            headingRef={headingRef}
            messageSyntax={catalog.messageSyntax}
            selectedKeys={selectedKeys}
            selectionFull={selected.length >= MAX_CATALOG_KEYS}
            drafts={drafts}
            enabledOverrides={enabledOverrides}
            touchedKeys={touched}
            overridesApplied={runtimeOn}
            working={working}
            onToggleSelected={toggleSelected}
            onToggleOverride={toggleOverride}
            onDraftChange={changeDraft}
          />
        )}
      </div>
      {debug === null ? null : <TranslationDebugView trace={debug} onDismiss={() => setDebug(null)} />}
    </section>
  );
}

const catalogLayoutStyle: CSSProperties = { alignItems: "flex-start", display: "flex", flexWrap: "wrap", gap: 20 };
const groupListStyle: CSSProperties = { display: "grid", gap: 2, maxHeight: "65vh", overflowY: "auto", paddingRight: 8 };
const groupButtonStyle: CSSProperties = {
  background: "none",
  border: "none",
  borderRadius: 8,
  color: "inherit",
  cursor: "pointer",
  display: "grid",
  font: "inherit",
  gap: 2,
  padding: "8px 10px",
  textAlign: "left",
};
const activeGroupButtonStyle: CSSProperties = {
  ...groupButtonStyle,
  background: "color-mix(in srgb, var(--color-kumo-brand, #2563eb) 14%, transparent)",
  fontWeight: 600,
};
const actionBarStyle: CSSProperties = { ...cardStyle, ...stackStyle, gap: 8 };
const listStyle: CSSProperties = { display: "grid", listStyle: "none", margin: 0, padding: 0 };
const itemStyle: CSSProperties = { borderTop: "1px solid var(--color-kumo-line, #ececef)", display: "flex", gap: 10, padding: "12px 0" };
const truncateStyle: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

interface CatalogRowHandlers {
  onToggleSelected(keys: readonly string[], checked: boolean): void;
  onToggleOverride(entry: CatalogEntryView, enabled: boolean): void;
  onDraftChange(entry: CatalogEntryView, value: string): void;
}

/** One group's keys; only the active group is mounted, so typing in an override doesn't re-render every key. */
export const CatalogGroupCard = memo(function CatalogGroupCard({
  group,
  narrow,
  headingRef,
  messageSyntax,
  selectedKeys,
  selectionFull,
  drafts,
  enabledOverrides,
  touchedKeys,
  overridesApplied,
  working,
  onToggleSelected,
  onToggleOverride,
  onDraftChange,
}: CatalogRowHandlers & {
  group: CatalogGroup;
  narrow: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  messageSyntax: CatalogViewResponse["messageSyntax"];
  selectedKeys: ReadonlySet<string>;
  selectionFull: boolean;
  drafts: ReadonlyMap<string, string>;
  enabledOverrides: ReadonlySet<string>;
  touchedKeys: ReadonlySet<string>;
  /** The saved "Apply overrides" setting for this locale. */
  overridesApplied: boolean;
  working: boolean;
}): ReactNode {
  const selectableKeys = useMemo(
    () => group.entries.filter((entry) => entry.source !== null && entry.source.length > 0).map((entry) => entry.key),
    [group],
  );
  const groupKeys = useMemo(() => group.entries.map((entry) => entry.key), [group]);
  const selectedCount = selectableKeys.filter((key) => selectedKeys.has(key)).length;
  const groupName = group.title ?? group.key;
  const selectAll = {
    checked: selectableKeys.length > 0 && selectedCount === selectableKeys.length,
    indeterminate: selectedCount > 0 && selectedCount < selectableKeys.length,
    disabled: working || selectableKeys.length === 0 || (selectionFull && selectedCount === 0),
    onCheckedChange: (checked: boolean) => onToggleSelected(checked ? selectableKeys : groupKeys, checked),
  };
  const rows = group.entries.map((entry) => {
    const checked = selectedKeys.has(entry.key);
    const touched = touchedKeys.has(entry.key);
    const props = {
      entry,
      keyLabel: keyWithinGroup(entry.key, group.key),
      messageSyntax,
      checked,
      selectDisabled: working || entry.source === null || entry.source.length === 0 || (!checked && selectionFull),
      overrideEnabled: enabledOverrides.has(entry.key),
      draft: drafts.get(entry.key) ?? "",
      touched,
      // An untouched row with a saved override is enabled, so only Apply overrides being off hides it.
      notApplied: !overridesApplied && !touched && entry.override !== null,
      working,
      onToggleSelected,
      onToggleOverride,
      onDraftChange,
    };
    return narrow ? <CatalogListItem key={entry.key} {...props} /> : <CatalogRow key={entry.key} {...props} />;
  });
  return (
    <LayerCard style={{ ...cardStyle, flex: "4 1 560px", minWidth: 0 }}>
      <div style={stackStyle}>
        <h3 ref={headingRef} tabIndex={-1} style={{ fontSize: 18, margin: 0, scrollMarginTop: 16 }}>
          {groupName} {group.title === null ? null : <small style={mutedStyle}>({group.key}) </small>}
          <small style={mutedStyle}>{plural(group.entries.length, "key")}</small>
        </h3>
        {selectionFull && selectedCount < selectableKeys.length ? (
          <small style={mutedStyle}>
            {MAX_CATALOG_KEYS} keys are selected, the most one request can generate. Generate or deselect some to pick more.
          </small>
        ) : null}
        {narrow ? (
          <>
            <Checkbox label={`Select all ${plural(selectableKeys.length, "key")}`} {...selectAll} />
            <ul aria-label={`${groupName} catalog keys`} style={listStyle}>
              {rows}
            </ul>
          </>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <Table layout="fixed" aria-label={`${groupName} catalog keys`} style={{ minWidth: 560 }}>
              <Table.Header>
                <Table.Row>
                  <Table.CheckHead label={`Select all ${group.key} keys`} style={{ width: 48 }} {...selectAll} />
                  <Table.Head style={{ width: "20%" }}>Key</Table.Head>
                  <Table.Head style={{ width: "25%" }}>Source</Table.Head>
                  <Table.Head style={{ width: "25%" }}>Current translation</Table.Head>
                  <Table.Head>Override</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>{rows}</Table.Body>
            </Table>
          </div>
        )}
      </div>
    </LayerCard>
  );
});

type CatalogRowProps = CatalogRowHandlers & {
  entry: CatalogEntryView;
  keyLabel: string;
  messageSyntax: CatalogViewResponse["messageSyntax"];
  checked: boolean;
  selectDisabled: boolean;
  overrideEnabled: boolean;
  draft: string;
  touched: boolean;
  notApplied: boolean;
  working: boolean;
};

const CatalogRow = memo(function CatalogRow(props: CatalogRowProps): ReactNode {
  const { entry, keyLabel, messageSyntax, checked, selectDisabled, touched, notApplied, onToggleSelected } = props;
  return (
    <Table.Row>
      <Table.CheckCell
        label={`Select ${entry.key}`}
        checked={checked}
        disabled={selectDisabled}
        onCheckedChange={(next) => onToggleSelected([entry.key], next)}
      />
      <Table.Cell>
        <div style={{ display: "grid", gap: 6, justifyItems: "start" }}>
          <code style={{ fontWeight: 500, overflowWrap: "anywhere" }} title={entry.key}>
            {keyLabel}
          </code>
          <StateBadge entry={entry} touched={touched} notApplied={notApplied} />
        </div>
      </Table.Cell>
      <Table.Cell>
        <TokenHint source={entry.source} messageSyntax={messageSyntax} />
        <span style={mutedStyle}>{entry.source ?? "Missing"}</span>
      </Table.Cell>
      <Table.Cell>
        <span style={mutedStyle}>{entry.deployed ?? "Missing"}</span>
      </Table.Cell>
      <Table.Cell>
        <OverrideEditor {...props} inTable />
      </Table.Cell>
    </Table.Row>
  );
});

const CatalogListItem = memo(function CatalogListItem(props: CatalogRowProps): ReactNode {
  const { entry, keyLabel, messageSyntax, checked, selectDisabled, touched, notApplied, onToggleSelected } = props;
  return (
    <li style={itemStyle}>
      <Checkbox
        aria-label={`Select ${entry.key}`}
        checked={checked}
        disabled={selectDisabled}
        onCheckedChange={(next) => onToggleSelected([entry.key], next)}
      />
      <div style={{ display: "grid", flex: 1, gap: 6, minWidth: 0 }}>
        <div style={{ ...rowStyle, gap: 6 }}>
          <code style={{ fontWeight: 500, overflowWrap: "anywhere" }} title={entry.key}>
            <ShortText text={keyLabel} max={40} />
          </code>
          <StateBadge entry={entry} touched={touched} notApplied={notApplied} />
        </div>
        <small style={{ ...mutedStyle, overflowWrap: "anywhere" }}>
          <TokenHint source={entry.source} messageSyntax={messageSyntax} />
          <ShortText text={`${entry.source ?? "Missing"} → ${entry.deployed ?? "Missing"}`} max={120} />
        </small>
        <OverrideEditor {...props} />
      </div>
    </li>
  );
});

function ShortText({ text, max }: { text: string; max: number }): ReactNode {
  const short = shortenText(text, max);
  return short === text ? text : <TextTooltip content={text}>{short}</TextTooltip>;
}

/** Only states the switch can't show: not saved yet, hidden by Apply overrides, saved-but-identical, or filling a missing key. */
function StateBadge({ entry, touched, notApplied }: { entry: CatalogEntryView; touched: boolean; notApplied: boolean }): ReactNode {
  if (touched) {
    return (
      <Badge variant="info">
        <TextTooltip content="Changed here but not saved yet.">Unsaved</TextTooltip>
      </Badge>
    );
  }
  if (notApplied) {
    return (
      <Badge variant="warning">
        <TextTooltip content="Apply overrides is off, so the site doesn't show this override.">Not applied</TextTooltip>
      </Badge>
    );
  }
  if (entry.state === "synced") {
    return (
      <Badge variant="success">
        <TextTooltip content="Matches the current translation, so it changes nothing. Clear synced overrides removes it.">
          Synced
        </TextTooltip>
      </Badge>
    );
  }
  if (entry.state === "missing") {
    return (
      <Badge variant="warning">
        <TextTooltip content="The current translation has no value for this key; this override supplies it.">Missing</TextTooltip>
      </Badge>
    );
  }
  return null;
}

function OverrideEditor({
  entry,
  overrideEnabled,
  draft,
  touched,
  notApplied,
  working,
  inTable = false,
  onToggleOverride,
  onDraftChange,
}: CatalogRowProps & { inTable?: boolean | undefined }): ReactNode {
  // `null` follows `touched`, so generated or edited rows open and untouched ones stay one line.
  const [editing, setEditing] = useState<boolean | null>(null);
  const open = editing ?? touched;
  const dimStyle: CSSProperties = notApplied ? { opacity: 0.5 } : {};
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={dimStyle}>
        <Switch
          // The table's Override column header already names the switch.
          {...(inTable ? {} : { label: "Override" })}
          aria-label={`Enable override for ${entry.key}`}
          checked={overrideEnabled}
          disabled={working}
          onCheckedChange={(enabled) => onToggleOverride(entry, enabled)}
        />
      </div>
      {!overrideEnabled ? null : open ? (
        <Textarea
          aria-label={`Override value for ${entry.key}`}
          rows={3}
          style={inputStyle}
          value={draft}
          disabled={working}
          autoFocus={editing === true}
          onValueChange={(value) => {
            setEditing(true);
            onDraftChange(entry, value);
          }}
        />
      ) : (
        <div style={{ alignItems: "center", display: "flex", gap: 8, minWidth: 0 }}>
          <span style={{ ...mutedStyle, ...truncateStyle, ...dimStyle, flex: "1 1 0" }}>{draft.length === 0 ? "Empty" : draft}</span>
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Edit override for ${entry.key}`}
            disabled={working}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        </div>
      )}
    </div>
  );
}

function TokenHint({ source, messageSyntax }: { source: string | null; messageSyntax: CatalogViewResponse["messageSyntax"] }): ReactNode {
  if (!sourceContainsTokens(source, messageSyntax)) return null;
  const variables = messageSyntax === "icu" ? "{variables}" : "{{variables}}";
  return (
    <span style={{ display: "inline-flex", marginRight: 4, verticalAlign: "middle" }}>
      <InfoTooltip
        label={`Contains ${variables} placeholders`}
        content={`This string contains ${variables}. Overrides should retain them.`}
      />
    </span>
  );
}
