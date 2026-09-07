# Title

Allow asynchronous visibility checks for content-editor panels

## Description

Native content-editor panels can restrict themselves with `collections`, but
that filter is synchronous and fixed by the statically imported admin module.
A plugin whose enabled collections are stored in project settings cannot load
those settings before EmDash decides which panel sections to render.

The panel component can fetch its settings and return `null`, but EmDash renders
the panel section and title outside the component. This leaves an empty plugin
section on collections where the panel is disabled.

Expected behavior:

- `ContentEditorPanelExtension` supports an optional visibility function that
  receives the normal panel context.
- The function may return `boolean` or `Promise<boolean>`.
- EmDash renders the section title and component only when the result is true.
- Loading does not briefly render an empty section.
- A failed visibility check hides that panel without unmounting the editor and
  logs the plugin and panel identifiers.
- Existing `collections` and `minRole` filters remain available as fast static
  filters.

For example:

```ts
export const contentEditorPanels = [
  {
    id: "polystella",
    title: "PolyStella",
    component: PolyStellaPanel,
    isVisible: async ({ collection }) => isEnabledCollection(collection),
  },
];
```

## Steps to reproduce

1. Add a native plugin content-editor panel without a static `collections`
   list.
2. Store the plugin's enabled collection list in project-level plugin settings.
3. In the panel component, fetch those settings and return `null` when the
   current collection is disabled.
4. Open an entry from a disabled collection.
5. Observe that the plugin's empty section and title remain visible because the
   host rendered them before the component returned `null`.

## Environment

- EmDash version: `0.36.0`
- Node.js version: `22.22.3`
- Runtime: Node.js and Cloudflare Workers
- OS: macOS; the panel contract is platform-independent

## Screenshots

Attach a screenshot of the empty plugin section on a disabled collection before
submission.

## Logs / error output

Not applicable. The panel is behaving according to the current synchronous
extension contract.
