// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PluginExperimentalNotice } from '@/components/plugins/PluginExperimentalNotice';

afterEach(cleanup);

describe('PluginExperimentalNotice', () => {
  it('marks the plugin system as experimental on the plugins page', () => {
    render(<PluginExperimentalNotice />);

    expect(screen.getByRole('note', { name: 'Experimental' })).toBeTruthy();
    expect(screen.getByText(/sistema de plugins ainda está experimental/i)).toBeTruthy();
  });
});
