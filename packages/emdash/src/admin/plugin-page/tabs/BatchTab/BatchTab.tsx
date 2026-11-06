import { fetchCollection, fetchCollections, fetchContentList } from "@emdash-cms/admin";
import { Button, Checkbox, Input, LayerCard, Select, Switch, Table } from "@cloudflare/kumo";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  MAX_CONTENT_FIELDS,
  type BatchJobsResponse,
  type BatchJobView,
  type CollectionPolicyResponse,
  type CollectionSettingsResponse,
} from "../../../../contracts.js";
import { errorMessage, isTranslatable, pluginRequest, supportsTranslation } from "../../../utils.js";
import { cardStyle, mutedStyle, rowStyle, sectionStyle, stackStyle } from "../../../styles.js";
import { ErrorMessage } from "../../../components/ErrorMessage/ErrorMessage.js";
import { TranslationProgress } from "../../../components/TranslationProgress/TranslationProgress.js";
import { BatchJobs } from "./BatchJobs.js";
import {
  batchJobFinished,
  entryTitle,
  planBatchJobs,
  runBatchJob,
  runBatchJobs,
  type BatchItem,
  type BatchJob,
  type BatchResult,
} from "./helpers.js";

const CONCURRENCY = 3;
const PAGE_SIZE = 50;
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

interface ItemPage {
  items: BatchItem[];
  nextCursor: string | undefined;
}

export function BatchTab(): ReactNode {
  const [collections, setCollections] = useState<CollectionOption[] | null>(null);
  const [collection, setCollection] = useState("");
  const [loaded, setLoaded] = useState<LoadedCollection | null>(null);
  const [locales, setLocales] = useState<string[]>([]);
  const [scope, setScope] = useState<Scope>("all");
  const [updateExisting, setUpdateExisting] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<ItemPage | null>(null);
  const [selected, setSelected] = useState<Map<string, BatchItem>>(new Map());
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [total, setTotal] = useState(0);
  const [results, setResults] = useState<BatchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runner, setRunner] = useState<Runner>("browser");
  const [serverJobs, setServerJobs] = useState<BatchJobsResponse | null>(null);
  const [jobsRefresh, setJobsRefresh] = useState(0);
  const stopRequested = useRef(false);

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

  const jobsActive = serverJobs?.jobs.some((job) => job.status === "running" && !batchJobFinished(job)) ?? false;
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
        setCollection(enabled[0]?.slug ?? "");
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (collection.length === 0) return;
    let active = true;
    setLoaded(null);
    setPage(null);
    setSelected(new Map());
    setResults([]);
    setTotal(0);
    Promise.all([
      pluginRequest<CollectionPolicyResponse>(`policy?collection=${encodeURIComponent(collection)}`),
      fetchCollection(collection, true),
    ])
      .then(([policy, schema]) => {
        if (!active) return;
        const fields = schema.fields
          .filter((field) => policy.fields.includes(field.slug) && supportsTranslation(field) && isTranslatable(field))
          .map((field) => field.slug)
          .slice(0, MAX_CONTENT_FIELDS);
        setLoaded({ policy, fields });
        setLocales(policy.targetLocales.map(({ locale }) => locale));
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
    let active = true;
    const timer = setTimeout(() => {
      loadItems(collection, loaded.policy.sourceLocale, search, undefined)
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

  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  async function loadMore(): Promise<void> {
    if (loaded === null || page?.nextCursor === undefined) return;
    try {
      const next = await loadItems(collection, loaded.policy.sourceLocale, search, page.nextCursor);
      setPage((current) => ({ items: [...(current?.items ?? []), ...next.items], nextCursor: next.nextCursor }));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function run(jobs: BatchJob[] | null): Promise<void> {
    if (loaded === null) return;
    const { policy, fields } = loaded;
    setError(null);
    setRunning(true);
    stopRequested.current = false;
    setStopping(false);
    try {
      let planned = jobs;
      if (planned === null) {
        const items = scope === "all" ? await loadAllItems(collection, policy.sourceLocale) : [...selected.values()];
        const targets = policy.targetLocales.filter(({ locale }) => locales.includes(locale));
        planned = planBatchJobs(items, targets);
        if (planned.length === 0) {
          setError("Nothing to translate: no source entries or no target locales selected.");
          return;
        }
        const action = updateExisting
          ? "create missing translations and replace the selected fields in existing ones"
          : "create missing translations as drafts and skip existing ones";
        if (!window.confirm(`PolyStella will ${action}: ${items.length} entries × ${targets.length} locales. Continue?`)) return;
        setResults([]);
        setTotal(planned.length);
      } else {
        // Retried rows leave the table and come back with their new outcome, so the run total stays the same.
        const retried = new Set(planned);
        setResults((current) => current.filter((result) => !retried.has(result)));
      }
      const options = { collection, sourceLocale: policy.sourceLocale ?? undefined, fields, updateExisting };
      await runBatchJobs(
        planned,
        CONCURRENCY,
        async (job) => {
          const result = await runBatchJob(job, options);
          setResults((current) => [...current, result]);
        },
        () => stopRequested.current,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunning(false);
      setStopping(false);
    }
  }

  async function startServerJob(): Promise<void> {
    const entries = scope === "all" ? "every source entry" : `${selected.size} entries`;
    if (
      !window.confirm(
        `PolyStella will queue missing translations for ${entries} into ${locales.length} locales on the server. They are saved as drafts and existing translations are skipped. Continue?`,
      )
    ) {
      return;
    }
    setRunning(true);
    setError(null);
    try {
      await pluginRequest<BatchJobView>("batch/start", {
        method: "POST",
        body: JSON.stringify({ collection, locales, ...(scope === "selected" ? { entryIds: [...selected.keys()] } : {}) }),
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
  const failed = results.filter((result) => result.outcome === "failed");
  const visibleItems = page?.items ?? [];
  const allVisibleSelected = visibleItems.length > 0 && visibleItems.every((item) => selected.has(item.id));
  const someVisibleSelected = visibleItems.some((item) => selected.has(item.id));
  const canRun = !running && loaded !== null && loaded.fields.length > 0 && locales.length > 0 && (scope === "all" || selected.size > 0);

  return (
    <section style={sectionStyle}>
      <div>
        <h2>Batch translation</h2>
        <p style={mutedStyle}>
          Translate many entries at once from their latest saved source values. New translations are saved as drafts.{" "}
          {runner === "browser" ? "Keep this tab open until the run finishes." : "The server queue keeps running after you close this tab."}
        </p>
      </div>
      {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
      {collections?.length === 0 ? (
        <p style={mutedStyle}>Enable PolyStella for a collection in the Collections tab first.</p>
      ) : (
        <LayerCard style={cardStyle}>
          <div style={stackStyle}>
            <div style={rowStyle}>
              <div style={{ minWidth: 220 }}>
                <Select
                  label="Collection"
                  value={collection}
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
                <span style={mutedStyle}>
                  Source locale: {policy.sourceLocale}. Fields:{" "}
                  {loaded?.fields.length === 0 ? "none configured" : loaded?.fields.join(", ")}
                </span>
                <Checkbox.Group
                  legend="Target locales"
                  value={locales}
                  allValues={policy.targetLocales.map(({ locale }) => locale)}
                  disabled={running}
                  onValueChange={setLocales}
                >
                  {policy.targetLocales.map(({ locale, code }) => (
                    <Checkbox.Item key={locale} value={locale} label={locale === code ? locale : `${locale} (${code})`} />
                  ))}
                </Checkbox.Group>
                {runner === "browser" ? (
                  <Switch
                    label="Update existing translations (replaces the selected fields; entries edited during the run are skipped)"
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
      )}
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
      <div style={rowStyle}>
        <Button
          variant="primary"
          loading={running}
          disabled={!canRun}
          onClick={() => void (runner === "queue" ? startServerJob() : run(null))}
        >
          {runner === "queue" ? "Queue" : "Translate"} {scope === "all" ? "collection" : `${selected.size} selected`}
        </Button>
        {running && runner === "browser" ? (
          <Button
            variant="secondary"
            disabled={stopping}
            onClick={() => {
              stopRequested.current = true;
              setStopping(true);
            }}
          >
            {stopping ? "Stopping after current entries..." : "Stop"}
          </Button>
        ) : null}
        {!running && failed.length > 0 ? (
          <Button variant="secondary" onClick={() => void run(failed)}>
            Retry {failed.length} failed
          </Button>
        ) : null}
      </div>
      {total === 0 ? null : (
        <TranslationProgress percent={Math.round((results.length / total) * 100)} label={`${results.length}/${total} translations`} />
      )}
      {results.length === 0 ? null : <BatchResultsTable results={results} />}
      <BatchJobs jobs={serverJobs?.jobs ?? []} onChange={() => setJobsRefresh((current) => current + 1)} />
    </section>
  );
}

function BatchResultsTable({ results }: { results: readonly BatchResult[] }): ReactNode {
  return (
    <div style={{ overflowX: "auto" }}>
      <Table layout="fixed" style={{ minWidth: 720 }}>
        <Table.Header>
          <Table.Row>
            <Table.Head style={{ width: "35%" }}>Entry</Table.Head>
            <Table.Head style={{ width: "15%" }}>Locale</Table.Head>
            <Table.Head style={{ width: "15%" }}>Result</Table.Head>
            <Table.Head>Details</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {results.map((result) => (
            <Table.Row key={`${result.item.id}:${result.target.locale}`}>
              <Table.Cell>{result.item.title}</Table.Cell>
              <Table.Cell>{result.target.locale}</Table.Cell>
              <Table.Cell>{result.outcome}</Table.Cell>
              <Table.Cell>
                <span style={mutedStyle}>{result.message ?? ""}</span>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

async function loadItems(collection: string, locale: string | null, search: string, cursor: string | undefined): Promise<ItemPage> {
  const query = search.trim();
  const result = await fetchContentList(collection, {
    limit: PAGE_SIZE,
    ...(locale === null ? {} : { locale }),
    ...(query.length === 0 ? {} : { search: query }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  return { items: result.items.map((item) => ({ id: item.id, title: entryTitle(item) })), nextCursor: result.nextCursor };
}

async function loadAllItems(collection: string, locale: string | null): Promise<BatchItem[]> {
  const items: BatchItem[] = [];
  let cursor: string | undefined;
  do {
    const next = await loadItems(collection, locale, "", cursor);
    items.push(...next.items);
    cursor = next.nextCursor;
  } while (cursor !== undefined);
  return items;
}
