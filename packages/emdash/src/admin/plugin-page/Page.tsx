import { Tabs } from "@cloudflare/kumo";
import { useState, type ReactNode } from "react";

import { PageTitle } from "../components/PageHeader/PageHeader.js";
import { pageStyle, tabLabelStyle } from "../styles.js";
import { isSettingsTab, type SettingsTab } from "../utils.js";
import { BatchTab } from "./tabs/BatchTab/BatchTab.js";
import { CatalogTab } from "./tabs/CatalogTab/CatalogTab.js";
import { CollectionsTab } from "./tabs/CollectionsTab/CollectionsTab.js";
import { SandboxTab } from "./tabs/SandboxTab/SandboxTab.js";
import { TranslationSettingsTab } from "./tabs/TranslationSettingsTab/TranslationSettingsTab.js";

/** Translation settings, Collections and Sandbox; `?tab=` picks the tab, so other pages can link to one. */
export function SettingsPage(): ReactNode {
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    return isSettingsTab(tab) ? tab : "translation";
  });
  function selectTab(tab: SettingsTab): void {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(window.history.state, "", url);
  }
  return (
    <main style={pageStyle}>
      <PageTitle>PolyStella</PageTitle>
      <Tabs
        variant="underline"
        tabs={[
          { value: "translation", label: <span style={tabLabelStyle}>Translation settings</span> },
          { value: "collections", label: <span style={tabLabelStyle}>Collections</span> },
          { value: "sandbox", label: <span style={tabLabelStyle}>Sandbox</span> },
        ]}
        value={activeTab}
        onValueChange={(value) => {
          if (isSettingsTab(value)) selectTab(value);
        }}
      />
      <div role="tabpanel" aria-label="Translation settings" hidden={activeTab !== "translation"}>
        <TranslationSettingsTab />
      </div>
      <div role="tabpanel" aria-label="Collections" hidden={activeTab !== "collections"}>
        <CollectionsTab />
      </div>
      <div role="tabpanel" aria-label="Sandbox" hidden={activeTab !== "sandbox"}>
        <SandboxTab visible={activeTab === "sandbox"} />
      </div>
    </main>
  );
}

export function CatalogPage(): ReactNode {
  return (
    <main style={pageStyle}>
      <PageTitle>PolyStella</PageTitle>
      <CatalogTab />
    </main>
  );
}

export function BatchPage(): ReactNode {
  return (
    <main style={pageStyle}>
      <PageTitle>PolyStella</PageTitle>
      <BatchTab />
    </main>
  );
}
