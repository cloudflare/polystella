import type { ContentEditorPanelExtension } from "@emdash-cms/admin";

import { BatchRunPage } from "./admin/plugin-page/BatchRunPage.js";
import { CodeDefaultsPage } from "./admin/plugin-page/CodeDefaultsPage.js";
import { BatchPage, CatalogPage, SettingsPage } from "./admin/plugin-page/Page.js";
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
  // `Page` predates the page split and now shows Settings.
  SettingsPage as Page,
  SettingsPage,
  CatalogPage,
  BatchPage,
  ContentEditorPanel,
};
export type { CatalogGroup } from "./admin/types.js";

// Keys match ADMIN_PAGES in index.ts. `/` keeps old links working; `/batch-run` and `/code-defaults` open in a new window
// and have no sidebar entry.
export const pages = {
  "/": SettingsPage,
  "/settings": SettingsPage,
  "/catalog": CatalogPage,
  "/batch-translation": BatchPage,
  "/batch-run": BatchRunPage,
  "/code-defaults": CodeDefaultsPage,
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
