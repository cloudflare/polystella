import { fetchCollection, fetchCollections } from "@emdash-cms/admin";
import { Button, Checkbox, LayerCard, Switch } from "@cloudflare/kumo";
import { useEffect, useState, type ReactNode } from "react";

import { MAX_COLLECTION_POLICY_FIELDS, type CollectionSettingsResponse } from "../../../../contracts.js";
import { errorMessage, isTranslatable, pluginRequest, supportsTranslation } from "../../../utils.js";
import type { CollectionSchema } from "../../../types.js";
import { cardStyle, mutedStyle, sectionStyle, stackStyle } from "../../../styles.js";
import { ErrorMessage } from "../../../components/ErrorMessage/ErrorMessage.js";

export function CollectionsTab(): ReactNode {
  const [collections, setCollections] = useState<Awaited<ReturnType<typeof fetchCollections>>>([]);
  const [settings, setSettings] = useState<CollectionSettingsResponse | null>(null);
  const [policies, setPolicies] = useState<CollectionSettingsResponse["policies"]>({});
  const [schemas, setSchemas] = useState<Map<string, CollectionSchema>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([fetchCollections(), pluginRequest<CollectionSettingsResponse>("settings/collections")])
      .then(async ([projectCollections, value]) => {
        if (!active) return;
        const loadedSchemas = await Promise.all(
          projectCollections
            .filter((collection) => Object.hasOwn(value.policies, collection.slug))
            .map((collection) => fetchCollection(collection.slug, true)),
        );
        if (!active) return;
        const schemasBySlug = new Map(loadedSchemas.map((schema) => [schema.slug, schema]));
        const normalizedPolicies = Object.fromEntries(
          Object.entries(value.policies).flatMap(([collection, policy]) => {
            const schema = schemasBySlug.get(collection);
            if (schema === undefined) return [];
            const eligibleFields = new Set(
              schema.fields.filter((field) => supportsTranslation(field) && isTranslatable(field)).map((field) => field.slug),
            );
            const fields = policy.fields.filter((field) => eligibleFields.has(field));
            return fields.length === 0 ? [] : [[collection, { ...policy, fields }]];
          }),
        );
        setCollections(projectCollections);
        setSettings(value);
        setPolicies(normalizedPolicies);
        setSchemas(schemasBySlug);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  async function save(): Promise<void> {
    setWorking(true);
    setError(null);
    try {
      const value = await pluginRequest<CollectionSettingsResponse>("settings/collections", {
        method: "PUT",
        body: JSON.stringify({ policies }),
      });
      setSettings(value);
      setPolicies(value.policies);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  async function setCollectionEnabled(collection: string, enabled: boolean): Promise<void> {
    if (!enabled) {
      setPolicies((current) => Object.fromEntries(Object.entries(current).filter(([slug]) => slug !== collection)));
      return;
    }

    setWorking(true);
    setError(null);
    try {
      const schema = schemas.get(collection) ?? (await fetchCollection(collection, true));
      const fields = schema.fields
        .filter((field) => supportsTranslation(field) && isTranslatable(field))
        .map((field) => field.slug)
        .slice(0, MAX_COLLECTION_POLICY_FIELDS);
      if (fields.length === 0) throw new Error("This collection has no supported translatable fields.");
      setSchemas((current) => new Map(current).set(collection, schema));
      setPolicies((current) => ({
        ...current,
        [collection]: { fields },
      }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  function updateCollectionFields(collection: string, fields: string[]): void {
    setPolicies((current) => {
      if (fields.length === 0) return Object.fromEntries(Object.entries(current).filter(([slug]) => slug !== collection));
      return { ...current, [collection]: { fields } };
    });
  }

  if (settings === null && error === null) return <p style={sectionStyle}>Loading collections...</p>;

  return (
    <section style={sectionStyle}>
      <div>
        <h2>Collections</h2>
        <p style={mutedStyle}>Choose where PolyStella appears and which saved fields editors may send for translation.</p>
      </div>
      {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
      {collections.map((collection) => {
        const policy = Object.hasOwn(policies, collection.slug) ? policies[collection.slug] : undefined;
        const schema = schemas.get(collection.slug);
        const eligibleFields = schema?.fields.filter((field) => supportsTranslation(field) && isTranslatable(field)) ?? [];
        return (
          <LayerCard key={collection.slug} style={cardStyle}>
            <div style={stackStyle}>
              <Switch
                label={
                  <span>
                    <strong>{collection.label}</strong> <code>{collection.slug}</code>
                  </span>
                }
                checked={policy !== undefined}
                disabled={working}
                onCheckedChange={(enabled) => void setCollectionEnabled(collection.slug, enabled)}
              />
              {policy === undefined ? null : schema === undefined ? (
                <span style={mutedStyle}>Loading fields...</span>
              ) : (
                <>
                  <span style={mutedStyle}>Source locale: code default ({settings?.defaultLocale})</span>
                  <Checkbox.Group
                    legend="Fields available for translation"
                    value={policy.fields}
                    allValues={eligibleFields.slice(0, MAX_COLLECTION_POLICY_FIELDS).map((field) => field.slug)}
                    disabled={working}
                    onValueChange={(fields) => updateCollectionFields(collection.slug, fields)}
                  >
                    {eligibleFields.map((field) => (
                      <Checkbox.Item
                        key={field.slug}
                        value={field.slug}
                        label={`${field.label} (${field.slug})`}
                        disabled={policy.fields.length >= MAX_COLLECTION_POLICY_FIELDS && !policy.fields.includes(field.slug)}
                      />
                    ))}
                  </Checkbox.Group>
                </>
              )}
            </div>
          </LayerCard>
        );
      })}
      <div>
        <Button variant="primary" loading={working} disabled={settings === null} onClick={() => void save()}>
          Save collections
        </Button>
      </div>
    </section>
  );
}
