import { fetchCollection, fetchCollections } from "@emdash-cms/admin";
import { Button, Input, LayerCard, Select, Switch, Table } from "@cloudflare/kumo";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import {
  MAX_CONTENT_FIELDS,
  type BatchJobsResponse,
  type BatchJobView,
  type CollectionPolicyResponse,
  type CollectionSettingsResponse,
} from "../../../../contracts.js";
import { errorMessage, isPolicyField, localeLabel, plural, pluginPageUrl, pluginRequest } from "../../../utils.js";
import { NewWindowIcon } from "../../../components/NewWindowLink/NewWindowLink.js";
import { InfoLabel, SectionHeader } from "../../../components/PageHeader/PageHeader.js";
import { cardStyle, mutedStyle, rowStyle, sectionStyle, stackStyle } from "../../../styles.js";
import { ErrorMessage } from "../../../components/ErrorMessage/ErrorMessage.js";
import { LocalePicker } from "../../../components/LocalePicker/LocalePicker.js";
import { BatchJobs } from "./BatchJobs.js";
import { CollectionSummary } from "./CollectionSummary.js";
import { usePublicUrlContexts } from "./BatchResults.js";
import { batchJobFinished, batchRunUrl, loadItems, saveBatchRun, untranslatedLocales, type BatchItem, type ItemPage } from "./helpers.js";

const CONCURRENCY = 3;
const batchLayoutStyle: CSSProperties = { alignItems: "flex-start", display: "flex", flexWrap: "wrap", gap: 20 };
const JOB_POLL_MS = 5000;

type Scope = "all" | "selected";
type Runner = "browser" | "queue";

interface CollectionOption {
  slug: string;
  label: string;
}

interface LoadedCollection {
  policy: CollectionPolicyResponse;
  fields: string[];
}

export function BatchTab(): ReactNode {
  const [collections, setCollections] = useState<CollectionOption[] | null>(null);
  const [collection, setCollection] = useState("");
  const [loaded, setLoaded] = useState<LoadedCollection | null>(null);
  const [locales, setLocales] = useState<string[]>([]);
  const [scope, setScope] = useState<Scope>("selected");
  const [updateExisting, setUpdateExisting] = useState(false);
  const [publish, setPublish] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<ItemPage | null>(null);
  const [selected, setSelected] = useState<Map<string, BatchItem>>(new Map());
  const [running, setRunning] = useState(false);
  const [checkingLocales, setCheckingLocales] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runner, setRunner] = useState<Runner>("browser");
  const [serverJobs, setServerJobs] = useState<BatchJobsResponse | null>(null);
  const [jobsRefresh, setJobsRefresh] = useState(0);
  const urlContexts = usePublicUrlContexts();

  useEffect(() => {
    let active = true;
    pluginRequest<BatchJobsResponse>("batch/jobs")
      .then((value) => {
        if (active) setServerJobs(value);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [jobsRefresh]);

  const jobsActive = serverJobs?.jobs.some((job) => job.status === "running") ?? false;
  useEffect(() => {
    if (!jobsActive) return;
    const timer = setInterval(() => setJobsRefresh((current) => current + 1), JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [jobsActive]);

  useEffect(() => {
    let active = true;
    Promise.all([fetchCollections(), pluginRequest<CollectionSettingsResponse>("settings/collections")])
      .then(([projectCollections, settings]) => {
        if (!active) return;
        const enabled = projectCollections.filter((item) => Object.hasOwn(settings.policies, item.slug));
        setCollections(enabled.map((item) => ({ slug: item.slug, label: item.label })));
        setCollection((current) => (enabled.some((item) => item.slug === current) ? current : (enabled[0]?.slug ?? "")));
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setLoaded(null);
    setLocales([]);
    setPage(null);
    setSelected(new Map());
  }, [collection]);

  // Reloads on policy saves too, keeping the selection.
  useEffect(() => {
    if (collection.length === 0) return;
    let active = true;
    Promise.all([
      pluginRequest<CollectionPolicyResponse>(`policy?collection=${encodeURIComponent(collection)}`),
      fetchCollection(collection, true),
    ])
      .then(([policy, schema]) => {
        if (!active) return;
        const fields = schema.fields
          .filter((field) => isPolicyField(field, policy))
          .map((field) => field.slug)
          .slice(0, MAX_CONTENT_FIELDS);
        const available = policy.targetLocales.map(({ locale }) => locale);
        setLoaded({ policy, fields });
        setLocales((current) => current.filter((locale) => available.includes(locale)));
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [collection]);

  useEffect(() => {
    if (loaded === null || scope !== "selected") return;
    const { sourceLocale, targetLocales } = loaded.policy;
    if (sourceLocale === null) {
      setError("This collection has no source locale, so its entries can't be listed.");
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      loadItems(collection, sourceLocale, targetLocales, search, undefined)
        .then((next) => {
          if (active) setPage(next);
        })
        .catch((cause: unknown) => {
          if (active) setError(errorMessage(cause));
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [collection, loaded, scope, search]);

  async function loadMore(): Promise<void> {
    const sourceLocale = loaded?.policy.sourceLocale ?? null;
    if (loaded === null || sourceLocale === null || page?.nextCursor === undefined) return;
    try {
      const next = await loadItems(collection, sourceLocale, loaded.policy.targetLocales, search, page.nextCursor);
      setPage((current) => ({ items: [...(current?.items ?? []), ...next.items], nextCursor: next.nextCursor }));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function selectUntranslated(): Promise<void> {
    if (loaded === null) return;
    setCheckingLocales(true);
    setError(null);
    try {
      setLocales(await untranslatedLocales(collection, [...selected.keys()], loaded.policy.targetLocales, CONCURRENCY));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCheckingLocales(false);
    }
  }

  // Synchronous on purpose: browsers only allow a new tab straight from the click.
  function openBrowserRun(): void {
    if (loaded === null) return;
    const { policy, fields } = loaded;
    const targets = policy.targetLocales.filter(({ locale }) => locales.includes(locale));
    const items = scope === "all" ? [] : [...selected.values()];
    const options = { collection, sourceLocale: policy.sourceLocale ?? undefined, fields, updateExisting, publish };
    const runId = saveBatchRun({ collection, scope, items, targets, options, createdAt: Date.now(), localeTags: policy.localeTags });
    const url = batchRunUrl(window.location.pathname, runId);
    if (window.open(url, "_blank") === null) {
      setError(`Your browser blocked the new tab. Allow pop-ups for this site, or open ${url} yourself.`);
    }
  }

  async function startServerJob(): Promise<void> {
    const entries = scope === "all" ? "every source entry" : `${selected.size} ${selected.size === 1 ? "entry" : "entries"}`;
    if (
      !window.confirm(
        `PolyStella will queue missing translations for ${entries} into ${plural(locales.length, "locale")} on the server. They are ${publish ? "published" : "saved as drafts"} and existing translations are skipped. Continue?`,
      )
    ) {
      return;
    }
    setRunning(true);
    setError(null);
    try {
      await pluginRequest<BatchJobView>("batch/start", {
        method: "POST",
        body: JSON.stringify({ collection, locales, publish, ...(scope === "selected" ? { entryIds: [...selected.keys()] } : {}) }),
      });
      setJobsRefresh((current) => current + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunning(false);
    }
  }

  if (collections === null && error === null) return <p style={sectionStyle}>Loading collections...</p>;

  const policy = loaded?.policy;
  const visibleItems = page?.items ?? [];
  const allVisibleSelected = visibleItems.length > 0 && visibleItems.every((item) => selected.has(item.id));
  const someVisibleSelected = visibleItems.some((item) => selected.has(item.id));
  const canRun =
    !running &&
    !checkingLocales &&
    loaded !== null &&
    loaded.fields.length > 0 &&
    locales.length > 0 &&
    (scope === "all" || selected.size > 0);

  const runButton = (
    <div style={rowStyle}>
      <Button
        variant="primary"
        loading={running}
        disabled={!canRun}
        onClick={() => (runner === "queue" ? void startServerJob() : openBrowserRun())}
      >
        {runner === "queue" ? "Queue" : "Translate"} {scope === "all" ? "collection" : `${selected.size} selected`}
        {runner === "browser" ? (
          <>
            {" in a new tab"}
            <NewWindowIcon />
          </>
        ) : null}
      </Button>
    </div>
  );

  return (
    <section style={sectionStyle}>
      <SectionHeader
        title="Batch translation"
        description={`Translate many entries at once from their latest saved source values. ${
          runner === "browser"
            ? "Browser runs open in a new tab, which must stay open until the run finishes."
            : "The server queue keeps running after you close this tab."
        }`}
      />
      {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
      {collections?.length === 0 ? (
        <p style={mutedStyle}>
          Enable PolyStella for a collection first, in{" "}
          <a href={pluginPageUrl("/settings", { tab: "collections" })}>Settings, Collections</a>.
        </p>
      ) : (
        <div style={batchLayoutStyle}>
          <div style={{ ...stackStyle, flex: "1 1 340px", minWidth: 0 }}>
            <LayerCard style={cardStyle}>
              <div style={stackStyle}>
                <div style={rowStyle}>
                  <div style={{ minWidth: 220 }}>
                    <Select
                      label="Collection"
                      value={collection}
                      renderValue={(value) =>
                        collections?.find((item) => item.slug === value)?.label ?? (typeof value === "string" ? value : "")
                      }
                      disabled={running}
                      onValueChange={(value) => {
                        if (typeof value === "string") setCollection(value);
                      }}
                    >
                      {collections?.map((item) => (
                        <Select.Option key={item.slug} value={item.slug}>
                          {item.label}
                        </Select.Option>
                      ))}
                    </Select>
                  </div>
                  <div style={{ minWidth: 220 }}>
                    <Select
                      label="Entries"
                      value={scope}
                      renderValue={(value) => (value === "selected" ? "Selected entries" : "Whole collection")}
                      disabled={running}
                      onValueChange={(value) => {
                        if (value === "all" || value === "selected") setScope(value);
                      }}
                    >
                      <Select.Option value="all">Whole collection</Select.Option>
                      <Select.Option value="selected">Selected entries</Select.Option>
                    </Select>
                  </div>
                  {serverJobs?.queueEnabled === true ? (
                    <div style={{ minWidth: 220 }}>
                      <Select
                        label="Run in"
                        value={runner}
                        renderValue={(value) => (value === "queue" ? "Server queue" : "This browser")}
                        disabled={running}
                        onValueChange={(value) => {
                          if (value === "browser" || value === "queue") setRunner(value);
                        }}
                      >
                        <Select.Option value="browser">This browser</Select.Option>
                        <Select.Option value="queue">Server queue</Select.Option>
                      </Select>
                    </div>
                  ) : null}
                </div>
                {policy === undefined ? (
                  <span style={mutedStyle}>Loading collection settings...</span>
                ) : (
                  <>
                    {loaded?.fields.length === 0 ? (
                      <span style={mutedStyle}>No translatable fields are configured for this collection.</span>
                    ) : null}
                    <LocalePicker
                      legend="Target locales"
                      options={policy.targetLocales.map(({ locale, code }) => ({
                        locale,
                        label: localeLabel(locale, code),
                      }))}
                      value={locales}
                      disabled={running || checkingLocales}
                      onChange={setLocales}
                      actions={
                        scope === "selected" ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={checkingLocales}
                            disabled={running || selected.size === 0}
                            onClick={() => void selectUntranslated()}
                          >
                            Select untranslated
                          </Button>
                        ) : null
                      }
                    />
                    <Switch
                      aria-label="Publish translations immediately"
                      label={
                        <InfoLabel
                          label="Publish translations immediately"
                          info="When off, translations are saved as drafts. If publishing fails, the draft is kept and its result says why."
                        />
                      }
                      checked={publish}
                      disabled={running}
                      onCheckedChange={setPublish}
                    />
                    {runner === "browser" ? (
                      <Switch
                        aria-label="Update existing translations"
                        label={
                          <InfoLabel
                            label="Update existing translations"
                            info="Replaces the selected fields in translations that already exist. Entries edited during the run are skipped."
                          />
                        }
                        checked={updateExisting}
                        disabled={running}
                        onCheckedChange={setUpdateExisting}
                      />
                    ) : (
                      <span style={mutedStyle}>The server queue only creates missing translations; existing ones are skipped.</span>
                    )}
                  </>
                )}
              </div>
            </LayerCard>
            {runButton}
          </div>
          <div style={{ flex: "2 1 520px", minWidth: 0 }}>
            {scope === "all" && loaded !== null ? (
              <CollectionSummary
                collection={collection}
                label={collections?.find((item) => item.slug === collection)?.label ?? collection}
                policy={loaded.policy}
                fields={loaded.fields}
                locales={locales}
                updateExisting={runner === "browser" && updateExisting}
              />
            ) : null}
            {scope === "selected" && policy !== undefined ? (
              <LayerCard style={cardStyle}>
                <div style={stackStyle}>
                  <Input
                    label="Search source entries"
                    placeholder="Filter by title or slug"
                    value={search}
                    disabled={running}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  <span style={mutedStyle}>{selected.size} selected</span>
                  <Table layout="fixed">
                    <Table.Header>
                      <Table.Row>
                        <Table.CheckHead
                          label="Select all shown entries"
                          checked={allVisibleSelected}
                          indeterminate={someVisibleSelected && !allVisibleSelected}
                          disabled={running || visibleItems.length === 0}
                          style={{ width: 40 }}
                          onCheckedChange={(checked) =>
                            setSelected((current) => {
                              const next = new Map(current);
                              for (const item of visibleItems) {
                                if (checked) next.set(item.id, item);
                                else next.delete(item.id);
                              }
                              return next;
                            })
                          }
                        />
                        <Table.Head>Entry</Table.Head>
                        <Table.Head>Slug</Table.Head>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {visibleItems.map((item) => (
                        <Table.Row key={item.id}>
                          <Table.CheckCell
                            label={`Select ${item.title}`}
                            checked={selected.has(item.id)}
                            disabled={running}
                            onCheckedChange={(checked) =>
                              setSelected((current) => {
                                const next = new Map(current);
                                if (checked) next.set(item.id, item);
                                else next.delete(item.id);
                                return next;
                              })
                            }
                          />
                          <Table.Cell>{item.title}</Table.Cell>
                          <Table.Cell>{item.slug === null ? <span style={mutedStyle}>No slug</span> : <code>{item.slug}</code>}</Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                  {page === null ? <span style={mutedStyle}>Loading entries...</span> : null}
                  {page?.nextCursor === undefined ? null : (
                    <div>
                      <Button size="sm" variant="secondary" disabled={running} onClick={() => void loadMore()}>
                        Load more
                      </Button>
                    </div>
                  )}
                </div>
              </LayerCard>
            ) : null}
          </div>
        </div>
      )}
      <BatchJobs jobs={serverJobs?.jobs ?? []} urlContexts={urlContexts} onChange={() => setJobsRefresh((current) => current + 1)} />
    </section>
  );
}
