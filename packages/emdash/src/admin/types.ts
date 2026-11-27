import type { fetchCollection } from "@emdash-cms/admin";

import type { CatalogEntryView, TranslationUsage } from "../contracts.js";

export type CollectionSchema = Awaited<ReturnType<typeof fetchCollection>>;
export type SchemaField = CollectionSchema["fields"][number];

export interface TranslationProgressState {
  percent: number;
  /** What is happening now, for screen readers; also the only step when `steps` is unset. */
  label: string;
  /** Short step names, shown as a step list. */
  steps?: readonly string[] | undefined;
  /** Index into `steps` of the running step. */
  step?: number | undefined;
  /** Real counts, such as "40 of 100 keys · batch 2 of 5". */
  detail?: string | undefined;
  /** How a finished run went; unset means it all succeeded. */
  failures?: "some" | "all" | undefined;
  /** A finished run's model calls, on hover of `detail`, or of the last step without it. */
  usage?: TranslationUsage | undefined;
}

export interface CatalogGroup {
  key: string;
  title: string | null;
  entries: CatalogEntryView[];
}
