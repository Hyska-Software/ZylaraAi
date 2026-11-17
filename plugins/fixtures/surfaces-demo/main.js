/*
 * Acceptance fixture for the plugin UI surfaces: it wraps the Code workbench,
 * replaces the Settings page and ships a declarative palette action.
 *
 * It exercises exactly the three surfaces the plan required to be pluggable:
 *   - `code.workbench` (wrap, host tree arrives as `children`)
 *   - `settings.page`  (replace, host tab name arrives as `tab`)
 *   - `palette.actions` (declarative slot, declared in manifest.json)
 */
host.registerPlugin({
  activate(host) {
    const React = host.react;
    const e = React.createElement;

    function Workbench(props) {
      return e(
        'div',
        { style: { display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' } },
        e(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              background: 'var(--accent-soft)',
              color: 'var(--foreground)',
              fontFamily: 'var(--font-sans)',
              fontSize: 12,
            },
          },
          e('strong', null, 'Acme workbench wrapper'),
          e(
            'span',
            { style: { color: 'var(--foreground-muted)' } },
            `layout: ${props.layout ?? 'unknown'}`,
          ),
        ),
        e('div', { style: { display: 'flex', minHeight: 0, flex: 1, flexDirection: 'column' } }, props.children),
      );
    }

    function SettingsPage(props) {
      return e(
        'div',
        {
          style: {
            padding: 24,
            fontFamily: 'var(--font-sans)',
            color: 'var(--foreground)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          },
        },
        e('h2', { style: { fontSize: 15, margin: 0 } }, 'Acme settings'),
        e(
          'p',
          { style: { fontSize: 12, color: 'var(--foreground-muted)', margin: 0 } },
          `Replaced by the trusted fixture — host tab: ${props.tab ?? 'unknown'}.`,
        ),
      );
    }

    host.wrapComponent('code.workbench', Workbench);
    host.replaceComponent('settings.page', SettingsPage);
    host.log('info', 'Surfaces fixture activated');
  },
  deactivate() {
    host.log('info', 'Surfaces fixture deactivated');
  },
});
