export interface MdxComponentRecipeRule {
  children?: boolean | undefined;
  props?: string[] | undefined;
}

export interface MdxRecipeFragment {
  htmlAttributes?: Record<string, string[]> | undefined;
  components?: Record<string, MdxComponentRecipeRule> | undefined;
  data?: Record<string, Record<string, string[]>> | undefined;
}

export interface ScopedMdxRecipe {
  include?: string[] | undefined;
  exclude?: string[] | undefined;
  use: MdxRecipeFragment;
}

export type MdxRecipe = MdxRecipeFragment | ScopedMdxRecipe;

export function defineMdxRecipe<T extends MdxRecipeFragment>(recipe: T): T {
  return recipe;
}

export function defineScopedMdxRecipe<T extends ScopedMdxRecipe>(recipe: T): T {
  return recipe;
}
