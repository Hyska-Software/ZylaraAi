#!/usr/bin/env node
/**
 * Regenerates every brand asset derived from `assets/Zylara_Logo.svg`.
 *
 * The original export is a 5225x5225 square canvas whose artwork is centred at
 * (2612.5, 2612.5) and spans about 99% of the width. Shipping it as-is would
 * leave the OS icon glued to the edges, so the derived vectors below crop the
 * art (`zylara-mark.svg`), mount it on the light tile (`zylara-tile.svg`) and
 * pad the square app-icon canvas by 400 units on each side.
 *
 * It also emits `src/components/chat/brandMarkArt.ts`, the same paths as typed
 * layers so the UI can paint the mark with the active theme tokens. The public
 * vector stays the reference for the default theme.
 *
 * Usage: pnpm brand
 *        node scripts/build-brand.mjs --skip-icons   # vectors + renderer module only
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = path.join(root, 'assets/Zylara_Logo.svg');
const markFile = path.join(root, 'public/brand/zylara-mark.svg');
const tileFile = path.join(root, 'public/brand/zylara-tile.svg');
const artModuleFile = path.join(root, 'src/components/chat/brandMarkArt.ts');
const appIconVector = path.join(root, 'assets/app-icon.svg');
const appIconPng = path.join(root, 'app-icon.png');
const tauriCli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');

/** Art bounding box measured from a 512 px alpha render of the source SVG. */
const ART = { x: 20, y: 163, width: 5185, height: 4900 };
/** Transparent padding around the art, in source units (canvas becomes 6025). */
const PADDING = 400;
const SQUARE = 5225 + PADDING * 2;
/** The tile keeps the historical composition: art at 1150 px inside 1254. */
const TILE = 1254;
const TILE_ART_WIDTH = 1150;
const TILE_SCALE = TILE_ART_WIDTH / ART.width;
const TILE_OFFSET = (TILE - 5225 * TILE_SCALE) / 2;

const STYLE = 'fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2;';

/** Official fills → renderer tone of the mark (body, muzzle/ear details, eye). */
const TONES = new Map([
  ['#5e34fb', 'body'],
  ['#5e34fa', 'body'],
  ['#eadffc', 'detail'],
  ['#e9defc', 'detail'],
  ['#e8defc', 'detail'],
  ['#0f0f0f', 'eye'],
]);

function readSource() {
  const source = readFileSync(sourceFile, 'utf8');
  const group = source.match(/<g id="Fundo">([\s\S]*?)<\/g>/);
  if (!group) throw new Error(`Grupo "Fundo" não encontrado em ${sourceFile}`);
  const paths = group[1].match(/<path[\s\S]*?\/>/g)?.map((element) => element.trim());
  if (!paths?.length) throw new Error(`Nenhum path encontrado em ${sourceFile}`);
  return paths;
}

function svg({ viewBox, width, height, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}" style="${STYLE}" role="img" aria-label="Zylara">\n${body}\n</svg>\n`;
}

function writeVectors(paths) {
  const group = paths.map((element) => `    ${element}`).join('\n');

  const mark = svg({
    viewBox: `${ART.x - 2} ${ART.y - 2} ${ART.width + 4} ${ART.height + 4}`,
    width: ART.width + 4,
    height: ART.height + 4,
    body: `  <g id="Zylara">\n${group}\n  </g>`,
  });

  const tile = svg({
    viewBox: `0 0 ${TILE} ${TILE}`,
    width: TILE,
    height: TILE,
    body: [
      `  <rect x="0" y="0" width="${TILE}" height="${TILE}" rx="184.412" ry="184.412" fill="#EBEBEB"/>`,
      `  <g id="Zylara" transform="translate(${TILE_OFFSET.toFixed(2)} ${TILE_OFFSET.toFixed(2)}) scale(${TILE_SCALE.toFixed(5)})">`,
      group,
      '  </g>',
    ].join('\n'),
  });

  const appIcon = svg({
    viewBox: `${-PADDING} ${-PADDING} ${SQUARE} ${SQUARE}`,
    width: SQUARE,
    height: SQUARE,
    body: `  <g id="Zylara">\n${group}\n  </g>`,
  });

  writeFileSync(markFile, mark);
  writeFileSync(tileFile, tile);
  writeFileSync(appIconVector, appIcon);
  console.log(`[brand] vetores: ${path.relative(root, markFile)}, ${path.relative(root, tileFile)}, ${path.relative(root, appIconVector)}`);
}

/**
 * Emits the typed artwork consumed by `BrandMark`: same paths, same paint order
 * and the tile-less viewBox of `zylara-mark.svg`, plus the layer tone used by
 * the themed rendering.
 */
function writeArtModule(paths) {
  const entries = paths.map((element) => {
    const d = element.match(/\sd="([^"]+)"/)?.[1];
    if (!d) throw new Error(`Path sem "d" em ${sourceFile}`);
    if (d.includes("'")) throw new Error(`Path com aspas não suportado em ${sourceFile}`);
    const fill = element.match(/fill:(#[0-9a-fA-F]{3,8})/)?.[1].toLowerCase();
    const tone = fill ? TONES.get(fill) : undefined;
    if (!tone) throw new Error(`Preenchimento inesperado (${fill ?? 'ausente'}) em ${sourceFile}`);
    return `  { d: '${d}', tone: '${tone}' },`;
  });

  const box = {
    x: ART.x - 2,
    y: ART.y - 2,
    width: ART.width + 4,
    height: ART.height + 4,
  };

  const module = `/**
 * Zylara mark artwork for the theme-aware renderer.
 *
 * Generated by \`pnpm brand\` (scripts/build-brand.mjs) from \`assets/Zylara_Logo.svg\`.
 * Paths, paint order and viewBox are identical to \`public/brand/zylara-mark.svg\`;
 * \`src/lib/__tests__/brandAssets.test.ts\` fails when they drift. Do not edit by hand.
 */
export type BrandMarkTone = 'body' | 'detail' | 'eye';

export interface BrandMarkPath {
  /** Path data of the official artwork. */
  d: string;
  /** Layer role; the themed render maps it to a design token. */
  tone: BrandMarkTone;
}

/** Drawable area of the mark (\`viewBox\`), cropped to the artwork. */
export const BRAND_MARK_BOX = {
  x: ${box.x},
  y: ${box.y},
  width: ${box.width},
  height: ${box.height},
} as const;

/** Artwork layers in paint order. */
export const BRAND_MARK_PATHS: readonly BrandMarkPath[] = [
${entries.join('\n')}
];
`;

  writeFileSync(artModuleFile, module);
  console.log(`[brand] arte do renderer: ${path.relative(root, artModuleFile)}`);
}

function runIcon(args) {
  execFileSync(process.execPath, [tauriCli, 'icon', ...args], {
    cwd: root,
    stdio: 'inherit',
  });
}

function writePngMaster(scratch) {
  const out = path.join(scratch, 'app');
  runIcon([appIconVector, '-p', '1024', '-o', out]);
  const generated = path.join(out, '1024x1024.png');
  copyFileSync(generated, appIconPng);
  console.log(`[brand] master: ${path.relative(root, appIconPng)} (1024x1024, transparente)`);
}

function writeIcons(scratch) {
  runIcon([appIconPng]);
  console.log('[brand] ícones transparentes para Windows/Linux em src-tauri/icons');

  const out = path.join(scratch, 'tile');
  runIcon([tileFile, '-o', out]);
  copyFileSync(path.join(out, 'icon.icns'), path.join(root, 'src-tauri/icons/icon.icns'));
  console.log('[brand] icon.icns macOS: tile grafite-claro');
}

const paths = readSource();
writeVectors(paths);
writeArtModule(paths);

if (process.argv.includes('--skip-icons')) {
  console.log('[brand] --skip-icons: master PNG e ícones do SO não foram regerados');
} else {
  const scratch = mkdtempSync(path.join(tmpdir(), 'zylara-brand-'));
  try {
    writePngMaster(scratch);
    writeIcons(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
