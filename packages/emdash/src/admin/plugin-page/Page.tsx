import { Tabs } from "@cloudflare/kumo";
import { useState, type ReactNode } from "react";

import { pageStyle, tabLabelStyle, titleStyle } from "../styles.js";
import { CatalogTab } from "./tabs/CatalogTab/CatalogTab.js";
import { CollectionsTab } from "./tabs/CollectionsTab/CollectionsTab.js";
import { SandboxTab } from "./tabs/SandboxTab/SandboxTab.js";
import { TranslationSettingsTab } from "./tabs/TranslationSettingsTab/TranslationSettingsTab.js";

type AdminTab = "catalog" | "collections" | "translation" | "sandbox";

export function Page(): ReactNode {
  const [activeTab, setActiveTab] = useState<AdminTab>("catalog");
  return (
    <main style={pageStyle}>
      <h1 style={titleStyle}>PolyStella - Settings</h1>
      <Tabs
        variant="underline"
        tabs={[
          { value: "catalog", label: <span style={tabLabelStyle}>Catalog</span> },
          { value: "collections", label: <span style={tabLabelStyle}>Collections</span> },
          { value: "translation", label: <span style={tabLabelStyle}>Translation settings</span> },
          { value: "sandbox", label: <span style={tabLabelStyle}>Sandbox</span> },
        ]}
        value={activeTab}
        onValueChange={(value) => {
          if (value === "catalog" || value === "collections" || value === "translation" || value === "sandbox") setActiveTab(value);
        }}
      />
      <div hidden={activeTab !== "catalog"}>
        <CatalogTab />
      </div>
      <div hidden={activeTab !== "collections"}>
        <CollectionsTab />
      </div>
      <div hidden={activeTab !== "translation"}>
        <TranslationSettingsTab />
      </div>
      <div hidden={activeTab !== "sandbox"}>
        <SandboxTab />
      </div>
    </main>
  );
}
