# AGENTS.md — como trabalhar neste repositório

> Leia `docs/ARCHITECTURE.md` (visão técnica), `docs/AGENTS.md` (layout Agentes: memória, workspace, fila, rotinas e canais), `docs/FILES.md` (arquivos, execução de código e skills), `docs/DESIGN.md` (UI/UX), `docs/GENUI.md` (UI generativa/interativa do agente), `docs/MODELS.md` (provedores/raciocínio) e `docs/PLUGINS.md` (plataforma de plugins, permissões, SDK, loja e lanes trusted/sandboxed) antes de implementar.

# COMENTARIOS E ANOTAÇÕES DEVEM SER SEMPRE EM INGLES, O CÓDIGO TAMBEM DEVE SER SEMPRE EM INGLES PARA CONSISTENCIA COM O PADRÃO DA INDUSTRIA

## Comandos

```bash
pnpm install                 # dependências do renderer
pnpm typecheck               # TypeScript (tsc --noEmit)
pnpm test                    # Vitest (TDD do renderer)
pnpm build                   # build do renderer (Vite)
pnpm app:dev                 # Tauri dev (janela + HMR)
pnpm app:build               # binário + instalador
.\scripts\bump-version.ps1    # bump interativo local de versão (sem build)
.\scripts\build-windows.ps1   # release só para Windows + instalador (local)
cd src-tauri && cargo check  # backend
cd src-tauri && cargo test --lib   # testes Rust (TDD)
cd src-tauri && cargo build  # binário de debug
node scripts/build-catalog.mjs
pnpm catalog:sync            # baixa docs Go/Zen + models.dev e regenera todos os provedores
```

Observação: `cargo` usa um target dir compartilhado. Se aparecer `Blocking waiting for file lock`, aguarde a outra compilação terminar — **não** delete `src-tauri/target`.

## Estrutura & propriedade

| Área | Arquivos | Dono |
| --- | --- | --- |
| Contratos compartilhados | `src/lib/types.ts`, `src/lib/api.ts`, `src/lib/catalog.ts`, `src/lib/modelMenu.ts`, `src/lib/utils.ts`, `src/lib/store/**`, `src/lib/genui/**`, `data/catalog.json`, **`data/genui-contract.json`**, **`data/genui-fixtures.json`**, `scripts/**`, `src-tauri/src/{domain,catalog,events,state,http}.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/commands/{mod,turn,models}.rs`, **`src-tauri/src/oauth/**`**, **`src-tauri/src/commands/oauth.rs`**, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src/App.tsx` | Lead |
| Provedores | `src-tauri/src/providers/**` | provider-dev |
| Harness/tools/docs | `src-tauri/src/harness/**`, `src-tauri/src/tools/**`, `src-tauri/src/policy/**`, `src-tauri/src/documents/**`, `src-tauri/src/jobs/**` | harness-dev |
| Runtime do workspace (código) | `src-tauri/src/workspace/**`, `src-tauri/src/terminal/**`, `src-tauri/src/commands/{workspace,code,git,terminal}.rs` | code-runtime-dev |
| Skills embutidas | `src-tauri/skills/**` | formats-dev |
| Plataforma de plugins | `src-tauri/src/plugins/**`, `src-tauri/src/commands/plugins.rs`, `src/lib/plugins/**`, `src/components/plugins/**`, `packages/plugin-sdk/**`, `packages/create-zylara-plugin/**`, `plugins/fixtures/**`, `data/plugin-contract.json`, `data/plugin-manifest.schema.json`, `scripts/plugin/**` | Lead |
| Persistência/config/commands | `src-tauri/src/db.rs`, `src-tauri/src/config.rs`, `src-tauri/src/commands/{conversations,settings,attachments,artifacts}.rs` | storage-dev |
| UI núcleo | `src/components/layout/**`, `src/components/chat/**`, `src/components/composer/**` | ui-core |
| Code workbench | `src/components/code/**` | ui-code |
| Cards do agente (harness) | `src/components/agent/**` | ui-agent |
| Layout Agentes | `src/components/agents/**`, `src/lib/store/agentStore.ts`, `src/lib/store/agentQueueStore.ts`, `src-tauri/src/agents/**`, `src-tauri/src/commands/{agents,routines,channels}.rs`, `docs/AGENTS.md` | ui-agent + Lead |
| UI sistemas | `src/components/ui/**`, `src/components/models/**`, `src/components/settings/**`, `src/components/artifacts/**`, `src/components/skills/**`, `src/components/genui/**`, `src/components/palette/**` | ui-systems |
| Atualizações | `src-tauri/src/update/**`, `src-tauri/src/commands/update.rs`, `src/lib/store/updateStore.ts` | Lead |

**Never edite arquivos de outra área.** Se precisar de uma mudança de contrato, envie uma mensagem ao Lead com a assinatura exata desejada.

> **UI generativa**: `data/genui-contract.json` é a fonte única (componentes, props, limites, regras de design, ações). Mudou o contrato? Atualize `data/genui-fixtures.json` e **as duas implementações** (`src/lib/genui` e `src-tauri/src/tools/genui`), depois rode `pnpm test` e `cargo test --lib` — o teste de paridade falha de propósito se divergirem. Não duplique listas de componentes/limites/regras em outros arquivos.

## Skills Krypton — somente quando pedido

As skills de fluxo **Krypton** (`krypton-planning`, `krypton-execution`, `krypton-vps-codex-app`) são **opt-in explícito**:

- Use-as **apenas** quando o usuário pedir de forma explícita, por exemplo: "use a skill krypton-planning", "planeje no fluxo Krypton", "execute este plano com krypton-execution".
- **Não** carregue/execute uma skill Krypton por iniciativa própria, por inferência ("a tarefa parece grande") ou porque a tarefa envolve planejamento/execução em várias etapas.
- Em caso de dúvida sobre a intenção, **pergunte ao usuário** antes de carregar a skill; não presuma.
- Sem pedido explícito, siga o fluxo normal deste `AGENTS.md` (leitura dos docs, TDD, verificação e entrega descritos abaixo).
- Quando autorizado, carregue a skill com a ferramenta de skills e siga as instruções dela na íntegra, sem substituí-las por aproximações.

> Não confundir com as **skills embutidas do produto** em `src-tauri/skills/**` (as skills que o próprio app carrega e executa em tempo de execução): aquelas são funcionalidade do app e não são afetadas por esta regra.

## Testes (TDD)

- Toda funcionalidade nova entra com teste automatizado **antes/durante** a implementação.
- Renderer: Vitest (`src/**/*.test.ts`, jsdom quando precisar de DOM); mock de `@/lib/api` para stores.
- Backend: `#[cfg(test)]` nos módulos; fixtures reais em `src-tauri/src/documents/testdata/`.
- Testes que dependem de Python/Node no PATH (execução de código e scripts das skills) devem **pular condicionalmente** quando o interpretador não existir, sem quebrar a suíte; helpers das skills usam somente a stdlib (sem pip).
- Integrações com o gateway usam `#[ignore]` + `deepseek-v4.1-flash` (Go) com esforço máximo.
- **Não** use automação de UI/navegador (screenshots, SendKeys, CDP) como critério de verificação.

## Convenções

### TypeScript/React
- `strict` ligado; sem `any` implícito, sem `@ts-ignore`.
- Import alias: `@/` → `src/`, `@data/` → `data/`.
- Estilo: componentes funcionais, hooks no topo, sem classes; `cn()` para classes condicionais.
- Cores/espaçamentos **somente** via tokens do Tailwind definidos em `src/styles/globals.css` (`bg-background`, `text-foreground-muted`, `border-border`, `bg-accent-soft`, …). Nada de hex solto.
- Ícones: `lucide-react` (stroke 1.75–2), tamanho 16/18/20. Exceção: glifos **coloridos** de tipo de arquivo do workbench de Code (`src/lib/fileIconAssets.ts`, Material Icon Theme MIT, sem tint/`text-*`, renderizados por `FileIcon`) — mapa em `docs/FILE_ICONS.md`.
- Texto da interface sempre via i18n (`src/locales/{en,pt-BR,es}`), nunca hardcoded; **inglês é o padrão** (procedimento em `docs/I18N.md`).
- Acessibilidade obrigatória: `aria-label` em ícones-botão, foco visível, roles corretas.

### Rust
- Erros de módulo: `anyhow::Result`; comandos Tauri retornam `Result<T, String>`.
- Nada de `unwrap()`/`expect()` em caminho de dados do usuário (use `?` + contexto).
- Async: tokio; HTTP: `reqwest` com o client compartilhado (`AppState::http`).
- Serialização IPC sempre `#[serde(rename_all = "camelCase")]`.
- Streaming: emita `ProviderEvent`/`TurnEvent` incrementalmente; nunca acumule tudo para emitir no fim.
- Preserve as assinaturas públicas definidas nos arquivos de contrato; substitua apenas os `todo!()` e corpos internos.

## Fluxo de trabalho

1. Leia os arquivos de contrato da sua área + `docs/`.
2. Implemente em incrementos compiláveis; rode `cargo check` / `pnpm typecheck` com frequência.
3. Ao terminar: rode a verificação da sua área, atualize a task compartilhada (`complete`) e envie ao Lead um resumo com: o que implementou, comandos rodados, riscos/pendências.
4. Se bloquear por contrato/ambiguidade, mande mensagem ao Lead em vez de mudar arquivos de outros.

## Critérios de pronto

- `cargo check` sem erros (warnings são aceitáveis).
- `pnpm typecheck` sem erros nos arquivos da sua área.
- Sem `todo!()`/`unimplemented!()` restantes na sua área.
- Funcionalidade real (sem mocks/fakes) usando as APIs descritas em `docs/`.
