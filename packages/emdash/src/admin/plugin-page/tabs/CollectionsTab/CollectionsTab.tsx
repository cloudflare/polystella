import { fetchCollection, fetchCollections } from "@emdash-cms/admin";
import { Button, Checkbox, Switch } from "@cloudflare/kumo";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { MAX_COLLECTION_POLICY_FIELDS, type CollectionPolicy, type CollectionSettingsResponse } from "../../../../contracts.js";
import {
  contentTypeUrl,
  defaultSubFields,
  errorMessage,
  isTranslatable,
  plural,
  pluginRequest,
  supportsTranslation,
  translatableSubFields,
} from "../../../utils.js";
import type { CollectionSchema, SchemaField } from "../../../types.js";
import { mutedStyle, rowStyle, sectionStyle } from "../../../styles.js";
import { runBatchJobs } from "../BatchTab/helpers.js";
import { cardGridStyle, CollapsibleCard } from "../../../components/CollapsibleCard/CollapsibleCard.js";
import { ErrorMessage } from "../../../components/ErrorMessage/ErrorMessage.js";
import { NewWindowLink, visuallyHidden } from "../../../components/NewWindowLink/NewWindowLink.js";
import { SectionHeader } from "../../../components/PageHeader/PageHeader.js";

export function CollectionsTab(): ReactNode {
  const [collections, setCollections] = useState<Awaited<ReturnType<typeof fetchCollections>>>([]);
  const [settings, setSettings] = useState<CollectionSettingsResponse | null>(null);
  const [policies, setPolicies] = useState<CollectionSettingsResponse["policies"]>({});
  // The last saved policies; "Saved" shows until an edit replaces `policies`.
  const [savedPolicies, setSavedPolicies] = useState<CollectionSettingsResponse["policies"] | null>(null);
  // Field choices of collections switched off since the last save, restored when switched back on.
  const [switchedOff, setSwitchedOff] = useState<CollectionSettingsResponse["policies"]>({});
  const [schemas, setSchemas] = useState<Map<string, CollectionSchema>>(new Map());
  const [schemaErrors, setSchemaErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [working, setWorking] = useState(false);
  const [openCards, setOpenCards] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let active = true;
    setLoadError(null);
    Promise.all([fetchCollections(), pluginRequest<CollectionSettingsResponse>("settings/collections")])
      .then(async ([projectCollections, value]) => {
        if (!active) return;
        // Enabled collections first, since their policies need a schema; one failure only affects its card.
        const enabled = projectCollections.filter((collection) => Object.hasOwn(value.policies, collection.slug));
        const results = await Promise.allSettled(enabled.map((collection) => fetchCollection(collection.slug, true)));
        if (!active) return;
        const schemasBySlug = new Map<string, CollectionSchema>();
        const errors = new Map<string, string>();
        results.forEach((result, index) => {
          const slug = enabled[index]?.slug;
          if (slug === undefined) return;
          if (result.status === "fulfilled") schemasBySlug.set(slug, result.value);
          else errors.set(slug, errorMessage(result.reason));
        });
        const normalizedPolicies = Object.fromEntries(
          Object.entries(value.policies).flatMap(([collection, policy]) => {
            const schema = schemasBySlug.get(collection);
            // Keep a policy whose schema didn't load, so saving doesn't drop it.
            if (schema === undefined) return errors.has(collection) ? [[collection, policy]] : [];
            const normalized = normalizePolicy(schema, policy);
            return normalized === null ? [] : [[collection, normalized]];
          }),
        );
        setCollections(projectCollections);
        setSettings(value);
        setPolicies(normalizedPolicies);
        setSchemas(schemasBySlug);
        setSchemaErrors(errors);
        // The other schemas only tell a card it has nothing to translate; switching one on fetches it again on failure.
        const disabled = projectCollections.filter((collection) => !Object.hasOwn(value.policies, collection.slug));
        await runBatchJobs(
          disabled,
          4,
          async (collection) => {
            const schema = await fetchCollection(collection.slug, true).catch(() => null);
            if (active && schema !== null)
              setSchemas((current) => (current.has(collection.slug) ? current : new Map(current).set(collection.slug, schema)));
          },
          () => !active,
        );
      })
      .catch((cause: unknown) => {
        if (active) setLoadError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [loadAttempt]);

  async function save(): Promise<void> {
    setWorking(true);
    setSaveError(null);
    try {
      const value = await pluginRequest<CollectionSettingsResponse>("settings/collections", {
        method: "PUT",
        body: JSON.stringify({ policies, revision: settings?.revision ?? null }),
      });
      setSettings(value);
      setPolicies(value.policies);
      setSavedPolicies(value.policies);
      setSwitchedOff({});
    } catch (cause) {
      setSaveError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }

  function setCardOpen(collection: string, open: boolean): void {
    setOpenCards((current) => {
      const next = new Set(current);
      if (open) next.add(collection);
      else next.delete(collection);
      return next;
    });
  }

  async function setCollectionEnabled(collection: string, enabled: boolean): Promise<void> {
    if (!enabled) {
      const policy = Object.hasOwn(policies, collection) ? policies[collection] : undefined;
      if (policy !== undefined) setSwitchedOff((current) => ({ ...current, [collection]: policy }));
      setPolicies((current) => withoutKey(current, collection));
      return;
    }

    setWorking(true);
    setSchemaErrors((current) => withoutEntry(current, collection));
    try {
      const schema = schemas.get(collection) ?? (await fetchCollection(collection, true));
      const remembered = Object.hasOwn(switchedOff, collection) ? switchedOff[collection] : undefined;
      const fields = eligibleFields(schema)
        .map((field) => field.slug)
        .slice(0, MAX_COLLECTION_POLICY_FIELDS);
      const policy =
        (remembered === undefined ? null : normalizePolicy(schema, remembered)) ?? withFields(schema, { fields: [] }, fields, false);
      if (policy === null) throw new Error("This collection has no supported translatable fields.");
      setSchemas((current) => new Map(current).set(collection, schema));
      setPolicies((current) => ({ ...current, [collection]: policy }));
      setCardOpen(collection, true);
    } catch (cause) {
      setSchemaErrors((current) => new Map(current).set(collection, errorMessage(cause)));
    } finally {
      setWorking(false);
    }
  }

  function updatePolicy(collection: string, update: (policy: CollectionPolicy) => CollectionPolicy | null): void {
    setPolicies((current) => {
      const policy = Object.hasOwn(current, collection) ? current[collection] : undefined;
      const next = policy === undefined ? null : update(policy);
      if (next === null) return withoutKey(current, collection);
      return { ...current, [collection]: next };
    });
  }

  if (settings === null && loadError === null) return <p style={sectionStyle}>Loading collections...</p>;

  return (
    <section style={sectionStyle}>
      <SectionHeader
        title="Collections"
        description="Choose where PolyStella appears and which saved fields editors may send for translation."
      />
      {loadError === null ? null : (
        <>
          <ErrorMessage>{loadError}</ErrorMessage>
          <div>
            <Button variant="secondary" onClick={() => setLoadAttempt((current) => current + 1)}>
              Retry
            </Button>
          </div>
        </>
      )}
      <div style={cardGridStyle}>
        {collections.map((collection) => {
          const policy = Object.hasOwn(policies, collection.slug) ? policies[collection.slug] : undefined;
          const schema = schemas.get(collection.slug);
          const schemaError = schemaErrors.get(collection.slug);
          const fields = schema === undefined ? [] : eligibleFields(schema);
          const nothingToTranslate = schema !== undefined && fields.length === 0;
          return (
            <CollapsibleCard
              key={collection.slug}
              label={collection.label}
              open={openCards.has(collection.slug)}
              onOpenChange={(open) => setCardOpen(collection.slug, open)}
              header={
                <>
                  <Switch
                    label={
                      <span>
                        <strong>{collection.label}</strong> <code>{collection.slug}</code>
                      </span>
                    }
                    checked={policy !== undefined}
                    disabled={working || (nothingToTranslate && policy === undefined)}
                    onCheckedChange={(enabled) => void setCollectionEnabled(collection.slug, enabled)}
                  />
                  <NewWindowLink href={contentTypeUrl(collection.slug)} title={`Edit ${collection.label} in Content types`}>
                    <span style={visuallyHidden}>Edit {collection.label} in Content types</span>
                  </NewWindowLink>
                  {nothingToTranslate ? (
                    <small style={mutedStyle}>No fields PolyStella can translate. Add a text, rich text or repeater field first.</small>
                  ) : null}
                  {schemaError === undefined ? null : (
                    <small style={dangerStyle}>Couldn't load this collection's fields: {schemaError}</small>
                  )}
                </>
              }
            >
              {policy === undefined || schemaError !== undefined ? null : schema === undefined ? (
                <span style={mutedStyle}>Loading fields...</span>
              ) : (
                <>
                  <Checkbox.Group
                    legend="Translate these fields"
                    description={
                      fields.length > MAX_COLLECTION_POLICY_FIELDS
                        ? `${plural(policy.fields.length, "field")} selected. A collection can have up to ${MAX_COLLECTION_POLICY_FIELDS} translated fields, so the rest turn off at that limit.`
                        : `${plural(policy.fields.length, "field")} selected.`
                    }
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
                        description="Unselected subfields are copied from the source entry. Links, IDs and author names start unselected. Images translate their alt text and caption."
                        {...optionalError(identifierWarning(field, policy.subFields?.[field.slug] ?? []))}
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
                </>
              )}
            </CollapsibleCard>
          );
        })}
      </div>
      {saveError === null ? null : <ErrorMessage>{saveError}</ErrorMessage>}
      <div style={rowStyle}>
        <Button variant="primary" loading={working} disabled={settings === null} onClick={() => void save()}>
          Save collections
        </Button>
        <small role="status" style={mutedStyle}>
          {policies === savedPolicies ? "Saved" : null}
        </small>
      </div>
    </section>
  );
}

const dangerStyle: CSSProperties = { color: "var(--color-kumo-danger, #b91c1c)" };

/** Warns when chosen subfields look like a link, ID or name, which a translation would break. */
function identifierWarning(field: SchemaField, chosen: readonly string[]): string | undefined {
  const defaults = defaultSubFields(field);
  const identifiers = translatableSubFields(field)
    .filter(({ slug }) => chosen.includes(slug) && !defaults.includes(slug))
    .map(({ label }) => label);
  if (identifiers.length === 0) return undefined;
  const one = identifiers.length === 1;
  return `${identifiers.join(", ")} ${one ? "looks" : "look"} like a link, ID or name. Translating ${one ? "it" : "them"} can break links and references; untick unless the text is meant to be read.`;
}

function optionalError(error: string | undefined): { error?: string } {
  return error === undefined ? {} : { error };
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([slug]) => slug !== key));
}

function withoutEntry<T>(map: ReadonlyMap<string, T>, key: string): ReadonlyMap<string, T> {
  const next = new Map(map);
  next.delete(key);
  return next;
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
