import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from '../uiStore';

beforeEach(() => {
  useUiStore.setState({
    layoutMode: 'chat',
    pluginPages: { chat: null, code: null, agent: null },
    pluginDockTab: { chat: null, code: null, agent: null },
    codePanelTab: 'files',
    agentPanelTab: 'screen',
    agentRightPanel: 'agent',
    activeView: 'chat',
  });
});

describe('uiStore — plugin pages', () => {
  it('opens a plugin page per layout without changing the layout', () => {
    useUiStore.getState().openPluginPage({ pluginId: 'com.acme.notes', pageId: 'notes' }, 'code');
    expect(useUiStore.getState().pluginPages.code).toEqual({
      pluginId: 'com.acme.notes',
      pageId: 'notes',
    });
    expect(useUiStore.getState().layoutMode).toBe('chat');
  });

  it('clears the code plugin page when a host code tab is selected', () => {
    useUiStore.getState().openPluginPage({ pluginId: 'com.acme.notes', pageId: 'notes' }, 'code');
    useUiStore.getState().setCodePanelTab('changes');
    expect(useUiStore.getState().pluginPages.code).toBeNull();
  });

  it('clears the agent plugin page when a host agent tab is selected', () => {
    useUiStore.getState().openPluginPage({ pluginId: 'com.acme.notes', pageId: 'notes' }, 'agent');
    useUiStore.getState().setAgentPanelTab('routines');
    expect(useUiStore.getState().pluginPages.agent).toBeNull();
  });

  it('clears the chat plugin page when a host view is selected', () => {
    useUiStore.getState().openPluginPage({ pluginId: 'com.acme.notes', pageId: 'notes' }, 'chat');
    useUiStore.getState().setActiveView('skills');
    expect(useUiStore.getState().pluginPages.chat).toBeNull();
  });
});
