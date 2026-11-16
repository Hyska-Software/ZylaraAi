/** Declarative style recipes shared by host components and plugin variants. */
import {
  createContext,
  useContext,
  useMemo,
  type ComponentProps,
  type ReactNode,
} from 'react';

import { PLUGIN_STYLE_RECIPES, pluginComponentSpec } from '../contract';
import { useUiStore } from '@/lib/store/uiStore';
import { cn } from '@/lib/utils';
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

interface ResolvedVariant {
  component: string;
  variantId: string;
  recipe: StyleRecipe;
}

/**
 * Resolves the recipe of a host component for the active layout. The user's
 * explicit choice in Settings → Design wins over the active preset default;
 * with neither, recipes stay opt-in and the host keeps its own classes.
 */
function useVariantResolution(component: string): ResolvedVariant | null {
  const layout = useUiStore((state) => state.layoutMode);
  const prefs = usePluginUiPrefs();
  const ui = usePluginUi();
  return useMemo(() => {
    const spec = pluginComponentSpec(component);
    if (!spec || spec.variants.length === 0 || !prefs.enabled) return null;
    const presetKey = prefs.presets[layout];
    const preset = presetKey
      ? ui.presets.find(
          (entry) =>
            entry.key === presetKey &&
            (entry.layouts.length === 0 || entry.layouts.includes(layout)),
        )
      : null;
    // An explicit choice in Settings → Design wins over the preset default.
    // With neither, the host keeps its own classes: recipes are opt-in.
    const selected = prefs.variants[variantKey(component, layout)] ?? preset?.variants[component];
    if (!selected) return null;
    if (selected.startsWith('builtin:')) {
      const id = selected.slice('builtin:'.length);
      const recipe = spec.builtinRecipes?.[id];
      return recipe ? { component, variantId: id, recipe } : null;
    }
    const builtin = spec.builtinRecipes?.[selected];
    if (builtin) return { component, variantId: selected, recipe: builtin };
    const separator = selected.indexOf(':');
    const pluginId = separator > 0 ? selected.slice(0, separator) : preset?.pluginId ?? null;
    const variantId = separator > 0 ? selected.slice(separator + 1) : selected;
    const variant = ui.variants.find(
      (entry) =>
        (!pluginId || entry.pluginId === pluginId) &&
        entry.component === component &&
        entry.variantId === variantId &&
        (entry.layouts.length === 0 || entry.layouts.includes(layout)),
    );
    return variant ? { component, variantId, recipe: variant.recipe } : null;
  }, [component, layout, prefs.enabled, prefs.presets, prefs.variants, ui.presets, ui.variants]);
}

const VariantContext = createContext<ResolvedVariant | null>(null);

/** Provides one resolved recipe to host components inside a slot. */
export function VariantProvider({
  component,
  children,
}: {
  component: string;
  children: ReactNode;
}) {
  const resolved = useVariantResolution(component);
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
      className: cn(baseClassName, classes),
      variantId: resolved?.variantId ?? null,
      recipe: resolved?.recipe ?? null,
    };
  }, [baseClassName, resolved]);
}

/**
 * Host element whose skin comes from a component recipe. Keeps the host classes
 * when no variant is selected and lets callers use recipes outside a slot.
 */
export function RecipeDiv({
  component,
  className,
  children,
  ...props
}: { component: string } & ComponentProps<'div'>) {
  return (
    <VariantProvider component={component}>
      <RecipeDivBody component={component} className={className} {...props}>
        {children}
      </RecipeDivBody>
    </VariantProvider>
  );
}

function RecipeDivBody({
  component,
  className,
  children,
  ...props
}: { component: string } & ComponentProps<'div'>) {
  const style = useStyleRecipe(component, className ?? '');
  return (
    <div {...props} data-variant={style.variantId ?? undefined} className={style.className}>
      {children}
    </div>
  );
}
