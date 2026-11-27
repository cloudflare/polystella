import { fetchCollection, fetchCollections } from "@emdash-cms/admin";
import { Button, Checkbox, LayerCard, Popover, Switch } from "@cloudflare/kumo";
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";

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
import { mutedStyle, rowStyle, sectionStyle, stackStyle, SWITCH_ON_CLASS } from "../../../styles.js";
import { runBatchJobs } from "../BatchTab/helpers.js";
import { ErrorMessage } from "../../../components/ErrorMessage/ErrorMessage.js";
import { NewWindowLink, visuallyHidden } from "../../../components/NewWindowLink/NewWindowLink.js";
import { InfoTooltip, SectionHeader, TextTooltip } from "../../../components/PageHeader/PageHeader.js";
import { FieldChips } from "../../../components/FieldChips/FieldChips.js";

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
      setCardOpen(collection, false);
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

  /** Picking a field of a switched-off collection, such as after Clear all, switches it back on. */
  function updatePolicy(collection: string, update: (policy: CollectionPolicy) => CollectionPolicy | null): void {
    setPolicies((current) => {
      const policy = Object.hasOwn(current, collection) ? current[collection] : undefined;
      const next = update(policy ?? { fields: [] });
      if (next === null) return withoutKey(current, collection);
      return { ...current, [collection]: next };
    });
  }

  if (settings === null && loadError === null) return <p style={sectionStyle}>Loading collections...</p>;

  // Grouped by the saved policies, so a row stays put while it's switched on or off before saving.
  const savedEnabled = (slug: string) => settings !== null && Object.hasOwn(settings.policies, slug);
  const groups = [
    { title: "Enabled", saved: true, collections: collections.filter(({ slug }) => savedEnabled(slug)) },
    { title: "Disabled", saved: false, collections: collections.filter(({ slug }) => !savedEnabled(slug)) },
  ];

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
      {groups.map((group) =>
        group.collections.length === 0 ? null : (
          <div key={group.title} style={groupStyle}>
            <h3 style={groupTitleStyle}>
              {group.title} <span style={mutedStyle}>{group.collections.length}</span>
            </h3>
            <LayerCard style={{ overflow: "hidden", padding: 0 }}>
              <ul style={listStyle}>
                {group.collections.map((collection, index) => {
                  const schema = schemas.get(collection.slug);
                  return (
                    <CollectionRow
                      key={collection.slug}
                      collection={collection}
                      saved={group.saved}
                      first={index === 0}
                      policy={Object.hasOwn(policies, collection.slug) ? policies[collection.slug] : undefined}
                      fields={schema === undefined ? undefined : eligibleFields(schema)}
                      schemaError={schemaErrors.get(collection.slug)}
                      open={openCards.has(collection.slug)}
                      working={working}
                      onEnabledChange={(enabled) => void setCollectionEnabled(collection.slug, enabled)}
                      onOpenChange={(open) => setCardOpen(collection.slug, open)}
                      onFieldsChange={(next) => {
                        if (schema !== undefined) updatePolicy(collection.slug, (current) => withFields(schema, current, next));
                      }}
                      onSubFieldsChange={(field, next) => {
                        if (schema !== undefined) updatePolicy(collection.slug, (current) => withSubFields(schema, current, field, next));
                      }}
                    />
                  );
                })}
              </ul>
            </LayerCard>
          </div>
        ),
      )}
      {saveError === null ? null : <ErrorMessage>{saveError}</ErrorMessage>}
      <div style={{ ...rowStyle, justifyContent: "flex-end" }}>
        <small role="status" style={mutedStyle}>
          {policies === savedPolicies ? "Saved" : null}
        </small>
        <Button variant="primary" loading={working} disabled={settings === null} onClick={() => void save()}>
          Save collections
        </Button>
      </div>
    </section>
  );
}

/**
 * One collection in the Collections tab. `saved` puts it in the Enabled list, which shows its fields as chips; Edit opens
 * them as toggle chips. `fields` are the collection's translatable fields, `undefined` until its schema loads.
 */
export function CollectionRow({
  collection,
  saved,
  first,
  policy,
  fields,
  schemaError,
  open,
  working,
  onEnabledChange,
  onOpenChange,
  onFieldsChange,
  onSubFieldsChange,
}: {
  collection: { slug: string; label: string };
  saved: boolean;
  first: boolean;
  policy: CollectionPolicy | undefined;
  fields: readonly SchemaField[] | undefined;
  schemaError: string | undefined;
  open: boolean;
  working: boolean;
  onEnabledChange(enabled: boolean): void;
  onOpenChange(open: boolean): void;
  onFieldsChange(fields: string[]): void;
  onSubFieldsChange(field: string, subFields: string[]): void;
}): ReactNode {
  const editorId = useId();
  const nothingToTranslate = fields !== undefined && fields.length === 0;
  const editable = fields !== undefined && fields.length > 0 && schemaError === undefined;
  // After Clear all the policy is gone but the editor stays open, so a field can be picked again.
  const showEditor = open && schemaError === undefined && (policy !== undefined || editable);
  const selected = policy?.fields ?? [];
  const fieldLabel = (slug: string) => fields?.find((field) => field.slug === slug)?.label ?? slug;
  const hiddenChips = selected.slice(MAX_SUMMARY_CHIPS).map(fieldLabel);
  const subFieldCountLabel = (field: SchemaField) =>
    `${field.label} · ${(policy?.subFields?.[field.slug] ?? []).length}/${translatableSubFields(field).length}`;

  return (
    <li style={first ? undefined : dividerStyle}>
      <div style={collectionRowStyle}>
        <Switch
          label={
            <span>
              {saved ? <strong>{collection.label}</strong> : collection.label} <code style={slugStyle}>{collection.slug}</code>
            </span>
          }
          checked={policy !== undefined}
          disabled={working || (nothingToTranslate && policy === undefined)}
          onCheckedChange={onEnabledChange}
        />
        {saved && selected.length > 0 ? (
          <span style={chipRowStyle}>
            {selected.slice(0, MAX_SUMMARY_CHIPS).map((slug) => (
              <span key={slug} style={summaryChipStyle}>
                {fieldLabel(slug)}
              </span>
            ))}
            {hiddenChips.length === 0 ? null : (
              <span style={{ ...summaryChipStyle, ...mutedStyle }}>
                <TextTooltip
                  content={hiddenChips.join(", ")}
                  label={`${plural(hiddenChips.length, "more field")}: ${hiddenChips.join(", ")}`}
                >
                  {`+${hiddenChips.length}`}
                </TextTooltip>
              </span>
            )}
          </span>
        ) : null}
        <span style={rowActionsStyle}>
          <NewWindowLink href={contentTypeUrl(collection.slug)} title={`Edit ${collection.label} in Content types`}>
            <span style={visuallyHidden}>Edit {collection.label} in Content types</span>
          </NewWindowLink>
          {editable && (policy !== undefined || open) ? (
            <button
              type="button"
              style={linkButtonStyle}
              aria-expanded={open}
              aria-controls={open ? editorId : undefined}
              onClick={() => onOpenChange(!open)}
            >
              {open ? "Close" : "Edit"}
              <span style={visuallyHidden}> {collection.label} fields</span>
              {open ? <CaretUpIcon size={12} aria-hidden="true" /> : <CaretDownIcon size={12} aria-hidden="true" />}
            </button>
          ) : null}
        </span>
      </div>
      {nothingToTranslate ? (
        <small style={{ ...mutedStyle, ...rowNoteStyle }}>
          No fields PolyStella can translate. Add a text, rich text or repeater field first.
        </small>
      ) : null}
      {schemaError === undefined ? null : (
        <small style={{ ...dangerStyle, ...rowNoteStyle }}>Couldn't load this collection's fields: {schemaError}</small>
      )}
      {!showEditor ? null : fields === undefined ? (
        <div id={editorId} style={editorStyle}>
          <span style={mutedStyle}>Loading fields...</span>
        </div>
      ) : (
        <div id={editorId} style={editorStyle}>
          <FieldChips
            labelStyle={fieldsLabelStyle}
            options={fields.map((field) => ({
              slug: field.slug,
              label: field.type === "repeater" && selected.includes(field.slug) ? subFieldCountLabel(field) : field.label,
              disabled: false,
              title: field.slug,
            }))}
            selected={selected}
            disabled={working}
            max={MAX_COLLECTION_POLICY_FIELDS}
            description={
              fields.length > MAX_COLLECTION_POLICY_FIELDS
                ? `A collection can have up to ${MAX_COLLECTION_POLICY_FIELDS} translated fields, so the rest turn off at that limit.`
                : undefined
            }
            onChange={onFieldsChange}
            trailing={(option, pressed) => {
              const field = fields.find(({ slug }) => slug === option.slug);
              return field?.type === "repeater" && pressed ? (
                <SubFieldsPopover
                  field={field}
                  chosen={policy?.subFields?.[field.slug] ?? []}
                  disabled={working}
                  onChange={(next) => onSubFieldsChange(field.slug, next)}
                />
              ) : null;
            }}
          />
        </div>
      )}
    </li>
  );
}

/** The caret half of a selected repeater's chip, opening its subfields. */
function SubFieldsPopover({
  field,
  chosen,
  disabled,
  onChange,
}: {
  field: SchemaField;
  chosen: readonly string[];
  disabled: boolean;
  onChange(subFields: string[]): void;
}): ReactNode {
  const titleId = useId();
  const warning = identifierWarning(field, chosen);
  return (
    <Popover.Root>
      <Popover.Trigger
        disabled={disabled}
        aria-label={`${field.label} subfields${warning === undefined ? "" : " (needs a look)"}`}
        className={SWITCH_ON_CLASS}
        style={{ ...caretChipStyle, ...(disabled ? { cursor: "not-allowed", opacity: 0.5 } : {}) }}
      >
        {warning === undefined ? null : <span aria-hidden="true" style={warningDotStyle} />}
        <CaretDownIcon size={12} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start">
          <Popover.Popup aria-labelledby={titleId} style={{ maxWidth: 360, minWidth: 240 }}>
            <SubFieldPicker titleId={titleId} field={field} chosen={chosen} disabled={disabled} onChange={onChange} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A repeater's subfields as checkboxes; unticking the last one turns the repeater off. */
export function SubFieldPicker({
  titleId,
  field,
  chosen,
  disabled,
  onChange,
}: {
  titleId?: string | undefined;
  field: SchemaField;
  chosen: readonly string[];
  disabled: boolean;
  onChange(subFields: string[]): void;
}): ReactNode {
  const subFields = translatableSubFields(field);
  const all = subFields.map(({ slug }) => slug);
  const warning = identifierWarning(field, chosen);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ ...rowStyle, gap: 8, justifyContent: "space-between" }}>
        <span style={{ alignItems: "center", display: "inline-flex", gap: 6 }}>
          <strong id={titleId}>{field.label} subfields</strong>
          <InfoTooltip
            label={`About ${field.label} subfields`}
            content="Subfields you don't pick are copied from the source entry. Links, IDs and author names start off. Images translate their alt text and caption."
          />
        </span>
        {all.length > 3 ? (
          <span style={{ display: "inline-flex", gap: 4 }}>
            <Button size="sm" variant="ghost" disabled={disabled || chosen.length === all.length} onClick={() => onChange(all)}>
              Select all
            </Button>
            <Button size="sm" variant="ghost" disabled={disabled || chosen.length === 0} onClick={() => onChange([])}>
              Clear all
            </Button>
          </span>
        ) : null}
      </div>
      <Checkbox.Group value={[...chosen]} allValues={all} disabled={disabled} onValueChange={onChange}>
        {subFields.map((subField) => (
          <Checkbox.Item key={subField.slug} value={subField.slug} label={subField.label} />
        ))}
      </Checkbox.Group>
      {warning === undefined ? null : <small style={warningStyle}>{warning}</small>}
    </div>
  );
}

const MAX_SUMMARY_CHIPS = 3;
const SWITCH_WIDTH = 36;
const ROW_PADDING = 16;

const groupStyle: CSSProperties = { display: "grid", gap: 10 };
const groupTitleStyle: CSSProperties = { fontSize: 15, margin: 0 };
const listStyle: CSSProperties = { display: "grid", listStyle: "none", margin: 0, padding: 0 };
const dividerStyle: CSSProperties = { borderTop: "1px solid var(--color-kumo-line, #ececef)" };
const collectionRowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
  padding: `12px ${ROW_PADDING}px`,
};
const rowActionsStyle: CSSProperties = { alignItems: "center", display: "flex", gap: 16, marginLeft: "auto" };
const rowNoteStyle: CSSProperties = { display: "block", padding: `0 ${ROW_PADDING}px 12px ${ROW_PADDING + SWITCH_WIDTH + 8}px` };
const slugStyle: CSSProperties = { ...mutedStyle, fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: "0.9em" };
const chipRowStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6 };
const chipBaseStyle: CSSProperties = { borderRadius: 999, borderStyle: "solid", borderWidth: 1, fontSize: 13, lineHeight: "20px" };
const summaryChipStyle: CSSProperties = { ...chipBaseStyle, borderColor: "var(--color-kumo-line, #d4d4d8)", padding: "1px 10px" };
const linkButtonStyle: CSSProperties = {
  alignItems: "center",
  background: "none",
  border: 0,
  color: "inherit",
  cursor: "pointer",
  display: "inline-flex",
  gap: 4,
  padding: 0,
  textDecorationLine: "underline",
  textDecorationStyle: "dotted",
  textUnderlineOffset: 3,
};
const editorStyle: CSSProperties = {
  ...stackStyle,
  background: "var(--color-kumo-tint, #f7f7f8)",
  borderTop: "1px solid var(--color-kumo-line, #ececef)",
  padding: `14px ${ROW_PADDING}px 16px ${ROW_PADDING + SWITCH_WIDTH + 8}px`,
};

const fieldsLabelStyle: CSSProperties = { fontSize: 13, fontWeight: 600 };
// Stretches to the chip's height beside it, so the caret stays centred whatever the chip's size.
const caretChipStyle: CSSProperties = {
  alignItems: "center",
  border: "1px solid transparent",
  borderEndEndRadius: 999,
  borderEndStartRadius: 0,
  borderInlineStart: "1px solid rgb(255 255 255 / 0.35)",
  borderStartEndRadius: 999,
  borderStartStartRadius: 0,
  cursor: "pointer",
  display: "inline-flex",
  gap: 4,
  paddingInline: "7px 9px",
};
const warningDotStyle: CSSProperties = {
  background: "var(--color-kumo-warning, #d97706)",
  borderRadius: "50%",
  boxShadow: "0 0 0 1.5px #fff",
  height: 7,
  width: 7,
};
const warningStyle: CSSProperties = { color: "var(--color-kumo-warning, #b45309)" };
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
