import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseGenUI } from '@/lib/genui';
import { GenUIBlock } from '@/components/genui/GenUIBlock';

vi.mock('@/lib/genui/open-external', () => ({
  openExternal: vi.fn(() => Promise.resolve(true)),
  isExternalUrl: (url: string) => /^https?:\/\//i.test(url),
}));

afterEach(() => cleanup());

const reportedBlock = {
  components: [
    {
      type: 'card',
      props: {
        title: 'What you can do next',
        subtitle: 'Recommended path for this Windows machine',
      },
      children: [
        {
          type: 'table',
          props: {
            columns: ['Option', 'What it enables', 'Effort', 'Recommendation'],
            rows: [
              ['Run with llama.cpp', 'Local chat with low memory use; can use CPU or the RTX 2060', 'Low', 'Best first step'],
              ['Use LM Studio', 'Graphical local chat with an OpenAI-compatible API', 'Low', 'Easiest for daily use'],
              ['Use Transformers', 'Native multimodal inference, custom Python code, image/video tests', 'Medium', 'Best for development'],
              ['Fine-tune with LoRA', 'Adapt the model to a specific task or writing style', 'High', 'After validating the use case'],
              ['Build an application', 'Chat UI, RAG, extraction, function calling or agent', 'Medium to high', 'After choosing a runtime'],
              ['Integrate with Zylara', 'Use the model as a local provider inside this project', 'Medium to high', 'Useful if it will power the app'],
            ],
          },
        },
        {
          type: 'text',
          props: {
            text: 'Recommended order: download the Q4_0 GGUF (about 537 MiB), run a first text-generation test, optionally download the 198 MiB vision projector, then expose a local OpenAI-compatible API. Q4_0 should fit comfortably in the 4 GB GPU; start with a small context and verify actual VRAM usage.',
            variant: 'strong',
          },
        },
      ],
    },
    {
      type: 'card',
      props: {
        title: 'Choose the next step',
        subtitle: 'Actions only fill the composer so you can review before sending',
      },
      children: [
        {
          type: 'actions',
          props: {
            items: [
              {
                label: 'Set up llama.cpp runtime',
                prompt: 'Set up llama.cpp for Qwen3.5-0.8B on this machine. Download the official Q4_0 GGUF and vision projector into a new folder on H:\\, use CPU or RTX 2060 acceleration as appropriate, and run a real generation smoke test.',
                tone: 'primary',
                icon: 'download',
              },
              {
                label: 'Prepare LM Studio guide',
                prompt: 'Give me a step-by-step guide to load Qwen3.5-0.8B in LM Studio, enable its local API and test it from another application.',
                tone: 'secondary',
                icon: 'settings',
              },
              {
                label: 'Create Transformers environment',
                prompt: 'Create an isolated Python environment to load H:\\Qwen3.5-0.8B with Hugging Face Transformers and provide scripts for text and image inference.',
                tone: 'secondary',
                icon: 'code',
              },
              {
                label: 'Plan fine-tuning',
                prompt: 'Create a practical plan to fine-tune Qwen3.5-0.8B with LoRA on this hardware, including dataset format, required dependencies and expected limitations.',
                tone: 'ghost',
                icon: 'sparkles',
              },
            ],
          },
        },
      ],
    },
    {
      type: 'card',
      props: {
        title: 'Official runtime references',
        subtitle: 'Supported formats and deployment options',
      },
      children: [
        {
          type: 'stack',
          props: { direction: 'row', wrap: true },
          children: [
            { type: 'link', props: { label: 'Official GGUF repository', href: 'https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF' } },
            { type: 'link', props: { label: 'Qwen model card', href: 'https://huggingface.co/Qwen/Qwen3.5-0.8B' } },
            { type: 'link', props: { label: 'llama.cpp build documentation', href: 'https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md' } },
            { type: 'link', props: { label: 'LM Studio', href: 'https://lmstudio.ai/' } },
          ],
        },
      ],
    },
  ],
};

describe('reported runtime options GenUI block', () => {
  it('parses and normalizes every component without errors', () => {
    const result = parseGenUI(JSON.stringify(reportedBlock));

    expect(result.error).toBeNull();
    expect(result.spec?.components).toHaveLength(3);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(result.warnings.map((diagnostic) => diagnostic.code)).toEqual(['ui.icon-unknown']);
  });

  it('renders the complete block without falling back to raw JSON', () => {
    const { container } = render(createElement(GenUIBlock, { source: JSON.stringify(reportedBlock) }));

    expect(container.querySelector('.zylara-genui')).toBeTruthy();
    expect(screen.getByText('What you can do next')).toBeTruthy();
    expect(screen.getByText('Run with llama.cpp')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set up llama.cpp runtime' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Official GGUF repository' })).toBeTruthy();
    expect(screen.queryByText(/ui\.invalid-json/)).toBeNull();
  });

  it('keeps the complete block visible after incremental streaming updates', () => {
    const source = JSON.stringify(reportedBlock);
    const fenced = ['```ui', source, '```'].join('\n');
    const view = render(createElement(GenUIBlock, { source: fenced.slice(0, -120) }));

    expect(screen.queryByText('What you can do next')).toBeNull();

    view.rerender(createElement(GenUIBlock, { source: fenced.slice(0, -20) }));
    expect(screen.queryByText('What you can do next')).toBeNull();

    view.rerender(createElement(GenUIBlock, { source: fenced }));
    expect(view.container.querySelector('.zylara-genui')).toBeTruthy();
    expect(screen.getByText('What you can do next')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set up llama.cpp runtime' })).toBeTruthy();
  });
});
