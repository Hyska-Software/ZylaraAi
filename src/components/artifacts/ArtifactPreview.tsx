import { HtmlPreview } from '@/components/genui';
import { cn } from '@/lib/utils';
import { usePluginUi } from '@/lib/plugins/ui/registry';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { PluginArtifactViewer } from '@/components/plugins/PluginHosts';
import { ArchivePreview } from './ArchivePreview';
import { AudioPreview } from './AudioPreview';
import { BinaryPreview } from './BinaryPreview';
import { CodePreview } from './CodePreview';
import { CsvPreview } from './CsvPreview';
import { DocxPreview } from './DocxPreview';
import { ImagePreview, SvgPreview } from './ImagePreview';
import { JsonPreview } from './JsonPreview';
import { MarkdownPreview } from './MarkdownPreview';
import { PdfPreview } from './PdfPreview';
import { PptxPreview } from './PptxPreview';
import { VideoPreview } from './VideoPreview';
import { XlsxPreview } from './XlsxPreview';
import type { ArtifactViewProps } from './previewSupport';

export type ArtifactPreviewProps = ArtifactViewProps;

/**
 * Type-aware artifact preview used by the side panel. Every branch renders from
 * the artifact content already loaded by `ArtifactPanel`; heavy formats fetch
 * their structured preview through `api.getArtifactPreview` inside the
 * component, and unrenderable artifacts fall back to the binary card.
 */
export function ArtifactPreview({ content, className, showArtifactActions }: ArtifactPreviewProps) {
  const { artifact } = content;
  const ui = usePluginUi();
  const pluginUiEnabled = usePluginUiPrefs((state) => state.enabled);
  const mime = artifact.mimeType.trim().toLowerCase();
  const viewer = (pluginUiEnabled ? [...ui.artifactViewers] : [])
    .sort((left, right) => left.priority - right.priority)
    .find((entry) =>
      entry.mimeTypes.some((pattern) => {
        const normalized = pattern.trim().toLowerCase();
        return normalized === mime || (normalized.endsWith('/*') && mime.startsWith(normalized.slice(0, -1)));
      }),
    );
  if (viewer) {
    return (
      <PluginArtifactViewer
        viewer={{
          plugin: viewer.plugin,
          viewer: {
            id: viewer.id,
            title: viewer.title,
            titleKey: viewer.titleKey,
            mimeTypes: viewer.mimeTypes,
            entry: viewer.entry,
            component: null,
            priority: viewer.priority,
          },
          key: viewer.key,
          component: viewer.component,
        }}
        content={content}
        className={className}
        showArtifactActions={showArtifactActions}
      />
    );
  }

  switch (artifact.kind) {
    case 'markdown':
      return <MarkdownPreview content={content} className={className} />;
    case 'code':
    case 'text':
      return <CodePreview content={content} className={className} />;
    case 'json':
      return <JsonPreview content={content} className={className} />;
    case 'csv':
      return <CsvPreview content={content} className={className} />;
    case 'html':
      return (
        <div className={cn('h-full overflow-auto p-3', className)}>
          <HtmlPreview html={content.content ?? ''} title={artifact.name} />
        </div>
      );
    case 'svg':
      return <SvgPreview content={content} className={className} />;
    case 'image':
      return (
        <ImagePreview
          content={content}
          className={className}
          showArtifactActions={showArtifactActions}
        />
      );
    case 'audio':
      return <AudioPreview content={content} className={className} />;
    case 'video':
      return <VideoPreview content={content} className={className} />;
    case 'archive':
      return <ArchivePreview content={content} className={className} />;
    case 'pdf':
      return (
        <PdfPreview
          content={content}
          className={className}
          showArtifactActions={showArtifactActions}
        />
      );
    case 'docx':
      return <DocxPreview content={content} className={className} />;
    case 'xlsx':
      return <XlsxPreview content={content} className={className} />;
    case 'pptx':
      return <PptxPreview content={content} className={className} />;
    case 'binary':
    default:
      return (
        <BinaryPreview
          content={content}
          className={className}
          showArtifactActions={showArtifactActions}
        />
      );
  }
}
