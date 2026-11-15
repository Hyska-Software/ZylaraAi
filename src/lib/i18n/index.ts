/**
 * i18next bootstrap + the small public surface shared by the app.
 *
 * Components use `useTranslation(namespace)`; stores/helpers import `t` (and
 * must be called from a component subscribed to `useTranslation`, or from a
 * store action at runtime after boot).
 */
import i18n, { type TFunction } from 'i18next';
import { initReactI18next } from 'react-i18next';

import {
  DEFAULT_LANGUAGE,
  languageMeta,
  normalizeLanguage,
  SUPPORTED_LANGUAGES,
  type AppLocale,
} from './languages';
import { resources } from './resources';

export const NAMESPACES = [
  'common',
  'chat',
  'composer',
  'models',
  'settings',
  'code',
  'agents',
  'artifacts',
  'library',
  'palette',
  'genui',
  'installer',
  'plugins',
] as const;

export const LOCALE_CACHE_KEY = 'zylara.locale';

let initPromise: Promise<void> | null = null;

function readCachedLanguage(): AppLocale | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(LOCALE_CACHE_KEY);
    return raw ? normalizeLanguage(raw) : null;
  } catch {
    return null;
  }
}

/** Applies `<html lang>`/`<html dir>` from the active locale. */
export function applyDocumentLanguage(locale: AppLocale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  document.documentElement.dir = languageMeta(locale).direction;
}

export function getLanguage(): AppLocale {
  return normalizeLanguage(i18n.language);
}

export async function setLanguage(
  code: unknown,
  options: { persist?: boolean } = {},
): Promise<void> {
  const next = normalizeLanguage(code);
  await i18n.changeLanguage(next);
  applyDocumentLanguage(next);
  if (options.persist !== false && typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(LOCALE_CACHE_KEY, next);
    } catch {
      // Storage can be unavailable in private/restricted webviews; the backend
      // setting remains the source of truth.
    }
  }
}

/**
 * Idempotent bootstrap. Resolves only after i18next has loaded the bundled
 * resources, so callers can render without a language flash/race.
 */
export function initI18n(options: {
  initial?: AppLocale;
  useCache?: boolean;
} = {}): Promise<void> {
  if (initPromise) return initPromise;

  const initial =
    options.initial ??
    (options.useCache === false ? DEFAULT_LANGUAGE : readCachedLanguage() ?? DEFAULT_LANGUAGE);

  initPromise = i18n
    .use(initReactI18next)
    .init({
      resources,
      lng: initial,
      fallbackLng: DEFAULT_LANGUAGE,
      supportedLngs: SUPPORTED_LANGUAGES.map((language) => language.code),
      defaultNS: 'common',
      ns: NAMESPACES,
      interpolation: { escapeValue: false },
      returnNull: false,
      react: { useSuspense: false },
    })
    .then(() => {
      applyDocumentLanguage(initial);
    });

  return initPromise;
}

/** Typed global translator for non-React modules. */
export const t = i18n.t.bind(i18n) as TFunction;

export { i18n };
export type { AppLocale };
