import type { fetchCollection } from "@emdash-cms/admin";

import type { CatalogEntryView } from "../contracts.js";

export type CollectionSchema = Awaited<ReturnType<typeof fetchCollection>>;
export type SchemaField = CollectionSchema["fields"][number];

export interface TranslationProgressState {
  percent: number;
  label: string;
}

export interface CatalogGroup {
  key: string;
  title: string | null;
  entries: CatalogEntryView[];
}
