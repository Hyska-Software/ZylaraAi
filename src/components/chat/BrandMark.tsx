import { BUILTIN_THEME_ID, useThemeStore } from '@/lib/store/themeStore';
import { cn } from '@/lib/utils';
import { BRAND_MARK_BOX, BRAND_MARK_PATHS, type BrandMarkTone } from './brandMarkArt';

export type BrandMarkVariant = 'mark' | 'tile';
export type BrandMarkTint = 'theme' | 'brand';

export interface BrandMarkProps {
  /** Height of the mark in pixels. The `tile` variant is square. */
  size?: number;
  /**
   * `mark` — official symbol without background, for inline use (chrome row,
   * avatar, welcome, splash, About) and for the Windows/Linux icons. `tile` —
   * icon with the light graphite tile, for the favicon, the installer UI and
   * the macOS icon.
   */
  variant?: BrandMarkVariant;
  className?: string;
  /** Soft pulse used while the assistant reasons. */
  animated?: boolean;
  /**
   * `theme` (default) paints the symbol with the active theme: body in
   * `accent`, details in `background` and the eye in `foreground`. The built-in
   * Zylara theme keeps the official artwork untouched. `brand` always keeps the
   * official artwork. Only the `mark` variant follows the theme.
   */
  tint?: BrandMarkTint;
}

const SOURCES: Record<BrandMarkVariant, string> = {
  mark: '/brand/zylara-mark.svg',
  tile: '/brand/zylara-tile.svg',
};

/** Themed paint of each artwork layer (`brandMarkArt.ts`). */
const TONE_CLASS: Record<BrandMarkTone, string> = {
  body: 'fill-accent',
  detail: 'fill-background',
  eye: 'fill-foreground',
};

const VIEW_BOX = `${BRAND_MARK_BOX.x} ${BRAND_MARK_BOX.y} ${BRAND_MARK_BOX.width} ${BRAND_MARK_BOX.height}`;
const ASPECT = BRAND_MARK_BOX.width / BRAND_MARK_BOX.height;

/**
 * Official Zylara mark (DESIGN §2).
 *
 * The vectors live in `public/brand/` and derive from the original asset:
 * `zylara-mark.svg` is the symbol without background (cropped to the art) and
 * `zylara-tile.svg` is the full icon with the light graphite tile. The default
 * theme renders the shipped vector as `<img>` (kept out of the JS bundle, crisp
 * at any size); any other theme inlines the same layers so the fills can follow
 * the theme tokens.
 */
export function BrandMark({
  size = 24,
  variant = 'mark',
  className,
  animated = false,
  tint = 'theme',
}: BrandMarkProps) {
  const activeId = useThemeStore((state) => state.activeId);
  const classes = cn('shrink-0 select-none', animated && 'animate-pulse-soft', className);
  const themed = variant === 'mark' && tint === 'theme' && activeId !== BUILTIN_THEME_ID;

  if (!themed) {
    const square = variant === 'tile';
    return (
      <img
        src={SOURCES[variant]}
        alt=""
        aria-hidden
        draggable={false}
        className={classes}
        style={square ? { width: size, height: size } : { height: size, width: 'auto' }}
      />
    );
  }

  return (
    <svg
      viewBox={VIEW_BOX}
      width={Math.round(size * ASPECT * 100) / 100}
      height={size}
      aria-hidden
      focusable="false"
      fillRule="evenodd"
      clipRule="evenodd"
      strokeLinejoin="round"
      strokeMiterlimit={2}
      className={classes}
    >
      {BRAND_MARK_PATHS.map((path) => (
        <path key={path.d} d={path.d} className={TONE_CLASS[path.tone]} />
      ))}
    </svg>
  );
}
