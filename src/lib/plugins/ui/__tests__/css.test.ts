// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { rewritePluginCssUrls, sanitizePluginCss } from '@/lib/plugins/ui/css';

describe('plugin css sanitizer', () => {
  it('rejects imports, external urls and script expressions', () => {
    expect(sanitizePluginCss('@import "x.css";').error).toContain('PLUGIN_CSS_REJECTED');
    expect(sanitizePluginCss('a{background:url(https://evil.example/x)}').error).toContain(
      'PLUGIN_CSS_REJECTED',
    );
    expect(sanitizePluginCss('a{width:expression(1)}').error).toContain('PLUGIN_CSS_REJECTED');
  });

  it('accepts scoped host selectors and data urls', () => {
    const result = sanitizePluginCss(
      '[data-zylara-part="chat"] .bubble{background:var(--user-bubble);color:var(--foreground)}' +
        '.icon{background-image:url(data:image/svg+xml;base64,AAA)}',
    );
    expect(result.error).toBeNull();
    expect(result.css).toContain('[data-zylara-part="chat"]');
  });

  it('rewrites relative urls to the plugin asset origin', () => {
    const css = rewritePluginCssUrls(
      '.x{background:url(assets/paper.png)} .y{background:url("/absolute.png")}',
      'com.acme.studio',
      'ui/theme.css',
    );
    expect(css).toContain('zplugin');
    expect(css).toContain('ui/assets/paper.png');
    expect(css).toContain('url("/absolute.png")');
  });
});
