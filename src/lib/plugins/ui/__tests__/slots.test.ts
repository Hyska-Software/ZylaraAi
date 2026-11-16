import { describe, expect, it } from 'vitest';

import { electChain, selectSlotContributions, whenMatches } from '@/lib/plugins/ui/slots';
import { orderedContributions, pickWinner } from '@/lib/plugins/ui/registry';
import { recipeClasses } from '@/lib/plugins/ui/recipe';
import type { SlotContribution } from '@/lib/plugins/ui/types';

function slot(overrides: Partial<SlotContribution>): SlotContribution {
  return {
    key: 'p:slot:a',
    plugin: { id: 'p' } as never,
    pluginId: 'p',
    source: 'trusted',
    order: 100,
    priority: 100,
    layouts: ['chat', 'code', 'agent'],
    slot: 'chat.message.actions',
    entryId: 'a',
    kind: 'list',
    keyMatch: null,
    component: null,
    entry: null,
    action: null,
    title: null,
    titleKey: null,
    icon: null,
    when: null,
    ...overrides,
  };
}

describe('slot routing', () => {
  it('filters by layout, entry key and disabled contributions', () => {
    const entries = [
      slot({ key: 'a', slot: 'chat.message.node', keyMatch: 'user', layouts: ['chat'] }),
      slot({ key: 'b', slot: 'chat.message.node', keyMatch: 'assistant', layouts: ['code'] }),
      slot({ key: 'c', slot: 'chat.message.actions' }),
    ];
    const chat = selectSlotContributions(entries, {
      slot: 'chat.message.node',
      layout: 'chat',
      entryKey: 'user',
    });
    expect(chat.map((entry) => entry.key)).toEqual(['a']);
    expect(
      selectSlotContributions(entries, {
        slot: 'chat.message.node',
        layout: 'code',
        entryKey: 'assistant',
      }).map((entry) => entry.key),
    ).toEqual(['b']);
    expect(
      selectSlotContributions(entries, {
        slot: 'chat.message.actions',
        layout: 'chat',
        disabled: ['c'],
      }),
    ).toHaveLength(0);
  });

  it('orders by order, priority and key', () => {
    const entries = [
      slot({ key: 'c', order: 200 }),
      slot({ key: 'b', order: 100, priority: 50 }),
      slot({ key: 'a', order: 100, priority: 100 }),
    ];
    expect(orderedContributions(entries).map((entry) => entry.key)).toEqual(['b', 'a', 'c']);
    expect(pickWinner(entries)?.key).toBe('b');
    expect(pickWinner(entries, 'c')?.key).toBe('c');
    expect(
      selectSlotContributions(entries, {
        slot: 'chat.message.actions',
        layout: 'chat',
      }).map((entry) => entry.key),
    ).toEqual(['b', 'a', 'c']);
  });

  it('filters list contributions through declarative when', () => {
    const entries = [
      slot({ key: 'user', when: { role: 'user' } }),
      slot({ key: 'assistant', when: { role: 'assistant' } }),
      slot({ key: 'always' }),
    ];
    expect(
      selectSlotContributions(entries, {
        slot: 'chat.message.actions',
        layout: 'chat',
        owner: { role: 'assistant' },
      }).map((entry) => entry.key),
    ).toEqual(['always', 'assistant']);
  });

  it('elects chain entries through select or declarative when', () => {
    const select = slot({
      key: 'select',
      select: (owner) => (owner.role === 'assistant' ? { matched: true } : null),
    });
    const when = slot({ key: 'when', when: { role: 'assistant' } });
    expect(electChain([when, select], { role: 'assistant' })?.key).toBe('when');
    expect(electChain([select], { role: 'user' })).toBeUndefined();
    expect(whenMatches({ role: 'user' }, { role: 'user' })).toBe(true);
    expect(whenMatches({ role: 'user' }, { role: 'assistant' })).toBe(false);
  });

  it('turns style recipes into token utilities', () => {
    expect(recipeClasses({ surface: 'user-bubble', radius: '2xl', padding: '3', text: 'sm' })).toBe(
      'bg-user-bubble rounded-2xl p-3 text-sm',
    );
    expect(recipeClasses(null)).toBe('');
  });
});
