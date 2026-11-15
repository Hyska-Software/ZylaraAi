/* Trusted reference plugin. Runs in the main webview with the host React. */
host.registerPlugin({
  activate(host) {
    const React = host.react;
    const e = React.createElement;

    function Lab(props) {
      const [count, setCount] = React.useState(0);
      const [pong, setPong] = React.useState('');
      const notes = host.plugin.permissions.filter((permission) => permission.granted).length;
      return e(
        'div',
        { style: { padding: 20, fontFamily: 'var(--font-sans)', color: 'var(--foreground)' } },
        e('h1', { style: { fontSize: 16, margin: '0 0 6px' } }, 'Trusted Lab'),
        e(
          'p',
          { style: { margin: '0 0 16px', color: 'var(--foreground-muted)', fontSize: 12 } },
          'This page is a React component supplied by a trusted plugin. It can use host stores, ' +
            'React hooks and the narrow host bridge.',
        ),
        e(
          'button',
          {
            type: 'button',
            onClick: () => setCount((value) => value + 1),
            style: {
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--accent)',
              color: 'var(--accent-foreground)',
              padding: '7px 12px',
              cursor: 'pointer',
            },
          },
          `Clicked ${count} time(s)`,
        ),
        e(
          'button',
          {
            type: 'button',
            onClick: () =>
              host.rpc('ping').then((result) => setPong(JSON.stringify(result))).catch((error) => setPong(String(error))),
            style: { marginLeft: 8, padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--foreground)', cursor: 'pointer' },
          },
          'RPC ping',
        ),
        pong ? e('pre', { style: { marginTop: 12, fontSize: 11 } }, pong) : null,
        e('p', { style: { marginTop: 16, fontSize: 11, color: 'var(--foreground-subtle)' } }, `${notes} granted permission(s)`),
      );
    }

    function LabPanel(props) {
      const notes = host.plugin.permissions.filter((permission) => permission.granted).length;
      return e(
        'div',
        { style: { padding: 14, fontFamily: 'var(--font-sans)', color: 'var(--foreground)', fontSize: 12 } },
        e('strong', null, 'Trusted panel'),
        e('p', { style: { color: 'var(--foreground-muted)' } }, `${notes} permission(s) granted.`),
        e(
          'button',
          {
            type: 'button',
            onClick: () => host.rpc('storage.set', { key: 'panel-open', value: Date.now() }),
            style: { border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', background: 'transparent', color: 'var(--foreground)', cursor: 'pointer' },
          },
          'Touch plugin storage',
        ),
      );
    }

    function WelcomeOverride() {
      return e(
        'div',
        { style: { padding: 28, textAlign: 'center', fontFamily: 'var(--font-sans)', color: 'var(--foreground)' } },
        e('h1', { style: { fontSize: 22, margin: 0 } }, 'Welcome from a trusted override'),
        e(
          'p',
          { style: { color: 'var(--foreground-muted)', marginTop: 8, fontSize: 13 } },
          'The host welcome component was replaced by the Trusted Lab fixture. Disable the plugin to restore it.',
        ),
      );
    }

    function ShellWrapper(props) {
      const Host = props.Host;
      return e(
        React.Fragment,
        null,
        e(Host, props),
        e(
          'div',
          {
            style: {
              position: 'fixed',
              right: 18,
              bottom: 14,
              zIndex: 60,
              pointerEvents: 'none',
              borderRadius: 999,
              background: 'var(--accent)',
              color: 'var(--accent-foreground)',
              padding: '3px 9px',
              fontSize: 10,
              fontFamily: 'var(--font-sans)',
              opacity: 0.9,
            },
          },
          'trusted lab',
        ),
      );
    }

    function MetricView({ props }) {
      return e(
        'div',
        {
          style: {
            display: 'flex',
            gap: 12,
            alignItems: 'baseline',
            padding: 12,
            borderRadius: 12,
            background: 'var(--surface-raised)',
            color: 'var(--foreground)',
            fontFamily: 'var(--font-sans)',
          },
        },
        e('span', { style: { fontSize: 12, color: 'var(--foreground-muted)' } }, props.label),
        e('strong', { style: { fontSize: 22 } }, props.value),
        e('span', { style: { fontSize: 11, color: 'var(--accent)' } }, props.trend || 'flat'),
      );
    }

    const LabAction = () =>
      e(
        'button',
        {
          type: 'button',
          onClick: () => host.ui.openPage('lab'),
          style: { border: 0, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 12 },
        },
        'Open lab',
      );

    host.registerView('lab', Lab);
    host.registerPanel('lab-panel', LabPanel);
    host.registerComponent('Lab', Lab);
    host.registerComponent('LabPanel', LabPanel);
    host.registerComponent('MetricView', MetricView);
    host.ui.registerSlot(
      { slot: 'chat.message.actions', id: 'open-lab', layouts: ['chat'], order: 10 },
      LabAction,
    );
    host.ui.registerGenuiComponent(
      {
        id: 'metric-runtime',
        title: 'Runtime metric',
        summary: 'Metric registered by the trusted runtime',
        props: {
          label: { type: 'text', required: true, maxChars: 40 },
          value: { type: 'text', required: true, maxChars: 40 },
        },
      },
      MetricView,
    );
    host.ui.registerPreset({
      id: 'ink',
      title: 'Ink (runtime)',
      layouts: ['chat'],
      tokens: { light: { accent: '#1f6feb' }, dark: { accent: '#79b8ff' } },
    });
    host.commands.register(
      { id: 'lab-runtime', title: 'Runtime lab command', command: 'lab-runtime' },
      () => host.ui.toast('Runtime command', 'Registered by the trusted plugin'),
    );
    host.events.on('layout/changed', (detail) => {
      host.log('debug', `layout ${detail.layout}`);
    });
    host.replaceComponent('chat.welcome', WelcomeOverride);
    host.wrapComponent('layout.shell', ShellWrapper);
    host.ui.addCss(
      ':root { --plugin-lab-glow: 1; } [data-zylara-part="chat-message-user"] { outline: 1px solid var(--accent); }',
      { layouts: ['chat'], id: 'lab-chat' },
    );
    host.addGlobalCss(
      ':root { --plugin-lab-glow: 1; } .zylara-trusted-lab { outline: 1px solid var(--accent); }',
    );
    host.registerToolHandler('trusted_echo', ({ arguments: args }) => {
      const text = String(args.text || '');
      return { content: `trusted: ${text.slice(0, 4000)}`, summary: 'trusted echo' };
    });
    host.registerCommandHandler('ping', () => ({ pong: true, plugin: host.plugin.id }));
    host.on('theme', () => {});
    host.log('info', 'Trusted Lab activated');
  },
  deactivate() {
    host.log('info', 'Trusted Lab deactivated');
  },
});
