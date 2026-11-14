// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SessionCostView } from '@/lib/sessionCost';
import type { CacheSample, CacheStats, ContextStats } from '@/lib/types';
import type { CacheConversationUi } from '@/lib/store/cacheStore';
import { ContextMeter } from './ContextMeter';

function makeStats(overrides: Partial<ContextStats> = {}): ContextStats {
  return {
    used: 441_000,
    window: 1_000_000,
    outputCap: 32_000,
    percent: 44,
    messages: 120,
    breakdown: { systemPrompt: 100_000, toolDefinitions: 41_000, messages: 300_000 },
    ...overrides,
  };
}

const CACHE_AT = Date.now();

function makeCacheStats(overrides: Partial<CacheStats> = {}): CacheStats {
  return {
    hitPercent: 98,
    sessionHitPercent: 97,
    steadyHitPercent: 98.2,
    ceilingPercent: 98.6,
    inputTotal: 250_000,
    cacheRead: 240_000,
    cacheWrite: 6_000,
    uncached: 4_000,
    eligible: true,
    state: 'stable',
    epoch: 1,
    samples: 12,
    ttlSeconds: 3600,
    at: CACHE_AT,
    ...overrides,
  };
}

function makeCacheSample(overrides: Partial<CacheSample> = {}): CacheSample {
  return {
    turnId: 'turn-1',
    step: 1,
    providerId: 'opencode-go',
    modelId: 'deepseek-v4.1-flash',
    protocol: 'openai-chat',
    epoch: 1,
    inputTotal: 250_000,
    cacheRead: 240_000,
    cacheWrite: 6_000,
    uncached: 4_000,
    hitPercent: 98,
    ceilingPercent: 98.6,
    eligible: true,
    state: 'stable',
    at: CACHE_AT,
    ...overrides,
  };
}

function makeCache(overrides: Partial<CacheConversationUi> = {}): CacheConversationUi {
  return {
    current: makeCacheStats(),
    session: makeCacheStats(),
    epoch: 1,
    samples: [makeCacheSample()],
    lastBreak: null,
    restored: true,
    ...overrides,
  };
}

function makeCost(overrides: Partial<SessionCostView> = {}): SessionCostView {
  return {
    input: { tokens: 4_000, usd: 0.0012, priced: true },
    cacheRead: { tokens: 240_000, usd: 0.0014, priced: true },
    cacheWrite: { tokens: 6_000, usd: 0.0008, priced: true },
    output: { tokens: 12_000, usd: 0.0144, priced: true },
    totalUsd: 0.0178,
    totalTokens: 262_000,
    subagents: 2,
    priced: true,
    unpriced: false,
    ...overrides,
  };
}

function cacheDescription(button: HTMLElement): string {
  const id = button.getAttribute('aria-describedby');
  expect(id).toBeTruthy();
  return document.getElementById(id as string)?.textContent ?? '';
}

function trigger(percent = 44): HTMLElement {
  return screen.getByRole('button', { name: `Contexto usado: ${percent}%` });
}

async function openPopover(percent = 44): Promise<HTMLElement> {
  fireEvent.click(trigger(percent));
  return screen.findByRole('dialog', { name: 'Detalhes do contexto' });
}

function legendItems(dialog: HTMLElement): HTMLElement[] {
  const list = within(dialog).getByRole('list', { name: 'Composição do contexto' });
  return Array.from(list.querySelectorAll('li'));
}

afterEach(cleanup);

describe('ContextMeter — chip compacto', () => {
  it('mostra anel de progresso + percentual e expõe aria-label descritivo', () => {
    const { container } = render(<ContextMeter stats={makeStats()} />);

    const button = trigger();
    expect(button.getAttribute('aria-label')).toBe('Contexto usado: 44%');
    expect(button.textContent).toContain('44%');
    expect(button.className).toContain('focus-visible:ring-2');
    // Anel: trilho + arco, ambos decorativos.
    expect(container.querySelectorAll('circle')).toHaveLength(2);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    // Sem layout shift: altura fixa e valores tabulares.
    expect(button.className).toContain('h-8');
    expect(button.querySelector('.tabular-nums')).toBeTruthy();
  });

  it('abre o popover ao clicar (e o popover é um dialog rotulado)', async () => {
    render(<ContextMeter stats={makeStats()} />);

    const dialog = await openPopover();

    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Detalhes do contexto');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });
});

describe('ContextMeter — popover (breakdown)', () => {
  it('mostra o header "X% do contexto usado" e os valores estimados', async () => {
    render(<ContextMeter stats={makeStats()} />);
    const dialog = await openPopover();

    expect(within(dialog).getByText('44% do contexto usado')).toBeTruthy();
    expect(within(dialog).getByText('~441K / 1M')).toBeTruthy();
    expect(within(dialog).getByText('Limite de saída: ~32K')).toBeTruthy();
  });

  it('barra segmentada com aria de progressbar, título e proporção da janela', async () => {
    render(<ContextMeter stats={makeStats()} />);
    const dialog = await openPopover();

    const bar = within(dialog).getByRole('progressbar', { name: 'Contexto usado' });
    expect(bar.getAttribute('aria-valuenow')).toBe('44');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.getAttribute('aria-valuetext')).toBe('44% do contexto usado — ok');
    expect(bar.getAttribute('title')).toBe('Limite de saída: ~32K tokens');

    const segments = Array.from(bar.children) as HTMLElement[];
    expect(segments).toHaveLength(3);
    expect(segments[0].className).toContain('bg-context-system');
    expect(segments[1].className).toContain('bg-context-tools');
    expect(segments[2].className).toContain('bg-context-messages');
    // 100K/1M = 10%, 41K/1M = 4.1%, 300K/1M = 30%.
    expect(segments[0].style.width).toBe('10%');
    expect(segments[1].style.width).toBe('4.1%');
    expect(segments[2].style.width).toBe('30%');
    // Animação respeita reduced motion.
    expect(segments[0].className).toContain('transition-[width]');
    expect(segments[0].className).toContain('motion-reduce:transition-none');
  });

  it('legenda lista as três partes na ordem sistema → ferramentas → mensagens', async () => {
    render(<ContextMeter stats={makeStats()} />);
    const dialog = await openPopover();

    const items = legendItems(dialog);
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Prompt de sistema');
    expect(items[0].textContent).toContain('~100K');
    expect(items[1].textContent).toContain('Definições de ferramentas');
    expect(items[1].textContent).toContain('~41K');
    expect(items[2].textContent).toContain('Mensagens');
    expect(items[2].textContent).toContain('~300K');
  });

  it('clampa percentual > 100 no chip, na barra e no rótulo', async () => {
    render(<ContextMeter stats={makeStats({ percent: 140 })} />);

    expect(trigger(100)).toBeTruthy();
    const dialog = await openPopover(100);
    const bar = within(dialog).getByRole('progressbar', { name: 'Contexto usado' });
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(within(dialog).getByText('100% do contexto usado')).toBeTruthy();
  });

  it('clampa percentual negativo para 0', async () => {
    render(<ContextMeter stats={makeStats({ percent: -10 })} />);
    expect(trigger(0)).toBeTruthy();
    const dialog = await openPopover(0);
    expect(
      within(dialog).getByRole('progressbar').getAttribute('aria-valuenow'),
    ).toBe('0');
  });
});

describe('ContextMeter — faixas e compactação', () => {
  it('faixa de atenção usa o rótulo textual (>=70)', async () => {
    render(<ContextMeter stats={makeStats({ percent: 78 })} />);
    const dialog = await openPopover(78);
    expect(
      within(dialog).getByRole('progressbar').getAttribute('aria-valuetext'),
    ).toBe('78% do contexto usado — atenção');
  });

  it('faixa compactando (>=90) aplica anel danger e preenchimento de alerta', async () => {
    const { container } = render(<ContextMeter stats={makeStats({ percent: 94 })} />);
    const button = trigger(94);
    expect(button.className).toContain('bg-danger-soft');
    expect(button.className).toContain('text-danger');

    const arc = container.querySelectorAll('circle')[1];
    expect(arc?.getAttribute('class') ?? '').toContain('text-danger');

    const dialog = await openPopover(94);
    expect(
      within(dialog).getByRole('progressbar').getAttribute('aria-valuetext'),
    ).toBe('94% do contexto usado — compactando');
  });

  it('mostra a nota de compactação (stats) com role=status', async () => {
    render(<ContextMeter stats={makeStats({ compacted: 42 })} />);
    const dialog = await openPopover();
    expect(within(dialog).getByRole('status').textContent).toBe(
      'Contexto compactado · 42 mensagens resumidas',
    );
  });

  it('usa o prop compacted quando o host o informa', async () => {
    render(<ContextMeter stats={makeStats({ compacted: undefined })} compacted={7} />);
    const dialog = await openPopover();
    expect(within(dialog).getByRole('status').textContent).toContain('7 mensagens');
  });

  it('não mostra nota de compactação sem compactação', async () => {
    render(<ContextMeter stats={makeStats({ compacted: 0 })} />);
    const dialog = await openPopover();
    expect(within(dialog).queryByRole('status')).toBeNull();
  });
});

describe('ContextMeter — fallback e tempo real', () => {
  it('degrada para barra única + linha Mensagens quando falta breakdown', async () => {
    render(<ContextMeter stats={makeStats({ breakdown: undefined })} />);
    const dialog = await openPopover();

    const bar = within(dialog).getByRole('progressbar', { name: 'Contexto usado' });
    const segments = Array.from(bar.children) as HTMLElement[];
    expect(segments).toHaveLength(1);
    expect(segments[0].className).toContain('bg-accent');
    expect(segments[0].style.width).toBe('44%');

    const items = legendItems(dialog);
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('Mensagens');
    expect(items[0].textContent).toContain('~441K');
    expect(within(dialog).getByText('~441K / 1M')).toBeTruthy();
  });

  it('rerenderiza com novos stats sem fechar/remontar o popover', async () => {
    const { rerender } = render(<ContextMeter stats={makeStats()} />);
    const dialog = await openPopover();

    rerender(
      <ContextMeter
        stats={makeStats({
          used: 550_000,
          percent: 55,
          breakdown: { systemPrompt: 120_000, toolDefinitions: 50_000, messages: 380_000 },
        })}
      />,
    );

    expect(trigger(55)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByText('55% do contexto usado')).toBeTruthy();
    expect(within(dialog).getByText('~550K / 1M')).toBeTruthy();

    const bar = within(dialog).getByRole('progressbar', { name: 'Contexto usado' });
    expect(bar.getAttribute('aria-valuenow')).toBe('55');
    const segments = Array.from(bar.children) as HTMLElement[];
    expect(segments[0].style.width).toBe('12%');
    expect(segments[1].style.width).toBe('5%');
    expect(segments[2].style.width).toBe('38%');
    const items = legendItems(dialog);
    expect(items[0].textContent).toContain('~120K');
    expect(items[2].textContent).toContain('~380K');
  });

  it('a11y: trigger focável, lista textual (não só cor) e anel decorativo', async () => {
    render(<ContextMeter stats={makeStats()} />);

    const button = trigger();
    button.focus();
    expect(document.activeElement).toBe(button);

    const dialog = await openPopover();
    const list = within(dialog).getByRole('list', { name: 'Composição do contexto' });
    expect(list.querySelectorAll('li')).toHaveLength(3);
    for (const item of Array.from(list.querySelectorAll('li'))) {
      // Rótulo textual sempre visível ao lado do quadrado de cor.
      expect(item.textContent?.trim().length).toBeGreaterThan(0);
      expect(item.querySelector('[aria-hidden="true"]')).toBeTruthy();
    }
    expect(dialog.querySelector('svg')).toBeNull();
  });
});

describe('ContextMeter — cache de prompt compacto', () => {
  it('mostra anel de contexto + segmento de cache com largura reservada', () => {
    const { container } = render(<ContextMeter stats={makeStats()} cache={makeCache()} />);

    const button = trigger();
    // O nome acessível do medidor continua o do contexto; o cache vira descrição.
    expect(button.getAttribute('aria-label')).toBe('Contexto usado: 44%');
    expect(button.textContent).toContain('44%');
    expect(button.textContent).toContain('98%');
    expect(button.className).toContain('h-8');
    // Largura mínima reservada para não deslocar o anel quando o cache sai de — para 98%.
    expect(button.className).toContain('min-w-[7rem]');
    expect(button.className).toContain('tabular-nums');
    expect(cacheDescription(button)).toBe('Cache de prompt: 98% de acerto — estável.');
    // Anel de contexto + Zap (ambos decorativos).
    expect(container.querySelectorAll('svg')).toHaveLength(2);
  });

  it('popover mostra a seção de cache, barra própria e mantém a barra de contexto', async () => {
    render(<ContextMeter stats={makeStats()} cache={makeCache()} />);
    const dialog = await openPopover();

    expect(within(dialog).getByText('Cache de prompt')).toBeTruthy();
    expect(within(dialog).getByText('98% de acerto')).toBeTruthy();
    expect(within(dialog).getByText('Lido do cache')).toBeTruthy();
    expect(within(dialog).getByText('Acumulado da sessão')).toBeTruthy();
    expect(within(dialog).getByText('97% em 12 passos')).toBeTruthy();
    expect(within(dialog).getByText('Teto deste request')).toBeTruthy();
    expect(within(dialog).getByText('Estável')).toBeTruthy();
    expect(within(dialog).getByText('12 amostras')).toBeTruthy();

    const cacheBar = within(dialog).getByRole('progressbar', {
      name: 'Acerto do cache de prompt',
    });
    expect(cacheBar.getAttribute('aria-valuenow')).toBe('98');
    expect(cacheBar.getAttribute('aria-valuetext')).toBe('98% de acerto no cache');
    // A barra do contexto continua no popover (duas progressbars, nomes distintos).
    expect(within(dialog).getByRole('progressbar', { name: 'Contexto usado' })).toBeTruthy();
    // Regra de a11y: o popover não ganha ícones SVG.
    expect(dialog.querySelector('svg')).toBeNull();
  });

  it('sem prop cache o medidor fica exatamente como antes (hosts antigos)', async () => {
    render(<ContextMeter stats={makeStats()} />);
    const dialog = await openPopover();

    expect(within(dialog).queryByText('Cache de prompt')).toBeNull();
    expect(trigger().getAttribute('aria-describedby')).toBeNull();
  });

  it('cache null (antes do primeiro request) mostra — e a nota honesta', async () => {
    render(<ContextMeter stats={makeStats()} cache={null} />);

    const button = trigger();
    expect(button.textContent).toContain('—');
    expect(cacheDescription(button)).toBe('Cache de prompt: aguardando a primeira amostra.');

    const dialog = await openPopover();
    expect(
      within(dialog).getByRole('status').textContent,
    ).toBe('Sem amostras ainda. O acerto de cache aparece depois do primeiro passo.');
  });

  it('queda de cache mostra o motivo legível na seção', async () => {
    const latest = makeCacheSample({
      step: 4,
      hitPercent: 41,
      state: 'degraded',
      breakReason: 'system_prompt',
      cacheRead: 100_000,
      cacheWrite: 0,
      uncached: 145_000,
      inputTotal: 245_000,
    });
    render(
      <ContextMeter
        stats={makeStats()}
        cache={makeCache({
          current: makeCacheStats({
            hitPercent: 41,
            state: 'degraded',
            breakReason: 'system_prompt',
            cacheRead: 100_000,
            cacheWrite: 0,
            uncached: 145_000,
            inputTotal: 245_000,
          }),
          samples: [makeCacheSample({ step: 3, hitPercent: 98 }), latest],
          lastBreak: { reason: 'Prompt de sistema mudou', detail: null, at: CACHE_AT },
        })}
      />,
    );

    const dialog = await openPopover();
    expect(within(dialog).getByText('Cache caiu')).toBeTruthy();
    expect(within(dialog).getByText('Prompt de sistema mudou')).toBeTruthy();
    expect(within(dialog).getByRole('status').textContent).toBe(
      'Cache caiu de 98% para 41% neste passo. Motivo: o prompt de sistema mudou.',
    );
  });

  it('atualiza o cache sem fechar/remontar o popover aberto', async () => {
    const { rerender } = render(<ContextMeter stats={makeStats()} cache={makeCache()} />);
    const dialog = await openPopover();
    expect(within(dialog).getByText('98% de acerto')).toBeTruthy();

    rerender(
      <ContextMeter
        stats={makeStats({ percent: 55, used: 550_000 })}
        cache={makeCache({
          current: makeCacheStats({ hitPercent: 41, state: 'degraded' }),
        })}
      />,
    );

    expect(trigger(55)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByText('41% de acerto')).toBeTruthy();
  });
});

describe('ContextMeter — custo da sessão', () => {
  it('mostra apenas o valor em dólar no chip e o descreve para leitores de tela', () => {
    render(<ContextMeter stats={makeStats()} cost={makeCost()} />);

    const button = trigger();
    expect(button.textContent).toContain('$0.02');
    expect(button.textContent).not.toContain('262K');
    expect(cacheDescription(button)).toBe('Custo da sessão: $0.02');
  });

  it('marca o segmento de custo com o ícone de cifrão, escondido de leitores de tela', () => {
    render(<ContextMeter stats={makeStats()} cost={makeCost()} />);

    const icon = trigger().querySelector('.lucide-dollar-sign');
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('pinta o ícone de custo com o mesmo token de cor do ícone de cache', () => {
    render(<ContextMeter stats={makeStats()} cache={makeCache()} cost={makeCost()} />);

    const button = trigger();
    const zap = button.querySelector('.lucide-zap');
    const dollar = button.querySelector('.lucide-dollar-sign');
    expect(zap?.getAttribute('class')).toContain('text-success');
    expect(dollar?.getAttribute('class')).toContain('text-success');
  });

  it('não reserva largura no valor: o chip cresce com números grandes e sem vão após o ícone', () => {
    const { rerender } = render(<ContextMeter stats={makeStats()} cost={makeCost()} />);

    function costValue(): HTMLElement {
      const value = trigger().querySelector('.lucide-dollar-sign')?.nextElementSibling;
      expect(value).toBeTruthy();
      return value as HTMLElement;
    }

    expect(costValue().className).not.toContain('min-w-');
    expect(costValue().className).not.toContain('text-right');
    expect(costValue().className).toContain('whitespace-nowrap');

    rerender(
      <ContextMeter stats={makeStats()} cost={makeCost({ totalUsd: 1234.5678, priced: true })} />,
    );
    expect(costValue().textContent).toBe('$1234.57');
  });

  it('mantém o description do cache e concatena o custo quando os dois existem', () => {
    render(<ContextMeter stats={makeStats()} cache={makeCache()} cost={makeCost()} />);

    const button = trigger();
    expect(button.textContent).toContain('98%');
    expect(button.textContent).toContain('$0.02');
    expect(cacheDescription(button)).toBe(
      'Cache de prompt: 98% de acerto — estável. Custo da sessão: $0.02',
    );
    expect(button.className).toContain('min-w-[7rem]');
  });

  it('abre o detalhamento por entrada, saída, cache hit e gravação', async () => {
    render(<ContextMeter stats={makeStats()} cost={makeCost()} />);
    const dialog = await openPopover();

    expect(within(dialog).getByText('Custo da sessão')).toBeTruthy();
    expect(within(dialog).getByText('$0.02')).toBeTruthy();
    const list = within(dialog).getByRole('list', { name: 'Detalhamento do custo' });
    const rows = Array.from(list.querySelectorAll('li'));
    expect(rows.map((row) => row.firstElementChild?.textContent)).toEqual([
      'Entrada',
      'Saída',
      'Cache hit',
      'Gravação no cache',
    ]);
    expect(rows[0].textContent).toContain('4.0K · $0.0012');
    expect(rows[1].textContent).toContain('12K · $0.01');
    expect(rows[2].textContent).toContain('240K · $0.0014');
    expect(rows[3].textContent).toContain('6.0K · $0.0008');
    expect(within(dialog).getByText('Subagentes incluídos: 2')).toBeTruthy();
    expect(
      within(dialog).getByText('Preços oficiais de API do catálogo; assinaturas não são cobradas por token.'),
    ).toBeTruthy();
  });

  it('sem preço no catálogo mostra — no chip e a nota no detalhamento', async () => {
    render(
      <ContextMeter
        stats={makeStats()}
        cost={makeCost({
          input: { tokens: 100, usd: 0, priced: false },
          cacheRead: { tokens: 0, usd: 0, priced: false },
          cacheWrite: { tokens: 0, usd: 0, priced: false },
          output: { tokens: 50, usd: 0, priced: false },
          totalUsd: 0,
          totalTokens: 150,
          subagents: 0,
          priced: false,
          unpriced: true,
        })}
      />,
    );

    const button = trigger();
    expect(button.textContent).toContain('—');
    expect(cacheDescription(button)).toBe('Custo da sessão: sem preço no catálogo para este modelo');

    const dialog = await openPopover();
    expect(within(dialog).getByText('Custo da sessão')).toBeTruthy();
    expect(
      within(dialog).getByText('Alguns tokens não têm preço oficial no catálogo e não entram no total.'),
    ).toBeTruthy();
    expect(within(dialog).queryByText('Subagentes incluídos: 0')).toBeNull();
  });

  it('sem o prop cost o medidor continua igual (hosts antigos)', async () => {
    render(<ContextMeter stats={makeStats()} />);
    const dialog = await openPopover();

    expect(within(dialog).queryByText('Custo da sessão')).toBeNull();
    expect(trigger().getAttribute('aria-describedby')).toBeNull();
  });
});

