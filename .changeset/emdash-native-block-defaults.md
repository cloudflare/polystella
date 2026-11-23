---
"@cloudflare/polystella-emdash": minor
---

EmDash's own Portable Text block types are now translated without configuration: image `alt`, `caption` and `title`, gallery image alt text and captions, video and embed captions, button labels, pull quotes, iframe titles, and the rich text inside `columns` and `cover` blocks. Before, they were copied in the source language unless listed in `blockFields`. A `blockFields` entry for one of these types replaces its default, and an empty list (`image: []`) keeps the old behaviour for that type. `code`, `htmlBlock` and `file` blocks are never translated.
