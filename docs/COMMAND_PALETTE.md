# Paleta de comandos (⌘K) — auditoria e contrato de comportamento

> Documento de referência da paleta de comandos do Zylara (DESIGN §10). Registra
> a auditoria da implementação v1, os problemas encontrados, o contrato de
> comportamento alvo e a arquitetura que o implementa. Plano de execução e
> evidências ficam em `docs/goals/command-palette-v1/`.

## 1. Resumo executivo

A paleta v1 (`src/components/palette/CommandPalette.tsx`, 402 linhas) é um
overlay Radix funcional com 10 ações fixas, busca por substring e navegação
↑/↓/Enter. **Nove das dez ações executam de ponta a ponta**; a décima
(“Buscar conversas”) é código morto — liga `uiStore.searchOpen`, uma flag que
nenhum componente consome. O backend já expõe `search_conversations` (título +
conteúdo das mensagens) e o renderer já tem `api.searchConversations`, mas
**nenhuma superfície usa essa busca**.

Principais lacunas além da ação quebrada: busca sem normalização de acentos
(“configuracoes” não acha “Configurações”), sem fuzzy, sem comandos recentes,
sem busca de conversas, sem salto para abas de Configurações, comandos que não
conhecem contexto (ex.: “Limpar anexos” comemora sucesso sem anexos), teclado
incompleto (sem Home/End/PageUp/PageDown, sem wrap, sem guarda de IME, Esc não
limpa a busca antes de fechar) e acessibilidade parcial (grupos/listbox sem
associação, contagem não anunciada, sem estado de carregamento).

A v2 (este ciclo) transforma a paleta em central de comando e busca: comandos
locais capability-aware + busca de conversas assíncrona com merge local +
recentes persistidos + teclado completo + IA de resultados (grupos, contagem,
destaque de match) + estados de carregamento/vazio/erro, sem novas dependências
e sem mudanças no backend.

## 2. Escopo e método

- Auditoria de código estática (renderer) + leitura do contrato IPC
  (`src-tauri/src/commands/conversations.rs`, `src-tauri/src/db.rs`).
- Baseline verificado antes de qualquer mudança: `pnpm typecheck` OK,
  `pnpm test` **53 arquivos / 1176 testes** verdes.
- Fora do escopo: comandos customizáveis pelo usuário, backend novo,
  automação de UI/navegador (proibida pelo AGENTS.md).

## 3. Auditoria da implementação anterior

### 3.1 Shell e interações

| Item | Status | Evidência / observação |
| --- | --- | --- |
| Abrir/fechar com ⌘K/Ctrl+K | ✅ | `App.tsx` (listener global alterna `commandPaletteOpen`) |
| Abrir pelos botões da Sidebar | ✅ | `Sidebar.tsx` chama `setCommandPaletteOpen(true)` |
| Fechar com Esc | ✅ | `CommandPalette.tsx` (`preventDefault` + `setOpen(false)`) — mas sempre fecha |
| Focus trap / aria-modal | ✅ | Radix `Dialog` |
| Navegação ↑/↓/Enter | ✅ | `handleKeyDown`; seleção limitada ao tamanho da lista |
| Hover/click do mouse | ✅ | `onMouseEnter` seleciona, `onClick` executa |
| Scroll da linha ativa | ✅ | `scrollIntoView({ block: 'nearest' })` |
| Reset ao abrir | ✅ | efeito zera query/índice ao abrir |
| Grupos com ordem fixa | ⚠️ | `GROUP_ORDER` filtra por lista fixa: ação com grupo novo **desaparece silenciosamente** |
| Busca por substring | ⚠️ | `.includes` em label/description/keywords/group com caixa dobrada, **sem normalizar acentos** |
| Contagem no rodapé | ✅ | “N comandos” |
| Estado vazio | ✅ | ícone + “Nenhum comando encontrado” |
| Match destacado | ❌ | nenhum destaque de trecho |
| Estatísticas / abas de configurações | ❌ | “Abrir configurações” reabre na última aba usada; não há como mirar uma aba |
| Estado de carregamento/erro | ❌ | não existe busca assíncrona na v1 |

### 3.2 Ações

| Ação | Status | Efeito real | Problemas |
| --- | --- | --- | --- |
| Novo chat | ✅ | `chatStore.startNewConversation` (⌘N global também existe) | — |
| Buscar conversas | ❌ **quebrada** | `uiStore.setSearchOpen(true)` | flag `searchOpen` não é lida por nenhum componente; a paleta fecha e nada acontece |
| Exportar conversa | ✅ | `api.exportConversation(id, 'markdown')` + toast | só Markdown; cancelamento silencioso; sem JSON |
| Copiar última resposta | ✅ | `copyText` + toasts | — |
| Limpar anexos | ⚠️ | `clearAttachments()` + toast “Anexos removidos” | mostra sucesso mesmo com 0 anexos pendentes |
| Abrir configurações | ⚠️ | `setSettingsOpen(true)` | abre na última aba usada; impossível mirar uma aba |
| Trocar modelo | ✅ | `setModelPickerOpen`; bloqueio com cadeado + explicação | — |
| Alternar barra lateral | ✅ | `toggleSidebar` | — |
| Abrir painel de artefatos | ✅ | `openArtifactList`; toast quando vazio | — |
| Alternar tema | ⚠️ | light ↔ dark + `saveSettings` | perde a opção “Sistema”; sem indicação do tema atual |

### 3.3 Lacunas priorizadas (base da v2)

| # | Lacuna | Severidade |
| --- | --- | --- |
| A1 | “Buscar conversas” morta e `uiStore.searchOpen` sem consumidor | **Alta** |
| A2 | Busca de conversas por título/conteúdo não exposta em lugar nenhum | **Alta** |
| A3 | Busca não normaliza acentos nem tolera typo (“configuracoes”); caixa já é dobrada | **Alta** |
| A4 | Esc fecha a paleta em vez de limpar a busca (divergente do ModelPicker §8) | Média |
| A5 | Sem comandos recentes/frequência | Média |
| A6 | Sem salto direto para abas de Configurações | Média |
| A7 | Ações ignoram contexto (anexos vazios, sem conversa, sem streaming) | Média |
| A8 | Ações úteis não expostas: fontes, skills, toggles de ferramentas, focar composer, parar/regenerar, pasta de dados, catálogo | Média |
| A9 | Teclado incompleto: sem Home/End/PageUp/PageDown/wrap, sem Ctrl+N/P, sem guarda de composição IME | Média |
| A10 | Atalhos globais (⌘B/⌘N/⌘,) continuam agindo no fundo com a paleta aberta | Média |
| A11 | Grupos fixos escondem ações de grupos não listados | Média |
| A12 | Sem destaque de match, sem carga/erro de busca, sem contagem por seção | Baixa/Média |
| A13 | Acessibilidade parcial: grupos sem `role="group"`/`aria-labelledby`, contagem sem `aria-live`, `aria-expanded` estático, listbox rotulado “Comandos” mesmo com conversas | Média |
| A14 | Código morto: `searchOpen`, `attachmentsOpen`, `types.CommandItem`/`AttachmentDraft`, `uiStore.fontScale`/`reduceMotion` sem uso | Baixa |
| A15 | 640 px de largura e lista `max-h-[360px]` fixos, sem adaptação para janelas baixas | Baixa |
| A16 | Sem indicação de estado (checked) para tema/ferramentas | Baixa |

## 4. Contrato de comportamento alvo (v2)

### 4.1 Fontes de dados

1. **Comandos** — catálogo local tipado, montado a cada render a partir dos
   stores (`chatStore`, `uiStore`, `appStore`) + `api`; a disponibilidade é
   calculada por contexto.
2. **Conversas** — `api.searchConversations(query)` (backend busca título +
   conteúdo; devolve ordenado por fixadas/atualização). Debounce de 160 ms e
   mínimo de 2 caracteres (query vazia nunca chama o backend). Token monotônico
   descarta respostas fora de ordem. Resultados locais normalizados
   (título + `preview`) são sempre mesclados aos do backend por id, o que
   corrige os acentos que o `LIKE` do SQLite não dobra. Erro/ambiente sem
   Tauri ⇒ fallback local com `requireMatch`, sem quebrar a paleta.
3. **Recentes** — ids de comandos executados, `localStorage`
   (`zylara.palette.recents`, máx. 6, dedupe na frente), usados em “Sugestões” e
   como desempate de ranking.

### 4.2 Arquitetura de informação

- **Query vazia, escopo todos:** `Conversas recentes` (≤5, fixadas/atualizadas
  primeiro) → `Sugestões` (≤5 comandos: recentes; completados por
  Novo chat, Trocar modelo, Abrir configurações, Alternar tema, Focar campo de
  mensagem) → grupos de comandos na ordem canônica (Conversas, Navegação,
  Ferramentas, Aparência, Configurações, Sistema), excluindo os já exibidos em
  Sugestões. Primeiro item recebe a seleção.
- **Query preenchida, escopo todos:** `Conversas encontradas` (≤5) →
  comandos agrupados por categoria, ordenados por score.
- **Escopo `>`** na query: só comandos (vazio ⇒ todos os grupos).
- **Escopo `#`** na query: só conversas (vazio ⇒ recentes).
- Conversas mostram trecho destacado quando o match é em título/`preview`; um
  resultado que casou apenas no conteúdo (backend) mostra o selo “Conteúdo” —
  o IPC não devolve o trecho da mensagem, e isso não é prometido.
- Toda linha é navegável por teclado; conversas abrem com Enter e fixam/
  desafixam com ⌘/Ctrl+Enter (ação secundária, anunciada no rodapé).
- Rodapé: dicas contextuais (↑↓, ↵, ⌘↵ quando conversa ativa, Esc) e contagem
  total (“N comandos · M conversas”).

### 4.3 Busca e ranking de comandos

- Normalização: `NFD` + remoção de diacríticos + minúsculas; o match sempre
  reporta ranges no texto **original** para destaque.
- Query multi-token: todos os tokens precisam casar (AND) em algum campo.
- Campos e pesos: `label` (3) > `keywords` (2) > `description` (1) >
  `group` (0,5). Tipos de match por token: igual (1000) > prefixo (800) >
  prefixo de palavra (700) > substring (600 − penalidades) > subsequência
  (300 − gaps/penalidades).
- Desempate: score desc → recente → ordem do grupo → `localeCompare('pt-BR')`.
- Destaque: `<mark>` com `bg-accent-soft text-accent`, ranges mesclados.
- APIs reais em `src/lib/palette/search.ts`: `normalizeText`,
  `normalizeWithMap`, `tokenize`, `parsePaletteQuery`, `matchText`,
  `matchCommand`, `rankCommands`, `matchConversation`, `rankConversations`,
  `mergeConversationResults`, `mergeRanges`, `splitHighlight`.

### 4.4 Modelo de teclado

| Tecla | Comportamento |
| --- | --- |
| ↑ / ↓ | move (com wrap-around) |
| Ctrl+P / Ctrl+N | equivalentes a ↑/↓ |
| Home / End | primeiro / último resultado |
| PageUp / PageDown | ±10 posições |
| Enter | executa item ativo (ignorado durante composição IME) |
| ⌘/Ctrl+Enter | ação secundária: fixar/desafixar conversa ativa (mantém aberta); em um comando é no-op |
| Esc | passo 1: limpa toda a query/escopo e mantém aberta; passo 2 (query vazia): fecha |
| ⌘K | fecha (listener global) |
| Tab | não interceptado (focus trap do Radix) |

**Esc tem um único dono:** `DialogContent.onEscapeKeyDown` chama sempre
`preventDefault()` e então limpa a query ou fecha; o handler global do `App`
nunca reage a Esc com a paleta aberta. Sem cascata para `stop()`/painéis.

Atalhos globais que não sejam ⌘K são resolvidos por um módulo puro
(`src/lib/hotkeys.ts`) que recebe um snapshot da UI; com a paleta aberta o
resultado é `null` (exceto ⌘K). Isso torna o bloqueio testável sem montar o app.

### 4.5 Execução, foco e estados

- **Foco:** executar um comando fecha a paleta e agenda o efeito para o próximo
  tick (`setTimeout 0`), depois do restore de foco do Radix e antes do dialog
  destino montar; ações que abrem Settings/Model Picker deixam o dialog
  destino assumir o foco. Sem corrida entre FocusScopes.
- Ações que mudam apenas estado (tema, sidebar, copiar) usam o mesmo caminho
  para uniformidade.
- **Carregando conversas:** spinner discreto no input + esqueleto `aria-hidden`
  na seção; com a lista vazia o rodapé anuncia “Buscando conversas…”.
- **Fallback:** resultado local + aviso discreto “Busca no histórico
  indisponível; mostrando título e prévia.”
- **Vazio:** “Nenhum resultado para ‘termo’” + dica de escopos.
- **Indisponível:** comandos que não podem rodar no contexto **não entram na
  lista**; a exceção é o modelo travado (Chat com conversa iniciada ou turno em
  streaming), que continua visível com cadeado e explicação ao executar. No
  layout Code, sessões do Code permitem trocar modelo/provedor entre turnos, e o
  comando abre o dialog normalmente. Ao reabrir, a primeira linha volta a ficar
  ativa.
- **Checked:** tema vigente e toggles de ferramentas mostram ícone de check.

### 4.6 Acessibilidade

- Input `role="combobox"` com `aria-expanded`, `aria-controls`,
  `aria-autocomplete="list"` e `aria-activedescendant` somente quando há item
  ativo.
- Lista `role="listbox"` rotulada “Comandos e conversas”; seções
  `role="group"` + `aria-labelledby`; linhas `role="option"` com
  `aria-selected` e `aria-label` explícito (o destaque em spans quebraria o
  nome acessível). Lista vazia fica fora do listbox (estado vazio/loading como
  irmãos) e o `aria-controls` continua apontando para o listbox montado.
- Região `aria-live="polite"` anuncia a contagem de resultados e o estado
  “buscando”.
- Foco inicial no input; close restore do Radix (comandos que abrem outra
  superfície agendam o efeito, §4.5); alvos ≥32 px; foco visível
  `ring-accent`; motion respeita `prefers-reduced-motion`.

### 4.7 Visual e microcopy

- Overlay 640 px, topo ~9 vh, lista `max-h-[min(420px,calc(100vh-220px))]`;
  mesmos tokens do design system (`bg-surface-raised`, `border-border`,
  `text-foreground`, `bg-surface-hover`, `accent`, `accent-soft`); sem cores
  soltas.
- Linhas 36–52 px, ícone 16 px stroke 1,9, título 13 px, descrição 11 px,
  atalhos em `Kbd` à direita; foco visível com anel `accent`.
- Microcopy pt-BR: “Buscar conversas ou comandos…”, “Conversas recentes”,
  “Sugestões”, “Conversas encontradas”, “Buscando conversas…”, “Nenhum
  resultado para ‘…’”, “↑↓ navegar”, “↵ executar”, “⌘↵ fixar/desafixar”,
  “esc limpar busca”/“esc fechar”.

## 5. Catálogo de comandos da v2 (31 comandos)

| id | Grupo | Rótulo | Disponibilidade | Efeito |
| --- | --- | --- | --- | --- |
| `nova-conversa` | Conversas | Novo chat | sempre | `chatStore.startNewConversation` |
| `fixar-conversa` | Conversas | Fixar/Desafixar conversa | conversa ativa | `chatStore.togglePinned` |
| `exportar-markdown` | Conversas | Exportar conversa (Markdown) | conversa ativa | `api.exportConversation(id,'markdown')` |
| `exportar-json` | Conversas | Exportar conversa (JSON) | conversa ativa | `api.exportConversation(id,'json')` |
| `copiar-ultima-resposta` | Conversas | Copiar última resposta | última resposta com texto | clipboard + toast |
| `limpar-anexos` | Conversas | Limpar anexos | anexos pendentes | `chatStore.clearAttachments` |
| `parar-resposta` | Conversas | Parar resposta | streaming | `chatStore.stop` |
| `regenerar-resposta` | Conversas | Regenerar resposta | sem streaming e com resposta | `chatStore.regenerate` |
| `focar-composer` | Navegação | Focar campo de mensagem | sempre (volta ao chat se preciso) | evento `zylara:focus-composer` |
| `alternar-sidebar` | Navegação | Alternar barra lateral | sempre | `uiStore.toggleSidebar` |
| `abrir-artefatos` | Navegação | Abrir painel de artefatos | sempre (toast se vazio) | `uiStore.openArtifactList` |
| `abrir-fontes` | Navegação | Abrir painel de fontes | sempre (toast se vazio) | `uiStore.openSourcesPanel` |
| `gerenciar-skills` | Navegação | Gerenciar skills | `skillsPanelEnabled` | `uiStore.setActiveView('skills')` |
| `abrir-pasta-skills` | Navegação | Abrir pasta de skills | `skillsPanelEnabled` | `api.openSkillsDir` |
| `voltar-ao-chat` | Navegação | Voltar ao chat | view skills ativa | `uiStore.setActiveView('chat')` |
| `trocar-modelo` | Navegação | Trocar modelo | sempre (bloqueio explicado) | `uiStore.setModelPickerOpen` |
| `busca-web` | Ferramentas | Ativar/Desativar busca web | sempre | `saveSettings({webSearchEnabled})` |
| `criar-arquivos` | Ferramentas | Ativar/Desativar criação de arquivos | sempre | `saveSettings({fileCreationEnabled})` |
| `executar-codigo` | Ferramentas | Ativar/Desativar execução de código | sempre | `saveSettings({codeExecutionEnabled})` |
| `alternar-tema` | Aparência | Alternar tema | sempre | `setTheme` + `saveSettings` |
| `tema-sistema` | Aparência | Seguir tema do sistema | tema ≠ system | idem |
| `abrir-configuracoes` | Configurações | Abrir configurações | sempre | `uiStore.openSettings()` |
| `config-geral` … `config-sobre` | Configurações | Configurações › {aba} | sempre (inclui Experimental) | `uiStore.openSettings(tab)` |
| `abrir-pasta-dados` | Sistema | Abrir pasta de dados | sempre | `api.openDataDir` |
| `recarregar-catalogo` | Sistema | Recarregar catálogo de modelos | sempre | `appStore.refreshCatalog` |

> A fonte única do catálogo é `src/components/palette/usePaletteActions.ts`;
> grupos/ordem vivem em `src/lib/palette/types.ts`; abas em
> `src/lib/settingsTabs.ts`. Não duplicar essas listas em outros arquivos.
> Os switches da aba Experimental vêm do registro em `src/lib/experiments.ts`;
> a paleta apenas navega até a aba, sem duplicar a lista de recursos.

## 6. Arquitetura de implementação

```
src/lib/palette/
  types.ts        contratos (PaletteAction, grupos, itens, seções)
  search.ts       normalização, escopo, score/rank, destaque, ranking de conversas
  recents.ts      persistência localStorage dos comandos recentes
src/lib/settingsTabs.ts        ids + rótulos das abas de Configurações
src/lib/hotkeys.ts             resolução pura dos atalhos globais (snapshot → ação)
src/components/palette/
  CommandPalette.tsx           shell: dialog, input, teclado, listas, rodapé
  usePaletteActions.ts         catálogo capability-aware (fonte única de comandos)
  useConversationSearch.ts     busca assíncrona debounced/race-safe + merge local
  PaletteRow.tsx               linha de comando (ícone, label, shortcut, estado)
  ConversationRow.tsx          linha de conversa (título, prévia, selo de conteúdo)
  HighlightedText.tsx          destaque dos matches
  index.ts
src/components/settings/
  tabIcons.ts                  ícone por aba (compartilhado com a paleta)
```

Fluxo: `CommandPalette` lê query/escopo → `usePaletteActions` (comandos do
contexto) + `useConversationSearch` (conversas) → `search.ts` filtra/ordena e
devolve ranges → lista plana de itens alimenta teclado,
`aria-activedescendant` e renderização. Execução: fecha → registra recência →
agenda efeito no próximo tick. Conversa → `chatStore.openConversation`.

Mudanças de contrato (Lead):
- `uiStore`: **novos** `settingsTab`, `setSettingsTab`, `openSettings(tab?)`;
  **removidos** `searchOpen`, `attachmentsOpen`, `fontScale`, `reduceMotion`
  (todos sem consumidores comprovados por grep).
- `uiStore.setSettingsOpen` continua existindo (abre/fecha preservando a aba);
  `openSettings(tab?)` é o caminho preferido para deep-link. `ModelPickerDialog`
  “Configurar” passa a abrir `providers`.
- `types.ts`: remove `CommandItem` e `AttachmentDraft` (sem uso).
- `SettingsDialog` lê/grava a aba no `uiStore`.
- `App.tsx`: usa `src/lib/hotkeys.ts`; com a paleta aberta só ⌘K age.

**Ownership desta execução:** não há writers concorrentes. O Lead (único
escritor do ciclo) executa primeiro os arquivos de contrato que lhe pertencem
(`uiStore`, `types`, `App`, `settingsTabs`, `hotkeys`, docs) e, na sequência, os
arquivos da área ui-systems (`components/palette/**`, `components/settings/**`,
`lib/palette/**`), sem edição paralela de outra área. Um revisor independente
confere o diff final contra este contrato. Se houver futura paralelização, a
área ui-systems assume T3–T7 e o Lead mantém apenas T2/T9/T10.

## 7. Riscos e mitigações

| Risco | Mitigação |
| --- | --- |
| Busca de conversas lenta/instável | debounce 160 ms, mínimo 2 chars, token de corrida, merge local, cap de 5 |
| Acentos não dobrados pelo backend (`LIKE` ASCII) | merge sempre com matches locais normalizados; conteúdo puro continua limitação documentada (sem mudança de backend) |
| Paleta abrindo sobre outro dialog (Settings/ModelPicker) | fecha antes + efeito agendado no próximo tick; sem nova flag de overlay |
| Foco caindo no `<body>` depois de ações | restore do Radix + agendamento pós-close; teste de ações que abrem Settings e foco do composer |
| Mudança de Esc (limpar antes de fechar) surpreender | consistente com o dialog de modelos (§8) e com o rodapé contextual |
| Remoção de campos do store quebrar algo | grep confirma zero consumidores; testes do uiStore cobrem o contrato |
| Regressão de acessibilidade | testes de componente verificam roles/`aria-activedescendant` |
| Lista longa (31 comandos + conversas) | seções, contagem, busca fuzzy e scroll com linha ativa visível |

## 8. Critérios de aceite (evidências em EVIDENCE.md)

1. Nenhuma ação morta: “Buscar conversas” deixa de existir como flag órfã e a
   busca real de conversas aparece inline.
2. Busca ignora acentos/caixa, suporta multi-token e fuzzy com destaque;
   resultado só em conteúdo mostra o selo “Conteúdo” (sem prometer trecho).
3. Conversas: resultados do backend (mockado em teste) + merge local; Enter
   abre, ⌘↵ fixa/desafixa; carregamento, fallback e vazio visíveis.
4. Recentes persistidos e seção “Sugestões” ordenada.
5. Teclado completo e Esc limpa antes de fechar; IME não executa com Enter;
   `src/lib/hotkeys.ts` garante que atalhos globais não agem no fundo.
6. Ações contextuais corretas; configurações abrem na aba pedida; toggles
   mostram estado; ações que abrem dialogs não perdem foco (teste de efeito
   agendado).
7. Acessibilidade: combobox/listbox/grupos/aria-live/activedescendant.
8. `pnpm typecheck` e `pnpm test` verdes (novos testes de lib, hotkeys e
   componente); `pnpm build` OK.
9. Docs atualizados: DESIGN §10, FILES.md e este contrato.

## 9. Não-objetivos

- Backend novo ou mudança no contrato IPC (`search_conversations` já atende).
- Snippets de mensagem no resultado (exigiria novo campo no IPC).
- Paleta customizável pelo usuário (aliases, keybindings, plugins).
- Submenus/aninhamento de comandos, escopo `@` de modelos (o Model Picker
  cobre), comandos de tamanho de fonte (o slider de Configurações já cobre).
- Virtualização de lista (volume atual não exige).
- Automação de UI/navegador como critério de verificação.

## 10. Referências

- W3C APG Combobox; Radix Dialog; cmdk; GitHub Command Palette; Raycast Search
  Bar/Action Panel; Linear Search; VS Code #173767; MDN `isComposing` /
  `normalize` / `AbortController` — URLs na pesquisa do ciclo em
  `docs/goals/command-palette-v1/EVIDENCE.md`.
- `docs/DESIGN.md` §8 (Model Picker: Esc limpa a busca antes de fechar) e §10.
- `docs/FILES.md` (áreas, testes e evidências por versão).
