/**
 * Loader tipado do contrato da UI generativa.
 *
 * A **única fonte de verdade** é `data/genui-contract.json`, lida aqui pelo
 * renderer e embutida no backend Rust via `include_str!`. Tipos de componente,
 * props, limites, ícones, regras de design e semântica das ações vêm todos
 * desse arquivo: se o contrato mudar, os dois lados mudam juntos (os testes de
 * paridade em `data/genui-fixtures.json` garantem o comportamento idêntico).
 */
import rawContract from '@data/genui-contract.json';
import type { GenUIValue } from './types';

export type GenUIPropType = 'text' | 'number' | 'boolean' | 'enum' | 'icon' | 'url' | 'imageSrc' | 'array';

export interface GenUIItemSpec {
  type: 'text' | 'number' | 'scalar' | 'object' | 'array';
  maxChars?: number;
  min?: number;
  max?: number;
  minItems?: number;
  maxItems?: number;
  props?: Record<string, GenUIPropSpec>;
  item?: GenUIItemSpec;
}

export interface GenUIArraySpec {
  type: 'array';
  minItems: number;
  maxItems: number;
  item: GenUIItemSpec;
}

export interface GenUIPropSpec {
  type: GenUIPropType;
  required?: boolean;
  maxChars?: number;
  min?: number;
  max?: number;
  values?: string[];
  default?: GenUIValue;
  items?: GenUIArraySpec;
}

export type GenUIComponentKind = 'leaf' | 'container';
export type GenUIComponentCategory = 'layout' | 'data' | 'content' | 'interaction' | 'plugin';

export interface GenUIComponentSpec {
  type: string;
  kind: GenUIComponentKind;
  category: GenUIComponentCategory;
  summary: string;
  /** Linha usada no catálogo do system prompt (contrato exato das props). */
  doc: string;
  acceptsChildren: boolean;
  props: Record<string, GenUIPropSpec>;
}

export type GenUIDesignRuleCategory = 'structure' | 'data' | 'copy' | 'interaction' | 'a11y';
export type GenUIDesignRuleScope = 'block' | 'message';

export interface GenUIDesignRule {
  id: string;
  severity: 'error' | 'warning';
  scope: GenUIDesignRuleScope;
  category: GenUIDesignRuleCategory;
  params?: Record<string, number>;
  message: string;
  hint: string;
  /** Regra curta e imperativa usada no system prompt. */
  prompt: string;
}

export interface GenUIActionKindSpec {
  kind: 'prompt' | 'copy';
  label: string;
  description: string;
  maxChars: number;
}

export interface GenUIContract {
  version: number;
  name: string;
  description: string;
  /** Introdução voltada ao modelo, usada no system prompt (não é metainformação). */
  promptIntro: string;
  format: { root: string; version: number; notes: string[] };
  blocks: { maxPerMessage: number; recommendedPerMessage: number };
  limits: {
    sourceChars: number;
    depth: number;
    nodes: number;
    props: number;
    arrayItems: number;
    stringChars: number;
    diagnosticsPerCode: number;
  };
  icons: string[];
  interactions: { description: string; actionKinds: GenUIActionKindSpec[]; rules: string[] };
  components: GenUIComponentSpec[];
  rules: GenUIDesignRule[];
}

export const GENUI_CONTRACT = rawContract as unknown as GenUIContract;
export const GENUI_COMPONENTS: readonly GenUIComponentSpec[] = GENUI_CONTRACT.components;

/**
 * Mapa tipo → spec. É criado com **protótipo nulo** de propósito: um bloco pode
 * declarar `{"type":"constructor"}` (ou `toString`, `__proto__`), e acessar um
 * objeto comum herdaria `Object.prototype` e derrubaria o parse. Use sempre
 * `componentSpec()`/`GENUI_COMPONENT_MAP` com `Object.hasOwn`.
 */
export const GENUI_COMPONENT_MAP: Readonly<Record<string, GenUIComponentSpec>> = Object.assign(
  Object.create(null) as Record<string, GenUIComponentSpec>,
  Object.fromEntries(GENUI_CONTRACT.components.map((component) => [component.type, component])),
);

const pluginComponentMap = new Map<string, GenUIComponentSpec>();

/** Registers plugin-provided component specs (replaced on every snapshot). */
export function setPluginGenuiComponentSpecs(specs: readonly GenUIComponentSpec[]): void {
  pluginComponentMap.clear();
  for (const spec of specs) pluginComponentMap.set(spec.type, spec);
}

/** Resolve a spec de um tipo sem cair no protótipo de `Object`. */
export function componentSpec(type: unknown): GenUIComponentSpec | undefined {
  if (typeof type !== 'string') return undefined;
  if (pluginComponentMap.has(type)) return pluginComponentMap.get(type);
  if (!Object.hasOwn(GENUI_COMPONENT_MAP, type)) return undefined;
  return GENUI_COMPONENT_MAP[type];
}

export const GENUI_TYPES: readonly string[] = GENUI_CONTRACT.components.map((component) => component.type);
export const GENUI_ICONS: readonly string[] = GENUI_CONTRACT.icons;
export const GENUI_ACTION_KINDS: readonly ('prompt' | 'copy')[] = GENUI_CONTRACT.interactions.actionKinds.map(
  (kind) => kind.kind,
);
export const GENUI_BLOCKS = GENUI_CONTRACT.blocks;
export const GENUI_DIAGNOSTICS_PER_CODE = GENUI_CONTRACT.limits.diagnosticsPerCode;
export const GENUI_RULE_MAP: ReadonlyMap<string, GenUIDesignRule> = new Map(
  GENUI_CONTRACT.rules.map((rule) => [rule.id, rule]),
);

/**
 * Cap do rótulo de aba (`tabs.props.label` é metadado, declarado no contrato
 * para não haver número mágico duplicado entre TS e Rust).
 */
export const GENUI_TAB_LABEL_MAX_CHARS = componentSpec('tabs')?.props.label?.maxChars ?? 80;

/**
 * Forma "legada" mantida para compatibilidade com o renderer/testes que já
 * exportavam `GENUI_LIMITS` com esses nomes. Os valores sempre vêm do contrato.
 */
export const GENUI_LIMITS = {
  source: GENUI_CONTRACT.limits.sourceChars,
  depth: GENUI_CONTRACT.limits.depth,
  nodes: GENUI_CONTRACT.limits.nodes,
  props: GENUI_CONTRACT.limits.props,
  array: GENUI_CONTRACT.limits.arrayItems,
  string: GENUI_CONTRACT.limits.stringChars,
} as const;
