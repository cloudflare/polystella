# Title

Expose collection schema metadata to native plugin route handlers

## Description

Native plugin route handlers cannot read the active collection schema. A route
receives validated input, request metadata, the authenticated user, and plugin
services, but no collection registry or schema accessor.

The admin client can call `fetchCollection(collection, true)` to display field
choices, but a private server route cannot trust schema metadata sent back by the
browser. This blocks plugins that must enforce field policy server-side, such as
a translation action that may send only allowlisted, translatable text fields to
an external provider.

Expected behavior:

- A native plugin route can request the host-resolved schema for a known
  collection without receiving a database handle.
- The result includes field slugs, types, and `translatable` metadata matching
  the schema used by normal content validation.
- The accessor uses the active project schema and cannot read another project's
  configuration.
- Unknown collections return a typed not-found error.
- Existing route authentication, permission, and capability checks remain
  unchanged.

An accessor on `RouteContext`, for example
`ctx.schema.getCollection(collection)`, would be sufficient; the exact API is
not important.

## Steps to reproduce

1. Configure a collection with both translatable and non-translatable fields.
2. Add a native plugin with a private route that accepts the collection slug and
   selected field names.
3. In the route handler, try to resolve the collection's field definitions from
   `RouteContext` or another supported server API.
4. Observe that no collection schema accessor is available.
5. Observe that accepting field metadata from the admin client would make the
   browser, rather than EmDash, the authorization boundary.

## Environment

- EmDash version: `0.36.0`
- Node.js version: `22.22.3`
- Runtime: Node.js and Cloudflare Workers
- OS: macOS; the missing route contract is platform-independent

## Screenshots

Not applicable. This is a server-side plugin contract.

## Logs / error output

Not applicable. No runtime error is produced; the schema API is unavailable to
the route handler.
