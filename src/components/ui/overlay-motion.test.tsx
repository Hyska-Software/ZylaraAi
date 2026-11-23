// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Dialog, DialogContent, DialogTitle } from './dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from './dropdown-menu';
import { Popover, PopoverContent } from './popover';

describe('overlay motion', () => {
  it('animates the dialog content and overlay in and out', () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Motion</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const content = screen.getByRole('dialog');
    expect(content.className).toContain('data-[state=open]:animate-scale-in');
    expect(content.className).toContain('data-[state=closed]:animate-scale-out');

    const overlay = document.querySelector('[data-state="open"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.className).toContain('data-[state=closed]:animate-fade-out');
  });

  it('animates popovers in and out', () => {
    render(
      <Popover defaultOpen>
        <PopoverContent>Motion popover</PopoverContent>
      </Popover>,
    );

    const content = screen.getByText('Motion popover');
    expect(content.className).toContain('data-[state=open]:animate-scale-in');
    expect(content.className).toContain('data-[state=closed]:animate-scale-out');
  });

  it('animates dropdown menus in and out', () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuContent>
          <DropdownMenuItem>Motion item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const content = screen.getByRole('menu');
    expect(content.className).toContain('data-[state=open]:animate-fade-in');
    expect(content.className).toContain('data-[state=closed]:animate-fade-out');
  });
});
