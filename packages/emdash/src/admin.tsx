import type { ContentEditorPanelExtension } from "@emdash-cms/admin";

import { BatchRunPage } from "./admin/plugin-page/BatchRunPage.js";
import { Page } from "./admin/plugin-page/Page.js";
import { ContentEditorPanel, panelErrorMessage, panelIsVisible } from "./admin/panels/ContentEditorPanel.js";
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
  panelErrorMessage,
  sourceContainsTokens,
  storeTranslationDebug,
  takeTranslationDebug,
  TranslationProgress,
  Page,
  ContentEditorPanel,
};
export type { CatalogGroup } from "./admin/types.js";

// `/batch-run` has no sidebar entry; the Batch translation tab opens it in a new tab.
export const pages = {
  "/": Page,
  "/batch-run": BatchRunPage,
};

export const contentEditorPanels = [
  {
    id: "polystella",
    title: "PolyStella",
    component: ContentEditorPanel,
    isVisible: panelIsVisible,
    minRole: 40,
  },
] satisfies readonly ContentEditorPanelExtension[];
