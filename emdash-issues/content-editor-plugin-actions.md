# Title

Allow plugin actions to read and patch the current content-editor draft

## Description

Plugins cannot add an action to the content editor that reads multiple current
draft fields and returns changes to those fields for review.

Field widgets can read and update one field only. Native content-editor panels
receive the last saved entry rather than the current form state. Block Kit can
render plugin-owned pages and widgets, but it has no content-editor placement or
response type for updating the open draft. `content:beforeSave` runs after a save
has begun, so it cannot provide an interactive review step.

This blocks workflows such as a translation plugin that should:

1. Let EmDash's existing **Translate** action create and open the target-locale
   draft.
2. Add **Translate with provider** inside that editor.
3. Read the current values of eligible text fields.
4. Return a schema-valid field patch.
5. Update the visible form without directly saving it.

Expected behavior:

- Plugins can declare a server-handled content-editor action for selected
  collections.
- Native panels can invoke the action by ID.
- Sandboxed plugins receive a host-rendered Block Kit placement using existing
  buttons, confirmation, loading, error, and toast behavior.
- EmDash resolves collection schema, entry ownership, locale, and permissions on
  the server rather than trusting those values from the browser.
- The handler receives the entry identity, saved locale, permitted current field
  values, and server-resolved field definitions.
- A returned patch can change multiple known, permitted fields.
- EmDash validates patched values against the collection schema and applies them
  to in-memory editor state without directly calling save.
- System fields, non-translatable fields, and values absent from the patch remain
  unchanged.
- Fields edited while the action is running are not overwritten by a stale
  response.
- Failures and invalid patches leave the form unchanged.
- Normal dirty-state, autosave, and explicit save behavior remains unchanged.
- The action uses the same resource and locale edit authorization as the content
  editor and does not require `plugins:manage`.
- Sandboxed handlers run through the existing capability-gated bridge and
  resource limits without receiving database handles or host bindings.

Related context:

- [#2227](https://github.com/emdash-cms/emdash/issues/2227) added full-document
  context for native editor panels, but the current API remains read-only and
  does not cover Block Kit or current unsaved form changes.
- [Content editor panels](https://docs.emdashcms.com/plugins/creating-native-plugins/react-admin/#content-editor-panels)
- [Block Kit](https://docs.emdashcms.com/plugins/creating-plugins/block-kit/)
- [Plugin capabilities](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/)

## Steps to reproduce

1. Configure EmDash i18n with at least two locales and create a content
   collection with multiple translatable text fields.
2. Add a plugin with a native content-editor panel or a sandboxed Block Kit admin
   route.
3. Create and open a target-locale draft with EmDash's existing **Translate**
   action.
4. Try to add a plugin action that reads the current values of several fields and
   returns updates to those fields without saving.
5. Observe that native panels receive only the last saved entry and cannot patch
   editor state, while Block Kit has no content-editor action placement.

## Environment

- emdash version: current `main` (tested checkout reports `0.29.0`)
- Node.js version: `22.22.3`
- Runtime: Node.js and Cloudflare Workers
- OS: macOS; the missing plugin contract is platform-independent

## Screenshots

Attach a screenshot of the content editor sidebar showing the available native
panel area and absence of a Block Kit plugin-action placement before submission.

## Logs / error output

Not applicable. This is a missing plugin extension contract rather than a runtime
error.
