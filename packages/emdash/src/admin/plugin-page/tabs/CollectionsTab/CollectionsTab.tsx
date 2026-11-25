import { fetchCollection, fetchCollections } from "@emdash-cms/admin";
import { Button, Checkbox, LayerCard, Switch } from "@cloudflare/kumo";
import { useEffect, useState, type ReactNode } from "react";

import { MAX_COLLECTION_POLICY_FIELDS, type CollectionPolicy, type CollectionSettingsResponse } from "../../../../contracts.js";
import {
  COLLECTIONS_SAVED_EVENT,
  defaultSubFields,
  errorMessage,
  isTranslatable,
  localeLabel,
  pluginRequest,
  supportsTranslation,
  translatableSubFields,
} from "../../../utils.js";
import type { CollectionSchema, SchemaField } from "../../../types.js";
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
            const normalized = normalizePolicy(schema, policy);
            return normalized === null ? [] : [[collection, normalized]];
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
        body: JSON.stringify({ policies, revision: settings?.revision ?? null }),
      });
      setSettings(value);
      setPolicies(value.policies);
      window.dispatchEvent(new Event(COLLECTIONS_SAVED_EVENT));
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
      const fields = eligibleFields(schema)
        .map((field) => field.slug)
        .slice(0, MAX_COLLECTION_POLICY_FIELDS);
      const policy = withFields(schema, { fields: [] }, fields, false);
      if (policy === null) throw new Error("This collection has no supported translatable fields.");
      setSchemas((current) => new Map(current).set(collection, schema));
      setPolicies((current) => ({ ...current, [collection]: policy }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  function updatePolicy(collection: string, update: (policy: CollectionPolicy) => CollectionPolicy | null): void {
    setPolicies((current) => {
      const policy = Object.hasOwn(current, collection) ? current[collection] : undefined;
      const next = policy === undefined ? null : update(policy);
      if (next === null) return Object.fromEntries(Object.entries(current).filter(([slug]) => slug !== collection));
      return { ...current, [collection]: next };
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
        const fields = schema === undefined ? [] : eligibleFields(schema);
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
                  <span style={mutedStyle}>
                    Source locale: code default ({settings === null ? "" : localeLabel(settings.defaultLocale)})
                  </span>
                  <Checkbox.Group
                    legend="Fields available for translation"
                    value={policy.fields}
                    allValues={fields.slice(0, MAX_COLLECTION_POLICY_FIELDS).map((field) => field.slug)}
                    disabled={working}
                    onValueChange={(next) => updatePolicy(collection.slug, (current) => withFields(schema, current, next))}
                  >
                    {fields.map((field) => (
                      <Checkbox.Item
                        key={field.slug}
                        value={field.slug}
                        label={`${field.label} (${field.slug})`}
                        disabled={policy.fields.length >= MAX_COLLECTION_POLICY_FIELDS && !policy.fields.includes(field.slug)}
                      />
                    ))}
                  </Checkbox.Group>
                  {fields
                    .filter((field) => field.type === "repeater" && policy.fields.includes(field.slug))
                    .map((field) => (
                      <Checkbox.Group
                        key={field.slug}
                        legend={`${field.label} subfields to translate`}
                        value={policy.subFields?.[field.slug] ?? []}
                        allValues={translatableSubFields(field).map(({ slug }) => slug)}
                        disabled={working}
                        onValueChange={(next) =>
                          updatePolicy(collection.slug, (current) => withSubFields(schema, current, field.slug, next))
                        }
                      >
                        {translatableSubFields(field).map((subField) => (
                          <Checkbox.Item key={subField.slug} value={subField.slug} label={`${subField.label} (${subField.slug})`} />
                        ))}
                      </Checkbox.Group>
                    ))}
                  {fields.some((field) => field.type === "repeater") ? (
                    <span style={mutedStyle}>
                      Repeater subfields that aren't selected are copied from the source entry. Links, IDs and author names start
                      unselected. Images translate their alt text and caption.
                    </span>
                  ) : null}
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

function eligibleFields(schema: CollectionSchema): SchemaField[] {
  return schema.fields.filter((field) => supportsTranslation(field) && isTranslatable(field));
}

/**
 * Sets the enabled fields. A newly enabled repeater starts with its default subfields; one the admin ticked by hand that has
 * none (only links or ids) starts with all of them. `null` when nothing is left.
 */
function withFields(
  schema: CollectionSchema,
  policy: CollectionPolicy,
  fields: readonly string[],
  tickedByHand = true,
): CollectionPolicy | null {
  const subFields: Record<string, string[]> = {};
  for (const field of schema.fields) {
    if (field.type !== "repeater" || !fields.includes(field.slug)) continue;
    const kept = policy.subFields !== undefined && Object.hasOwn(policy.subFields, field.slug) ? policy.subFields[field.slug] : undefined;
    const defaults = defaultSubFields(field);
    subFields[field.slug] =
      kept ?? (defaults.length > 0 || !tickedByHand ? defaults : translatableSubFields(field).map(({ slug }) => slug));
  }
  return normalizePolicy(schema, { fields: [...fields], subFields });
}

function withSubFields(schema: CollectionSchema, policy: CollectionPolicy, field: string, subFields: string[]): CollectionPolicy | null {
  const fields = subFields.length === 0 ? policy.fields.filter((slug) => slug !== field) : policy.fields;
  return normalizePolicy(schema, { fields, subFields: { ...policy.subFields, [field]: subFields } });
}

/** Drops fields and subfields the schema no longer supports, and repeaters left without subfields. */
function normalizePolicy(schema: CollectionSchema, policy: CollectionPolicy): CollectionPolicy | null {
  const fields: string[] = [];
  const subFields: Record<string, string[]> = {};
  for (const field of eligibleFields(schema)) {
    if (!policy.fields.includes(field.slug)) continue;
    if (field.type === "repeater") {
      const chosen = policy.subFields !== undefined && Object.hasOwn(policy.subFields, field.slug) ? policy.subFields[field.slug] : [];
      const kept = translatableSubFields(field)
        .map(({ slug }) => slug)
        .filter((slug) => chosen?.includes(slug) === true);
      if (kept.length === 0) continue;
      subFields[field.slug] = kept;
    }
    fields.push(field.slug);
  }
  if (fields.length === 0) return null;
  return Object.keys(subFields).length === 0 ? { fields } : { fields, subFields };
}
