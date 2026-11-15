/** Declarative style recipes shared by host components and plugin variants. */
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { PLUGIN_STYLE_RECIPES, pluginComponentSpec } from '../contract';
import { useUiStore } from '@/lib/store/uiStore';
import { usePluginUi } from './registry';
import { usePluginUiPrefs, variantKey } from './prefs';
import type { StyleRecipe } from './types';

export const STYLE_RECIPE_VALUES = PLUGIN_STYLE_RECIPES;

const SURFACE: Record<string, string> = {
  background: 'bg-background',
  surface: 'bg-surface',
  'surface-raised': 'bg-surface-raised',
  'surface-hover': 'bg-surface-hover',
  'surface-active': 'bg-surface-active',
  'accent-soft': 'bg-accent-soft',
  'user-bubble': 'bg-user-bubble',
  'assistant-bubble': 'bg-assistant-bubble',
  'code-bg': 'bg-code-bg',
  transparent: 'bg-transparent',
};

const FOREGROUND: Record<string, string> = {
  foreground: 'text-foreground',
  'foreground-muted': 'text-foreground-muted',
  'foreground-subtle': 'text-foreground-subtle',
  'accent-foreground': 'text-accent-foreground',
};

const RADIUS: Record<string, string> = {
  none: 'rounded-none',
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  '2xl': 'rounded-2xl',
  full: 'rounded-full',
};

const SHADOW: Record<string, string> = {
  none: 'shadow-none',
  sm: 'shadow-sm',
  md: 'shadow-md',
  lg: 'shadow-lg',
};

const TEXT: Record<string, string> = {
  xs: 'text-xs',
  sm: 'text-sm',
  base: 'text-base',
  lg: 'text-lg',
};

const ALIGN: Record<string, string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
};

const WIDTH: Record<string, string> = {
  auto: '',
  full: 'w-full',
  prose: 'max-w-3xl',
  wide: 'max-w-5xl',
};

export function recipeClasses(recipe: StyleRecipe | null | undefined): string {
  if (!recipe) return '';
  const classes: string[] = [];
  if (recipe.surface && SURFACE[recipe.surface]) classes.push(SURFACE[recipe.surface]);
  if (recipe.foreground && FOREGROUND[recipe.foreground]) classes.push(FOREGROUND[recipe.foreground]);
  if (recipe.radius && RADIUS[recipe.radius]) classes.push(RADIUS[recipe.radius]);
  if (recipe.padding) classes.push(`p-${recipe.padding}`);
  if (recipe.gap) classes.push(`gap-${recipe.gap}`);
  if (recipe.shadow && SHADOW[recipe.shadow]) classes.push(SHADOW[recipe.shadow]);
  if (recipe.width && WIDTH[recipe.width]) classes.push(WIDTH[recipe.width]);
  if (recipe.align && ALIGN[recipe.align]) classes.push(ALIGN[recipe.align]);
  if (recipe.text && TEXT[recipe.text]) classes.push(TEXT[recipe.text]);
  return classes.join(' ');
}

interface VariantContextValue {
  component: string;
  variantId: string;
  recipe: StyleRecipe | null;
}

const VariantContext = createContext<VariantContextValue | null>(null);

export function VariantProvider({
  component,
  children,
}: {
  component: string;
  children: ReactNode;
}) {
  const layout = useUiStore((state) => state.layoutMode);
  const prefs = usePluginUiPrefs();
  const ui = usePluginUi();
  const resolved = useMemo(() => {
    const spec = pluginComponentSpec(component);
    if (!spec || spec.variants.length === 0) return null;
    const selected = prefs.variants[variantKey(component, layout)];
    if (selected?.startsWith('builtin:')) {
      const id = selected.slice('builtin:'.length);
      const recipe = spec.builtinRecipes?.[id];
      return recipe ? { component, variantId: id, recipe } : null;
    }
    if (selected) {
      const separator = selected.indexOf(':');
      const pluginId = selected.slice(0, separator);
      const variantId = selected.slice(separator + 1);
      const variant = ui.variants.find(
        (entry) =>
          entry.pluginId === pluginId &&
          entry.component === component &&
          entry.variantId === variantId &&
          (entry.layouts.length === 0 || entry.layouts.includes(layout)),
      );
      if (variant) return { component, variantId, recipe: variant.recipe };
    }
    const fallbackId = spec.variants[0];
    const fallback = fallbackId ? spec.builtinRecipes?.[fallbackId] : null;
    return fallbackId && fallback
      ? { component, variantId: fallbackId, recipe: fallback }
      : null;
  }, [component, layout, prefs.variants, ui.variants]);

  return <VariantContext.Provider value={resolved}>{children}</VariantContext.Provider>;
}

export function useStyleRecipe(
  component: string,
  baseClassName: string,
): { className: string; variantId: string | null; recipe: StyleRecipe | null } {
  const context = useContext(VariantContext);
  const resolved = context?.component === component ? context : null;
  return useMemo(() => {
    const classes = recipeClasses(resolved?.recipe);
    return {
      className: [baseClassName, classes].filter(Boolean).join(' '),
      variantId: resolved?.variantId ?? null,
      recipe: resolved?.recipe ?? null,
    };
  }, [baseClassName, resolved]);
}
