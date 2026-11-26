#!/usr/bin/env node
// @ts-check
// Usage: node scripts/seed-extras.mjs <origin>   (for example http://localhost:4322)
// Adds what a seed file cannot hold: SEO text on `welcome`, and a post long enough to translate in several parts.
// The origin is required and checked, because this signs in with dev-bypass and writes to whatever server answers.

import { connect, GuardError } from "./playground-client.mjs";

const argument = process.argv[2];
if (argument === undefined) {
  console.error("usage: node scripts/seed-extras.mjs <origin>, e.g. http://localhost:4322 (use the URL astro dev printed)");
  process.exit(1);
}
const { api } = await connect(argument).catch((error) => {
  if (!(error instanceof GuardError)) throw error;
  console.error(error.message);
  process.exit(1);
});

const posts = (await api("GET", "/content/posts?locale=en-US&limit=100")).items;
const welcome = posts.find((/** @type {{ slug: string }} */ post) => post.slug === "welcome");
if (welcome === undefined) {
  throw new Error("the welcome post is missing; reset the database (see the README) and open the dev-bypass URL again");
}

await api("PUT", `/content/posts/${welcome.id}`, {
  seo: {
    title: "Welcome to the PolyStella demo | EmDash",
    description: "A demo post for testing how PolyStella translates saved EmDash content, including its SEO text.",
  },
});
console.log("set SEO title and description on welcome");

if (posts.some((/** @type {{ slug: string }} */ post) => post.slug === "long-guide")) {
  console.log("long-guide already exists");
} else {
  const sentences = [
    "Review the translated text and compare it with the source.",
    "Check that links and {{name}} placeholders are unchanged.",
    "Read the heading aloud and confirm it still fits the section.",
    "Keep product names such as PolyStella and EmDash in Latin letters.",
    "Look at line breaks and spacing before you publish.",
  ];
  /** @type {unknown[]} */
  const content = [];
  // 520 paragraphs and 13 headings: over 30,000 characters, so it splits into two parts.
  for (let index = 0; index < 520; index++) {
    if (index % 40 === 0) {
      const key = `h${index}`;
      content.push({
        _type: "block",
        _key: key,
        style: "h2",
        children: [{ _type: "span", _key: `${key}s`, text: `Section ${index / 40 + 1}` }],
      });
    }
    const key = `p${index}`;
    const text = `Step ${index + 1}. ${sentences[index % sentences.length]} Take a moment before moving on.`;
    content.push({ _type: "block", _key: key, style: "normal", children: [{ _type: "span", _key: `${key}s`, text }] });
  }
  const created = await api("POST", "/content/posts", {
    slug: "long-guide",
    locale: "en-US",
    data: { title: "A long guide", excerpt: "Long enough to be translated in several parts.", content },
  });
  await api("POST", `/content/posts/${created.item.id}/publish`);
  console.log("created and published long-guide (two translation parts)");
}
