/**
 * Public inputs for the bundled model catalog.
 *
 * The pages below are the only public, credential-free sources for the gateway
 * model tables. `sync-catalog.mjs` fetches them before every build so new
 * models do not need a manual catalog edit.
 */

export const DOC_SOURCES = [
  {
    provider: 'go',
    label: 'OpenCode Go',
    url: 'https://opencode.ai/v2/docs/console/go/',
  },
  {
    provider: 'zen',
    label: 'OpenCode Zen',
    url: 'https://opencode.ai/v2/docs/console/models/',
  },
];

export const MODELS_DEV_URL = 'https://models.dev/api.json';

export const LIVE_MODEL_SOURCES = [
  {
    provider: 'go',
    url: 'https://opencode.ai/inference/go/v1/models',
  },
  {
    provider: 'zen',
    url: 'https://opencode.ai/inference/v1/models',
  },
];

const MODEL_ID = /^[a-z0-9][a-z0-9.\-]*$/;

const NAMED_ENTITIES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

/** Decodes the entities the docs pages use without pulling a parser package. */
export function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
    if (code.startsWith('#')) {
      const hex = code[1]?.toLowerCase() === 'x';
      const digits = code.slice(hex ? 2 : 1);
      const point = Number.parseInt(digits, hex ? 16 : 10);
      if (Number.isFinite(point) && point <= 0x10ffff) {
        try {
          return String.fromCodePoint(point);
        } catch {
          return entity;
        }
      }
      return entity;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? entity;
  });
}

function plainText(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Splits the HTML into per-table row lists so headers can drive parsing. */
function tableBlocks(html) {
  const blocks = [];
  for (const table of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [];
    for (const row of table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [];
      for (const cell of row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        const withCode = cell[1].replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
        cells.push(plainText(withCode));
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) blocks.push(rows);
  }
  return blocks;
}

export function protocolForEndpoint(endpoint) {
  if (!endpoint) return null;
  if (endpoint.includes('/openai/v1/chat/completions')) return 'openai-chat';
  if (endpoint.includes('/openai/v1/responses')) return 'openai-responses';
  if (endpoint.includes('/anthropic/v1/messages')) return 'anthropic';
  if (endpoint.includes('/google/v1beta/models/')) return 'google';
  return null;
}

/**
 * Extracts model rows from any current docs table: the original
 * `Model | Model ID | Endpoint | AI SDK Package` layout and the newer
 * `Model | Model ID | Input | Output | ...` pricing layout. The endpoint is
 * optional because the live model lists carry the authoritative wire protocol.
 * Returns `{ id, name, endpoint, protocol }` in page order, deduplicated by id.
 */
export function parseDocsModels(html) {
  const models = [];
  const seen = new Set();
  for (const rows of tableBlocks(html)) {
    const header = rows[0] ?? [];
    const idIndex = header.findIndex((cell) => /^model\s*id$/i.test(cell));
    if (idIndex < 0) continue;
    const nameIndex = header.findIndex((cell) => /^model(?!\s*id)/i.test(cell));
    const endpointIndex = header.findIndex((cell) => /endpoint/i.test(cell));
    for (const cells of rows.slice(1)) {
      if (cells.length !== header.length) continue;
      const id = (cells[idIndex] ?? '').replaceAll('`', '').trim();
      if (!MODEL_ID.test(id) || seen.has(id)) continue;
      const endpoint = endpointIndex >= 0 ? cells[endpointIndex].replaceAll('`', '').trim() : '';
      const protocol = endpointIndex >= 0 ? protocolForEndpoint(endpoint) : null;
      // A present but unknown endpoint is a broken row; an absent endpoint is
      // valid in the pricing tables and is resolved from the live list.
      if (endpointIndex >= 0 && !protocol) continue;
      seen.add(id);
      models.push({
        id,
        name: nameIndex >= 0 ? cells[nameIndex] : '',
        endpoint: endpoint || null,
        protocol,
      });
    }
  }
  return models;
}

/**
 * A docs page must look like a model table, not an error page or a redesign.
 * Go now publishes a short pricing table, so the floor is small; a genuine
 * gateway table still has dozens of rows.
 */
export function assertDocsModels(models, label) {
  if (!Array.isArray(models) || models.length < 2) {
    throw new Error(`${label}: tabela de modelos inesperada (${models?.length ?? 0} linhas)`);
  }
  return models;
}

const LIVE_API_PROTOCOLS = [
  ['chat-completions', 'openai-chat'],
  ['responses', 'openai-responses'],
  ['messages', 'anthropic'],
  ['generate-content', 'google'],
];

/** Maps a live `/v1/models` API key to the wire protocol the app can speak. */
export function protocolForLiveApi(apiName) {
  return LIVE_API_PROTOCOLS.find(([key]) => key === apiName)?.[1] ?? null;
}

/**
 * Reads a public OpenCode `GET /v1/models` response. Only chat models with at
 * least one supported protocol are selectable: decision, embedding, image,
 * video and realtime entries use APIs this app does not implement.
 */
export function parseLiveModels(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(rows)) return [];
  const models = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || row.type !== 'chat') continue;
    const id = String(row.id ?? '');
    if (!MODEL_ID.test(id) || seen.has(id)) continue;
    const protocols = LIVE_API_PROTOCOLS.filter(([key]) => row.api?.[key]).map(([, protocol]) => protocol);
    if (!protocols.length) continue;
    seen.add(id);
    models.push({ id, name: String(row.name ?? ''), protocols, raw: row });
  }
  return models;
}

export function assertLiveModels(models, label) {
  if (!Array.isArray(models) || models.length < 10) {
    throw new Error(`${label}: lista de modelos inesperada (${models?.length ?? 0} linhas)`);
  }
  return models;
}
