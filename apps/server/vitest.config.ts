import { defineConfig } from 'vitest/config';

const EMPTY_GLOSSARIES_ID = '\0empty-glossaries';

export default defineConfig({
  // Keeps tests hermetic: fixtures populate GLOSSARIES instead of whatever was last generated.
  plugins: [
    {
      name: 'empty-generated-glossaries',
      enforce: 'pre',
      resolveId: (id) =>
        id.endsWith('/generated/glossaries.json')
          ? EMPTY_GLOSSARIES_ID
          : undefined,
      load: (id) =>
        id === EMPTY_GLOSSARIES_ID ? 'export default {};' : undefined
    }
  ],
  test: {
    globals: true,
    environment: 'node'
  }
});
