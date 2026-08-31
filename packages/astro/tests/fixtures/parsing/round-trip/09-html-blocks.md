---
title: Raw HTML blocks pass through verbatim
---

A markdown paragraph before the HTML.

<div class="callout warning">
  <p>This is a raw HTML block; remark-parse preserves it as an
  <code>html</code> node and we should round-trip it byte-for-byte.</p>
</div>

A markdown paragraph between two HTML blocks.

<details>
  <summary>Click to expand</summary>
  <p>Hidden content.</p>
</details>

A trailing markdown paragraph.
