// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  saveCustomProvider: vi.fn(),
  reloadCatalog: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));

import { CustomProviderDialog } from '@/components/settings/CustomProviderDialog';
import { useAppStore } from '@/lib/store/appStore';

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.saveCustomProvider.mockResolvedValue({ catalog: { providers: [] }, keys: {}, auth: [] });
  mocks.reloadCatalog.mockResolvedValue(undefined);
  useAppStore.setState({ reloadCatalog: mocks.reloadCatalog });
});

function fill(placeholder: string, value: string) {
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
}

describe('CustomProviderDialog', () => {
  it('saves an OpenAI-compatible provider with a slug id', async () => {
    render(<CustomProviderDialog open onOpenChange={() => {}} provider={null} />);

    fill('Acme Gateway', 'Acme Gateway');
    fill('https://api.exemplo.com/v1', 'https://api.acme.dev/v1/');
    fill('Id do modelo', 'acme-chat-1');

    fireEvent.click(screen.getByRole('button', { name: /Adicionar provedor|Add provider/i }));

    await waitFor(() => expect(mocks.saveCustomProvider).toHaveBeenCalledTimes(1));
    const payload = mocks.saveCustomProvider.mock.calls[0][0];
    expect(payload.id).toBe('acme-gateway');
    expect(payload.name).toBe('Acme Gateway');
    expect(payload.baseUrl).toBe('https://api.acme.dev/v1');
    expect(payload.models).toEqual([
      { id: 'acme-chat-1', name: 'acme-chat-1', reasoning: false, attachment: false },
    ]);
    await waitFor(() => expect(mocks.reloadCatalog).toHaveBeenCalled());
  });

  it('refuses an empty name and does not call the backend', async () => {
    render(<CustomProviderDialog open onOpenChange={() => {}} provider={null} />);
    fill('https://api.exemplo.com/v1', 'https://api.acme.dev/v1');
    fill('Id do modelo', 'acme-chat-1');

    fireEvent.click(screen.getByRole('button', { name: /Adicionar provedor|Add provider/i }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(mocks.saveCustomProvider).not.toHaveBeenCalled();
  });

  it('accepts plain http only for loopback endpoints, like the backend', async () => {
    render(<CustomProviderDialog open onOpenChange={() => {}} provider={null} />);
    fill('Acme Gateway', 'Acme Gateway');
    fill('https://api.exemplo.com/v1', 'http://api.acme.dev/v1');
    fill('Id do modelo', 'acme-chat-1');

    fireEvent.click(screen.getByRole('button', { name: /Adicionar provedor|Add provider/i }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(mocks.saveCustomProvider).not.toHaveBeenCalled();

    // Editing the field clears the message and a local server goes through.
    fill('https://api.exemplo.com/v1', 'http://localhost:11434/v1');
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Adicionar provedor|Add provider/i }));
    await waitFor(() => expect(mocks.saveCustomProvider).toHaveBeenCalledTimes(1));
    expect(mocks.saveCustomProvider.mock.calls[0][0].baseUrl).toBe('http://localhost:11434/v1');
  });

  it('toggles model capabilities from the switch labels', async () => {
    render(<CustomProviderDialog open onOpenChange={() => {}} provider={null} />);
    fill('Acme Gateway', 'Acme Gateway');
    fill('https://api.exemplo.com/v1', 'https://api.acme.dev/v1');
    fill('Id do modelo', 'acme-chat-1');

    fireEvent.click(screen.getByRole('switch', { name: 'Raciocínio' }));
    fireEvent.click(screen.getByRole('button', { name: /Adicionar provedor|Add provider/i }));

    await waitFor(() => expect(mocks.saveCustomProvider).toHaveBeenCalledTimes(1));
    expect(mocks.saveCustomProvider.mock.calls[0][0].models[0]).toMatchObject({
      id: 'acme-chat-1',
      reasoning: true,
      attachment: false,
    });
  });

  it('reveals the advanced auth fields through a disclosure', () => {
    render(<CustomProviderDialog open onOpenChange={() => {}} provider={null} />);

    const toggle = screen.getByRole('button', { name: 'Avançado' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Header de auth')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Header de auth')).toBeTruthy();
  });
});
