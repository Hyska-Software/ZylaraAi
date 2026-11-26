# Parâmetros de thinking dinâmicos a partir do catálogo de modelos — análise e plano

**Data:** 2026-11-26.
**Status:** **implementado e verificado** (D1–D6).
**Pergunta:** é possível usar os parâmetros normais de thinking dos modelos no lugar dos "modos"
hardcoded atuais, com um mecanismo dinâmico que lê os dados do banco de modelos?

## 1. Veredito

Sim. O dado já existe e já chega ao renderer: `ModelInfo.reasoning_options` é proveniente de
`data/catalog.json` (embutido em `src-tauri/src/catalog.rs:9`), com as variantes
`Toggle`, `Effort { values }` e `BudgetTokens { min, max }` (`catalog.rs:223-307`). O renderer
expõe isso via `CatalogView` e já deriva controles em `reasoningUi` (`src/lib/catalog.ts:173-192`),
`defaultReasoningFor` (`:136-161`) e `thinkingOptions` (`src/lib/modelMenu.ts:539-596`).

O que falta não é criar a fonte de dados, e sim **remover os pontos que ainda achatam ou fixam**
os valores antes/depois dessa fonte. A mudança é aditiva e compatível com os protocolos HTTP
existentes: `ReasoningRequest::Effort(String)` e `Budget(u32)` (`src-tauri/src/providers/mod.rs:269-275`)
já aceitam valores arbitrários declarados pelo modelo; os adaptadores validam contra
`offers_effort(model, value)` (`src-tauri/src/providers/reasoning.rs:71-75`).

## 2. Estado atual — o que já é dinâmico

| Camada | Evidência | Comportamento |
| --- | --- | --- |
| Catálogo | `src-tauri/src/catalog.rs:223-307`, `data/catalog.json` | `reasoningOptions` por modelo, com valores de esforço e intervalo de orçamento reais. |
| Geração do catálogo | `scripts/build-catalog.mjs:303,325,502-528` | Lê `reasoning_options` do models.dev/Go e sanitiza `budget_tokens`; valores são preservados. |
| Renderer | `src/lib/catalog.ts:136-192`, `src/lib/modelMenu.ts:447-596`, `ThinkingSelector.tsx`, `ThinkingLevelSlider.tsx` | Controles, ordem e padrão derivados de `model.reasoningOptions`. |
| Backend HTTP | `src-tauri/src/providers/reasoning.rs:39-75` | Só envia `effort` ou `budget` quando o modelo declara essa opção/valor. |
| ACP | `src-tauri/src/acp/mod.rs:188-221`, `src-tauri/src/state.rs:387-424` | Valores vêm do `configOption` do agente; se ausentes, cai para o catálogo pelo id do modelo. O agente é dono do config, então Zylara não injeta parâmetro não declarado. |

## 3. Pontos ainda hardcoded (alvo do plano)

| ID | Onde | Problema |
| --- | --- | --- |
| H1 | `src-tauri/src/commands/models.rs:70,175-184` | `REASONING_EFFORTS = ["low","medium","high","xhigh","max"]`: ao descobrir modelos da conta, só esses cinco nomes são lidos de `capabilities.effort`. `minimal`, `none` e nomes específicos de provedor são descartados. |
| H2 | `src/lib/types.ts:2396`, `src-tauri/src/domain.rs:1455,1648`, `src-tauri/src/config.rs:153-158`, `src/components/settings/ModelTab.tsx:18-35` | `reasoningDefault` é uma união fixa (`auto/off/low/medium/high/max`); `reasoningDefaultOf` transforma `minimal` em `low`, `xhigh` em `max` e qualquer budget em `auto`. O valor persistido não é o parâmetro real do modelo. |
| H3 | `src/lib/modelMenu.ts:487-529` | `BUDGET_PRESET_BUDGETS` e textos fixos para quatro valores; modelos com faixa diferente só recebem esses presets filtrados, nunca min/médio/max declarados. |
| H4 | `src-tauri/src/providers/reasoning.rs:25-37` | `budget_for_effort` usa tabela fixa (512…16384) quando o modelo declara `budget_tokens` mas o usuário escolheu `effort`. Ignora `min`/`max` reais do modelo. |
| H5 | `src-tauri/src/tools/agents.rs:154` | Schema da ferramenta de subagente anuncia `enum` fixo de esforços; não acompanha o modelo atual. |
| H6 | `src-tauri/src/acp/mod.rs:213` | `ORDER` fixo para ordenação; **mantém** valores desconhecidos (posição 99, truncamento em 12), então é apenas preferência de exibição — não bloqueante. |

## 4. Mecanismo proposto

### D1 — Resolvedor único de default (renderer)

Novo helper puro em `src/lib/catalog.ts`:
`resolveReasoningSelection(settings, model, preferred?)` → `ReasoningSelection | null`.

Regras:
1. `model.reasoningOptions` é a única fonte de valores válidos.
2. Preferência persistida (`settings.reasoningDefault`) é aplicada **somente** se o modelo a oferece;
   caso contrário, usa `defaultReasoningFor(model)` — nunca inventa um valor.
3. `off` só quando `reasoningUi(model).canDisable`; `budget:N` só dentro de `[min,max]`.
4. Prioridade por par de chaves `(providerId, modelId)`; ids de modelo se repetem entre provedores
   (`catalog.rs:327-332`), então resolver por id isolado é proibido.

`ModelTab.tsx` passa a persistir a seleção exata (ex.: `"effort:xhigh"`, `"budget:32768"`, `"off"`,
`"auto"`) em vez de `reasoningDefaultOf`. `defaultSelectionFrom` passa a chamar o resolvedor.

### D2 — Compatibilidade de settings (renderer + Rust)

- `Settings.reasoningDefault` continua `String` em Rust (`domain.rs:1455`) e vira `string` em TS;
  a união hardcoded é removida do tipo.
- `config::normalize_settings` (`config.rs:153-158`) valida formato seguro (`auto`, `off`,
  `effort:<valor>` ou `budget:<n>`; regex/curto, sem caracteres de controle) em vez da lista fixa.
- Valores antigos (`low|medium|high|max`) continuam válidos como `effort:<valor>`; `auto` mantém
  o significado atual; default de fábrica permanece `max` para não alterar comportamento existente.
- Testes de normalização cobrem valor novo, valor inválido e legado.

### D3 — Descoberta dinâmica de modelos da conta (backend)

Substituir `REASONING_EFFORTS` em `commands/models.rs` por leitura das chaves de
`capabilities.effort` com `supported:true`, preservando o nome exato declarado pelo provedor.
Ordenação: valores conhecidos primeiro (mesma ordem de `acp/mod.rs:213`), desconhecidos depois;
limite de 16 valores e deduplicação. Quando o id `(provider,model)` existe no catálogo embutido,
os valores do catálogo têm precedência — a inferência só preenche modelos não catalogados.

### D4 — Orçamento derivado do modelo (backend)

`budget_for_effort(effort, model)`:
- se `BudgetTokens { min, max }` existir, mapear a posição de `effort` dentro de
  `Effort.values` para um valor dentro de `[min,max]` (min → min, max → max, intermediários por
  interpolação); arredondar para múltiplo de 256 e limitar;
- manter a tabela atual apenas como fallback quando o modelo não declara faixa;
- atualizar assinatura e testes em `providers/reasoning.rs`.

### D5 — Apresentação (renderer)

- `thinkingOptions` continua como é a fonte única de opções; `effortLabel` já faz fallback para o
  valor cru quando não há tradução (`catalog.ts:194-214`) — preservar.
- `budgetPresets` passa a derivar presets da faixa declarada (`min`, ponto médio, `max`) e mantém
  os quatro presets curados quando caibam na faixa; evita lista vazia em modelos fora dos presets.
- Opcional (fase 2, mediante disponibilidade de dados): estender `ReasoningOption::Effort` com
  `labels: Option<BTreeMap<String,String>>` (`#[serde(default)]`), gerado por `build-catalog.mjs`,
  para nomes amigáveis por valor. Sem isso, o fallback i18n/raw já é funcional.

### D6 — Ferramenta de subagente

Tornar `reasoning` uma string livre no schema (`tools/agents.rs:154`) e validar em tempo de execução
contra `model.reasoningOptions` do modelo do worker; valores inválidos são recusados com erro
explicativo. Isso evita regenerar o schema estático por modelo.

## 5. Limites e riscos

- **Protocolos têm vocabulário próprio**: a UI pode oferecer apenas o que o modelo declara; o
  adaptador continua omitindo parâmetros não declarados (`providers/reasoning.rs`). Isso não é
  uma limitação do plano — é a proteção que impede erros 400.
- **ACP é diferente**: o agente dono da sessão decide o config; Zylara não deve enviar
  `session/set_config_option` com valor que o agente não anunciou. O resolvedor D1 vale para a
  seleção local, e `session::apply_thinking` (`acp/session.rs`) continua validando contra os
  valores descobertos.
- **Migração de settings**: valor legado inválido deve cair para o padrão, nunca quebrar o boot.
- **Catálogo gerado**: `pnpm catalog:sync` pode sobrescrever alterações manuais em
  `data/catalog.json`; qualquer extensão de schema passa por `scripts/build-catalog.mjs` e
  `scripts/__tests__/provider-seeds.test.mjs`.
- **Modelos duplicados entre provedores**: resolver sempre por `(providerId, modelId)`.

## 6. Ordem de implementação (quando autorizado)

1. D2 + D1 (settings e resolvedor) — base; testes Vitest e teste de normalização Rust.
2. D3 (modelos da conta) — teste em `commands/models.rs`.
3. D4 (budget) — teste em `providers/reasoning.rs`.
4. D5 (presets de budget e, se houver dados, labels) — testes em `modelMenu.test.ts`.
5. D6 (schema de subagente) — teste em `tools/agents.rs`.

Fora de escopo: mudar o mapeamento wire dos quatro adaptadores HTTP, reescrever o catálogo a partir
da rede, alterar a semântica de config ownership do ACP.

## 7. Verificação planejada

- `pnpm typecheck`, `pnpm test` (foco: `catalog.test.ts`, `modelMenu.test.ts`,
  `appStore.test.ts`, `ModelTab.test.tsx`),
- `cd src-tauri && cargo check`, `cargo test --lib commands::models`,
  `cargo test --lib providers::reasoning`, `cargo test --lib config::`,
  `cargo test --lib tools::agents`,
- `pnpm test:scripts` e `pnpm i18n:check` se D5/D2 adicionarem chaves.

## 8. Critérios de aceitação

- Trocar para um modelo com `effort: ["minimal","xhigh"]` oferece exatamente esses valores;
  nada é convertido para `low`/`max` na UI ou no payload.
- Um modelo descoberto da conta com `capabilities.effort.nonesuch.supported=true` mantém
  `nonesuch` em `reasoningOptions`, desde que o adaptador possa enviá-lo.
- Preferência `effort:xhigh` sobrevive a restart e é ignorada com segurança ao trocar para um
  modelo que não a oferece.
- Modelo com `budget_tokens {min:2048,max:65536}` oferece opções dentro da faixa, sem
  depender dos quatro presets fixos.
- Nenhum valor novo é enviado a provedor que não o declara.

## 9. Implementação entregue

- **D1**: `resolveReasoningDefault` em `src/lib/catalog.ts` aplica a preferência contra
  `reasoningUi(model)`; `defaultSelectionFrom` usa o resolvedor. Valores não declarados,
  `off` sem toggle e budget fora da faixa caem para `defaultReasoningFor(model)`.
- **D2**: `Settings.reasoningDefault` passou a `string` no renderer; `ModelTab` persiste
  `effort:<valor>` / `budget:<n>` / `off` / `auto`; `config::is_valid_reasoning_default`
  aceita valores arbitrários seguros com prefixo e mantém a família legada sem prefixo.
- **D3**: `discover_reasoning_efforts` em `commands/models.rs` lê todas as chaves de
  `capabilities.effort` marcadas como suportadas, preserva nomes específicos do modelo e
  descarta apenas a chave booleana `supported`.
- **D4**: `budget_for_effort(effort, model)` interpola a posição do esforço dentro de
  `Effort.values` entre `BudgetTokens.min/max`, arredonda para 256 e mantém a tabela antiga
  apenas como fallback.
- **D5**: `budgetPresets` mantém os quatro presets curados quando cabem na faixa e, quando
  nenhum cabe, deriva min/médio/max do modelo; rótulos via `models:budget.custom.*` nos 3 idiomas.
- **D6**: schema do `create_agent` aceita qualquer effort `[a-z0-9_-]{1,32}`; o validador usa
  `CatalogFile::model(provider_id, model_id)` quando disponível e valida formato/budget quando
  o modelo não está no catálogo embutido.

Testes novos: `catalog.test.ts` (resolver), `modelMenu.test.ts` (presets dinâmicos),
`config.rs` (normalização), `commands/models.rs` (efforts arbitrários),
`providers/reasoning.rs` (budget derivado) e `tools/agents.rs` (effort livre seguro).

Fora desta entrega: rótulos por valor de esforço vindos do upstream (Fase 2 opcional do D5) —
o fallback i18n/valor cru já cobre nomes não catalogados.

## 10. Verificação final

| Comando | Resultado |
| --- | --- |
| `pnpm typecheck` | sem erros |
| `pnpm test` | 3327 passaram; 8 falhas pré-existentes (preços em `CodeAgentWidgets`/`modelMenu`/`sessionCost`, largura do `ModelPill` e expectativa antiga de `off` em `modelMenu`) |
| `pnpm test:scripts` | 20/20 |
| `pnpm i18n:check` | catálogos em paridade; mesmas 7 literais Rust pré-existentes fora deste escopo |
| `cd src-tauri && cargo check` | sem erros |
| `cd src-tauri && cargo test --lib` | 1735 passaram; mesmas 7 falhas pré-existentes (`plugins`, `genui`, `pipeline`) |

 Os testes novos passaram: `resolveReasoningDefault`, presets derivados, normalização de settings,
 efforts arbitrários da conta, budget derivado do modelo e effort livre no `create_agent`.
