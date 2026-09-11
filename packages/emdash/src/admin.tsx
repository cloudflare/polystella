import type { ContentEditorPanelExtension } from "@emdash-cms/admin";

import { Page } from "./admin/plugin-page/Page.js";
import { ContentEditorPanel } from "./admin/panels/ContentEditorPanel.js";
import { TranslationProgress } from "./admin/components/TranslationProgress/TranslationProgress.js";
import {
  catalogOverrideChanged,
  filterCatalogGroups,
  groupCatalogEntries,
  sourceContainsTokens,
} from "./admin/plugin-page/tabs/CatalogTab/helpers.js";
import { formatErrorDetails, isTranslationDebugTrace, storeTranslationDebug, takeTranslationDebug } from "./admin/utils.js";

export {
  catalogOverrideChanged,
  filterCatalogGroups,
  formatErrorDetails,
  groupCatalogEntries,
  isTranslationDebugTrace,
  sourceContainsTokens,
  storeTranslationDebug,
  takeTranslationDebug,
  TranslationProgress,
  Page,
  ContentEditorPanel,
};
export type { CatalogGroup } from "./admin/types.js";

export const pages = {
  "/": Page,
};

export const contentEditorPanels = [
  {
    id: "polystella",
    title: "PolyStella",
    component: ContentEditorPanel,
    minRole: 40,
  },
] satisfies readonly ContentEditorPanelExtension[];
