import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { GENUI_LIMITS, propString, type GenUIComponent, type GenUISpec } from '@/lib/genui';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { GenUICard, GenUIGrid, GenUIStack } from './components/GenUILayout';
import { GenUIChart, GenUITable } from './components/GenUIData';
import { GenUIChecklist, GenUISection, GenUISource, GenUIText } from './components/GenUIStructure';
import {
  GenUIBadge,
  GenUICallout,
  GenUICode,
  GenUIDivider,
  GenUIImage,
  GenUIKeyValue,
  GenUILink,
  GenUIList,
  GenUIProgress,
  GenUIQuote,
  GenUIStat,
  GenUISteps,
  GenUITimeline,
} from './components/GenUIBlocks';
import { GenUIActions } from './GenUIActions';
import { GenUIChoices } from './GenUIChoices';
import { GenUIReveal } from './GenUIReveal';
import { pluginGenuiComponent } from '@/lib/genui/extension';
import { PluginGenuiView } from '@/components/plugins/ui/PluginGenuiView';

interface RenderNodeProps {
  node: GenUIComponent;
  depth: number;
}

/** Fallback discreto: nunca descartar um componente em silêncio. */
function GenUIFallback({ message }: { message: string }) {
  return (
    <p className="rounded-xl border border-dashed border-border bg-surface px-3 py-2.5 text-xs text-foreground-subtle">
      {message}
    </p>
  );
}

function renderChildren(node: GenUIComponent, depth: number) {
  return node.children?.map((child, index) => <GenUINode key={index} node={child} depth={depth + 1} />);
}

function GenUINode({ node, depth }: RenderNodeProps) {
  const { t } = useTranslation('genui');
  if (depth > GENUI_LIMITS.depth) {
    return <GenUIFallback message={t('renderer.depthExceeded')} />;
  }

  const children = renderChildren(node, depth);
  const props = node.props;

  if (typeof node.type === 'string' && node.type.startsWith('plugin:')) {
    const entry = pluginGenuiComponent(node.type);
    if (!entry) {
      return <GenUIFallback message={t('renderer.unsupportedComponent', { type: String(node.type) })} />;
    }
    return <PluginGenuiView entry={entry} props={{ ...(props ?? {}) }} />;
  }

  switch (node.type) {
    case 'card':
      return <GenUICard props={props}>{children}</GenUICard>;
    case 'stack':
      return <GenUIStack props={props}>{children}</GenUIStack>;
    case 'grid':
      return <GenUIGrid props={props}>{children}</GenUIGrid>;
    case 'tabs':
      return <GenUITabs node={node} depth={depth} />;
    case 'reveal':
      return <GenUIReveal props={props}>{children}</GenUIReveal>;
    case 'section':
      return <GenUISection props={props}>{children}</GenUISection>;
    case 'text':
      return <GenUIText props={props} />;
    case 'source':
      return <GenUISource props={props} />;
    case 'choices':
      return <GenUIChoices props={props} />;
    case 'checklist':
      return <GenUIChecklist props={props} />;
    case 'table':
      return <GenUITable props={props} />;
    case 'chart':
      return <GenUIChart props={props} />;
    case 'stat':
      return <GenUIStat props={props} />;
    case 'progress':
      return <GenUIProgress props={props} />;
    case 'timeline':
      return <GenUITimeline props={props} />;
    case 'steps':
      return <GenUISteps props={props} />;
    case 'callout':
      return <GenUICallout props={props}>{children}</GenUICallout>;
    case 'quote':
      return <GenUIQuote props={props}>{children}</GenUIQuote>;
    case 'code':
      return <GenUICode props={props} />;
    case 'list':
      return <GenUIList props={props} />;
    case 'image':
      return <GenUIImage props={props} />;
    case 'badge':
      return <GenUIBadge props={props} />;
    case 'divider':
      return <GenUIDivider props={props} />;
    case 'link':
      return <GenUILink props={props} />;
    case 'keyvalue':
      return <GenUIKeyValue props={props} />;
    case 'actions':
      return <GenUIActions props={props} />;
    default:
      // O parser já rejeita tipos fora da whitelist; este ramo é só uma rede de
      // segurança para specs construídos fora do parseGenUI.
      return <GenUIFallback message={t('renderer.unsupportedComponent', { type: String(node.type) })} />;
  }
}

/** `tabs` maps each child component into a panel; the tab label comes from `props.label`. */
function GenUITabs({ node, depth }: { node: GenUIComponent; depth: number }) {
  const { t } = useTranslation('genui');
  const baseId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const panels = node.children ?? [];
  if (!panels.length) return <GenUIFallback message={t('renderer.emptyTabs')} />;

  return (
    <Tabs defaultValue={`${baseId}-0`} className="w-full">
      {/* h-auto + p-0.5: o pill agora tem 32px e pode quebrar linha sem vazar do fundo. */}
      <TabsList className="mb-3 h-auto max-w-full flex-wrap p-0.5">
        {panels.map((panel, index) => (
          <TabsTrigger key={index} value={`${baseId}-${index}`} variant="pill">
            {propString(panel.props, 'label', propString(panel.props, 'title', t('renderer.defaultTab', { index: index + 1 })))}
          </TabsTrigger>
        ))}
      </TabsList>
      {panels.map((panel, index) => (
        <TabsContent key={index} value={`${baseId}-${index}`} className="flex flex-col gap-3">
          <GenUINode node={panel} depth={depth + 1} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

export interface GenUIRendererProps {
  spec: GenUISpec;
  className?: string;
}

/** Renders a sanitized generative UI spec using only whitelisted primitives. */
export function GenUIRenderer({ spec, className }: GenUIRendererProps) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-3 text-[13.5px] leading-relaxed text-foreground', className)}>
      {spec.components.map((component, index) => (
        <GenUINode key={index} node={component} depth={0} />
      ))}
    </div>
  );
}
