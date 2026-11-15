import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CodeXml, FilePlus, FileText, Globe, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { useReduceMotion } from '@/components/layout/hooks';
import { PluginSlot } from '@/components/plugins/PluginHosts';
import { Kbd } from '@/components/ui';
import { modKey } from '@/lib/utils';
import { BrandMark } from './BrandMark';

const EASE_OUT_SOFT: [number, number, number, number] = [0.22, 1, 0.36, 1];

interface Suggestion {
  icon: LucideIcon;
  /** Stable id used as the translation base key and the React key. */
  id: 'document' | 'web' | 'file' | 'code';
}

const SUGGESTIONS: Suggestion[] = [
  { icon: FileText, id: 'document' },
  { icon: Globe, id: 'web' },
  { icon: FilePlus, id: 'file' },
  { icon: CodeXml, id: 'code' },
];

/** Literal keys per suggestion (never built from the id at runtime). */
const SUGGESTION_KEYS: Record<
  Suggestion['id'],
  { title: string; description: string; prompt: string }
> = {
  document: {
    title: 'welcome.suggestions.document.title',
    description: 'welcome.suggestions.document.description',
    prompt: 'welcome.suggestions.document.prompt',
  },
  web: {
    title: 'welcome.suggestions.web.title',
    description: 'welcome.suggestions.web.description',
    prompt: 'welcome.suggestions.web.prompt',
  },
  file: {
    title: 'welcome.suggestions.file.title',
    description: 'welcome.suggestions.file.description',
    prompt: 'welcome.suggestions.file.prompt',
  },
  code: {
    title: 'welcome.suggestions.code.title',
    description: 'welcome.suggestions.code.description',
    prompt: 'welcome.suggestions.code.prompt',
  },
};

/** Suggestions fill the composer through a `zylara:suggest` window event. */
function fillComposer(text: string) {
  window.dispatchEvent(new CustomEvent<string>('zylara:suggest', { detail: text }));
}

/** Empty-conversation hero (DESIGN §6.1). */
export function WelcomeScreen() {
  const { t } = useTranslation('chat');
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    /* Keep the composer focused when the welcome screen mounts (after the
       composer registered its `zylara:focus-composer` listener). */
    const frame = requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('zylara:focus-composer'));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-6 pb-8 pt-10 text-center sm:pt-16">
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: reduceMotion ? 0 : 0.26, ease: EASE_OUT_SOFT }}
      >
        <span className="relative inline-flex items-center justify-center">
          <span
            aria-hidden
            className="absolute left-1/2 top-1/2 size-28 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/25 blur-2xl"
          />
          <BrandMark size={64} className="relative" />
        </span>
      </motion.div>

      <h1 className="mt-6 text-[32px] font-semibold tracking-tight text-foreground">
        {t('welcome.title')}
      </h1>
      <p className="mt-2 max-w-md text-[15px] leading-relaxed text-foreground-muted">
        {t('welcome.description')}
      </p>

      <div className="mt-8 grid w-full grid-cols-1 gap-2.5 text-left sm:grid-cols-2">
        {SUGGESTIONS.map((suggestion, index) => {
          const Icon = suggestion.icon;
          const keys = SUGGESTION_KEYS[suggestion.id];
          const title = t(keys.title);
          const description = t(keys.description);
          const prompt = t(keys.prompt);
          return (
            <motion.button
              key={suggestion.id}
              type="button"
              onClick={() => fillComposer(prompt)}
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: reduceMotion ? 0 : 0.24,
                delay: reduceMotion ? 0 : 0.04 * index,
                ease: EASE_OUT_SOFT,
              }}
              className={
                'group flex items-start gap-3 rounded-2xl bg-surface px-4 py-3.5 text-left ' +
                'transition-colors duration-150 hover:bg-surface-hover ' +
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'
              }
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-foreground-muted transition-colors duration-150 group-hover:text-accent">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-medium text-foreground">{title}</span>
                <span className="mt-0.5 block text-[12.5px] leading-relaxed text-foreground-muted">
                  {description}
                </span>
              </span>
            </motion.button>
          );
        })}
      </div>

      <PluginSlot slot="chat.welcome.actions" className="mt-4 justify-center" compact />

      <p className="mt-8 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[12px] text-foreground-subtle">
        <span className="flex items-center gap-1.5">
          <Kbd>{modKey}</Kbd>
          <Kbd>K</Kbd>
          {t('welcome.commands')}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>{modKey}</Kbd>
          <Kbd>B</Kbd>
          {t('welcome.sidebar')}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>Enter</Kbd>
          {t('welcome.send')}
        </span>
      </p>
    </div>
  );
}
