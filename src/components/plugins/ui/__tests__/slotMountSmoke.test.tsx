import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { PLUGIN_RESERVED_SLOTS, PLUGIN_SLOTS } from '@/lib/plugins/contract';
import { Slot } from '@/components/plugins/ui/Slot';

/**
 * Mount smoke test: every slot the contract advertises as live must render
 * without a contribution (and without throwing) with a null fallback. Together
 * with `scripts/check-plugin-surfaces.mjs` this catches a contract id that has
 * no mount point or a mount point that breaks on the empty state.
 */
describe('plugin slot mounts', () => {
  it('renders every live slot with no contribution', () => {
    const live = PLUGIN_SLOTS.filter((slot) => !PLUGIN_RESERVED_SLOTS.includes(slot.id));
    expect(live.length).toBeGreaterThan(60);
    for (const slot of live) {
      const { container, unmount } = render(
        <Slot name={slot.id} owner={{}} entryKey={slot.kind === 'keyed' ? 'test' : undefined} />,
      );
      expect(container.childElementCount, `${slot.id} rendered content without a plugin`).toBe(0);
      unmount();
    }
  });
});
