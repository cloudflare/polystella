---
title: Code blocks survive untouched
---

A fenced code block with a language hint:

```ts
function greet(name: string): string {
  return `Hello, ${name}`;
}
```

A code block without a hint:

```
plain text
multiple lines
no formatting
```

Inline `code with backticks` and `code with **stars** that should NOT be parsed as formatting`.

An indented code block:

    function indented() {
      return "four-space indent";
    }

Body after the indented code.
