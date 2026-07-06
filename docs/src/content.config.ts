import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { docsCollection, partialsCollection } from "nimbus-docs/content";

export const collections = {
  docs: defineCollection(
    docsCollection({
      schemaFields: {
        audience: z.literal("human").optional(),
        aiGenerated: z.boolean().optional(),
      },
    }),
  ),
  partials: defineCollection(partialsCollection()),
};
