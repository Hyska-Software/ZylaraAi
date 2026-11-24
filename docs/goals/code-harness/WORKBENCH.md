# WORKBENCH — UI/UX do modo Code com harness real

> Parte do plano `docs/goals/code-harness/`. Define a experiência do layout Code quando o harness
> existe de verdade: anatomia, componentes, estados, fluxos, acessibilidade e microcopy.
> Base: layout da fase 1 (`docs/goals/chat-code-layout/PLAN.md`, `src/components/code/**`),
> referência Paseo (`docs/research/paseo-workbench.md`) e o design system atual
> (`docs/DESIGN.md`, `src/styles/globals.css`).
>
> Regra de ouro herdada da fase 1: **estado honesto > tela cheia**. Nada de dado falso; se o dado
> ainda não existe, o estado vazio diz o que falta e como resolver.

## 1. Princípios

1. **Workspace é o eixo.** A sidebar agrupa por pasta/repositório; a sessão pertence a um workspace.
   Sem workspace, o Code é uma tela de abertura de pasta — não um chat solto.
2. **O trabalho termina em revisão.** Toda tarefa desemboca em Alterações → diff → commit. O painel
   direito é o "produto" da sessão.
3. **Densidade sem ruído.** Chrome mais baixo que a fase 1 (~36 px no lugar de 56+44+40), tipografia
   12–13 px no chrome e 15 px no transcript, hierarquia por contraste/espaço, bordas de 1 px.
4. **Estado explícito.** Sessão tem status (`Trabalhando`, `Pronta para revisar`, `Concluída`,
   `Erro`); turno tem fecho ("Trabalhou por 4m 29s · 12.4k tokens"); alterações têm origem
   (agente × git).
5. **Aprovação é conversa, não modal.** Pedidos de permissão aparecem no fluxo da conversa, com o
   contexto necessário para decidir; negar não cancela o turno.
6. **Tudo reversível.** "Reverter turno" e "Reverter arquivo" estão a um clique; rewind de
   conversa reusa o truncate existente.
7. **pt-BR fixo**, com glossário (§13). Termos técnicos consagrados (workspace, commit, branch, diff,
   PR, terminal) ficam em inglês; o resto traduz.

## 2. Anatomia

```
┌───────────────────────── TitleBar 48px (inalterada, pílula Chat | Code) ─────────────────────────┐
├ CodeSidebar 272px ─┬────────────── centro ─────────────────────────────┬ CodePanel 480px ────────┤
│ + Novo agente      │ ▣ Sessão: “Corrigir cálculo de juros”   ● Editando│ [Arquivos][Alterações][Terminal]│
│ Buscar (⌘K)        │ ⊞ workspace: lumina-core  ⎇ main*  ▤ 2  ▣ painel │ ⎇ main ▾     +42 −7   ⟳  ⋯   │
│ Skills             │ ┌ abas ────────────────────────────────────────┐ │ ▾ src/                      │
│                    │ │ ● Correção de juros × │ ● Revisão do diff × │ │   M app.ts        +12 −3    │
│ WORKSPACES    [+]  │ └──────────────────────────────────────────────┘ │   A novo.ts       +30 −0    │
│ ▾ ▣ lumina-core  ● │ transcript (ChatView)                            │ ▸ tests/                    │
│    • Correção…   ◐ │  …                                               │                             │
│    • Revisão…    ✓ │  ┌ card de turno ─────────────────────────────┐  │ ┌ barra de commit ─────────┐ │
│ ▸ ▣ site-instit   │  │ Trabalhou por 4m 29s · 38.2k tok · 2 jobs   │  │ │ mensagem…      Commit ▸ │ │
│ ▸ Sem workspace   │  └────────────────────────────────────────────┘  │ └──────────────────────────┘ │
│                   │ ┌ composer ───────────────────────────────────┐  │ ▸ Commits recentes (3)       │
│ ───────────────   │ │ [@ src/app.ts ×] Descreva… @ /             │  │                              │
│ Configurações  ?  │ │ + model ▾  🛡 Editar ▾  □ Plano   ◼ ～ 🎤  │  │                              │
│ v0.1.0            │ └─────────────────────────────────────────────┘  │                              │
└───────────────────┴─────────────────────────────────────────────────┴──────────────────────────────┘
```

- Larguras: sidebar 272 (220–480, existente), painel 360–900 (default 480, existente), conversa
  ≥ 480. Painel aberto por padrão em janelas ≥ 1120 px (regra existente).
- Em < 1024 px: sidebar vira drawer; painel vira overlay (padrão do `AppShell`/`lib/sidePanel.ts`).
- Altura do chrome do centro: header 44 px + abas 36 px (reduzir 40 px vs. fase 1, seguindo a
  lição do Paseo de fundir header+abas em ~40–72 px). Header e abas podem colapsar em uma faixa
  quando a janela é estreita (abas viram seletor).

## 3. CodeSidebar

Estrutura (de cima para baixo):

1. **Ações**: `+ Novo agente` (cria sessão no workspace ativo ou pede workspace), `Buscar` (⌘K) e
   `Skills` (página existente, com "Voltar à sessão").
2. **Workspaces** (seção com `+` para abrir pasta):
   - cada workspace: ícone (pasta ou repo), nome, indicador `⎇ branch` + `●` sujo, contador de
     sessões ativas; expande para listar sessões (agrupadas por status, não por data).
   - ações (menu de contexto, `⋯` ou clique direito): **Nova sessão**, **Abrir terminal** (shell no
     caminho do projeto, sem criar sessão), Renomear, **Abrir no Explorer**, Copiar caminho, Remover do
     Lumina (não apaga a pasta), Atualizar.
   - estado vazio: "Nenhum workspace aberto" + "Abrir pasta…" + explicação de uma linha.
3. **Sessões sem workspace** (se existirem, herdadas da fase 1): grupo "Sem workspace" com CTA
   "Vincular a um workspace".
4. **Rodapé**: Configurações, ajuda (`?`), versão — inalterado.

Persistência: workspaces abertos vêm do banco; workspace ativo e ordem → `uiStore` persistido.
O sidebar nunca lista sessões de outro workspace fora do grupo dele.

## 4. Cabeçalho da sessão (+ abas)

- **Linha 1 (44 px)**: título da sessão (truncado), chip do workspace
  (`📁 lumina-core · ⎇ main* · ▤ 2 alterações`; clique abre menu: trocar workspace, abrir pasta,
  copiar caminho, atualizar git), **medidor de contexto** atualizado em tempo real: chip com anel de
  progresso + percentual; o clique abre um popover com `X% do contexto usado` e `~usado / janela`
  no topo, barra segmentada e legenda com os valores de **Prompt de sistema**, **Definições de
  ferramentas** e **Mensagens** (cores `context-system`/`context-tools`/`context-messages`), além do
  limite de saída e da nota de compactação; botão ligar/desligar painel
  (`aria-pressed`). Os controles de **modo de permissão** e **Plano** não ficam mais no cabeçalho:
  vivem no composer (§6).
- **Linha 2 (36 px)**: abas das sessões abertas no Code (`role="tablist"`), `+` nova sessão, `X`
  fechar (mínimo: fecha aba, não apaga sessão). O `+` cria a sessão **no mesmo workspace da sessão
  ativa** (sem sessão ativa, no workspace selecionado na sidebar; sem nenhum, sem workspace). Estado
  persistido por workspace (localStorage via `uiStore`) — resolve a limitação conhecida da fase 1.
- **Status da sessão** (ponto colorido na aba): `Trabalhando` (pulsante), `Aguardando aprovação`
  (âmbar), `Pronta para revisar` (verde), `Erro` (vermelho), `Concluída`.
- Se a sessão não tem workspace: chip "Sem workspace" com CTA "Abrir pasta" (não é beco sem saída).

## 5. Transcript (ChatView + cards novos)

O `ChatView` existente continua sendo a única instância (preserva draft/scroll). Novos blocos:

### 5.1 Fecho de turno

Ao fim de cada turno do layout Code, o transcript termina com um **card de resumo** do que
foi feito — o "Edited N files" dos agentes de código, adaptado ao design system:

```
┌ ▣ 2 arquivos alterados ─────────────────────────────┐
│   +42  −7                                           │
├─────────────────────────────────────────────────────┤
│  ▤ src/app.ts                               +12 −3  │
│  ▤ docs/DESIGN.md                           +30 −4  │
│  ▤ src/lib/utils.ts                          +0 −0  │
│                               Todos os 3 arquivos ⌄ │
└─────────────────────────────────────────────────────┘
```

- **Fonte**: `ChatMessage.toolCalls[].presentation` com `kind: "file_change"`
  (`write_file`/`edit_file`, persistido junto da mensagem). Uma linha por path — edições
  repetidas no turno somam `added`/`removed` e o último `kind` vence —, ordenada por path;
  chamadas que falharam ficam de fora. Como o dado já é persistido, o card reaparece ao
  reabrir a sessão e nenhum IPC/payload novo é necessário. Arquivos alterados por processos
  externos (`run_command`, ex.: formatador/gerador) não passam pelo journal e por isso não
  entram no card: eles aparecem no painel Alterações com origem git (limitação conhecida).
- **Colapso**: 4 linhas por padrão; acima disso, botão full-width **Todos os N arquivos** /
  **Mostrar menos** (`aria-expanded`/`aria-controls`, chevron 150ms). Título
  "N arquivos alterados" (singular "1 arquivo alterado"), totais `+N −M` com
  `tabular-nums` e os tokens `success`/`danger` (nada de hex solto).
- **Abrir diff**: cada linha é um botão (só quando a sessão tem workspace) que abre o diff
  daquele arquivo como **aba central**, exatamente como o painel Alterações faz
  (`uiStore.openCodeDiff` → `CodeDiffView`, fechável no tab strip). O alvo leva o patch
  persistido da última edição do turno como `knownDiff` (sem IPC); quando o payload não tem o
  patch, a aba busca `get_file_diff`. Sessão sem workspace mantém as linhas informativas.
  Acessibilidade: `aria-label="Abrir diff de <path>"`, hover/foco visíveis.
- **Só no Code e só no fim**: a montagem (`src/components/chat/MessageItem.tsx`) checa
  `layoutMode === "code"` e o fim do streaming; turnos cancelados/erro mostram as edições
  parciais porque elas são reais. O card não existe no layout Chat.
- **Sem duplicar o fecho do "Thinking"**: tempo/tokens continuam no header do bloco
  ("Trabalhou por Xs" no Code, §5.2.1); o card resume **arquivos**.
- **Acessibilidade**: grupo `aria-label="Resumo do turno"`, lista semântica, ícones
  decorativos `aria-hidden`, foco visível e paths truncados com `title` completo.
- **Implementação**: `src/lib/codeTurnSummary.ts` (view model puro) +
  `src/components/code/CodeTurnSummary.tsx` (card) + montagem em
  `src/components/chat/MessageItem.tsx`. Testes: `codeTurnSummary.test.ts` (agregação),
  `CodeTurnSummary.test.tsx` (card/colapso) e `MessageList.test.tsx` (só Code/não streaming).

### 5.2 Cards de tool (removidos do transcript)

Decisão de UX (2026-10): o transcript **não renderiza mais** os cards de apresentação de tool
(`file_change`/diff, `todos`, `plan`, `job`, `answers`). O bloco recolhível "Thinking"
(`AgentSteps`) já mostra o que o agente está fazendo (rótulos/ícones/erros) e os estados
operacionais ficam concentrados no popover do composer (`CodeSessionControls`):

| Informação | Onde vive agora |
| --- | --- |
| Plano (estado/markdown/feedback) e tarefas (progresso + itens) | popover "Plano e tarefas" no composer (§6) |
| Jobs em segundo plano (status/comando/tempo/parar) | mesma popover, seção "Trabalhos em segundo plano", com contador de jobs no pill (§7.4) |
| Alterações de arquivos (diff, `+N −M`, reverter) | painel Alterações + fecho do turno (§5.1, §7.2) |
| Aprovação e pergunta ao usuário | cards inline (§5.3/§5.5), pois bloqueiam o turno |
| `ask_user` respondido, subagente e saídas longas | apenas no resumo do "Thinking"/resultados, sem card extra. Subagente tem linha ao vivo (`status`, passos, modelo/effort, texto recente) e botão “Abrir chat”, que abre uma aba de transcript sem composer (uma por subagente; abrir a mesma conversa duas vezes só ativa a aba existente e mostra um aviso). O badge é “Read-only” para scouts e “Autonomous” para `worker`. O popover do composer lista os transcripts retidos (inclusive erro/cancelamento). A `presentation` guarda `conversationId`/`steps`/`durationMs`/`usage` |

O popover "Plano e tarefas" tem **um único contêiner de rolagem**: `PlanCard` e `TodoCard`
entram com `scrollable={false}` ali, para que o wheel sobre o plano ou sobre a lista de tarefas
continue rolando o painel inteiro (sem áreas internas com `overscroll-contain` prendendo o scroll).

`ToolCallRecord.presentation` continua sendo persistido (auditoria/replay e consumidores futuros),
mas não é mais montado no chat. `ToolPresentationCard` permanece como biblioteca disponível, sem uso
no transcript. Ícones/labels do "Thinking" no mapa de `src/lib/agentTrace.ts` (tools novas +
fallback genérico).

#### 5.2.1 Timeline de execução (dentro do "Thinking")

O bloco recolhível mostra uma **linha por chamada de tool do harness** (não o card agregado), no
estilo `Think/Edit/Pwsh`:

- Raciocínio: linha recolhível `Pensou` (ícone `Brain`), **fechada por padrão como as linhas de
  tool**; expandir revela o **Markdown completo** do passo do modelo (mesmo contrato de
  `docs/MARKDOWN.md` §4/§10, na variante compacta `variant="thinking"`: 13px, `foreground-muted`;
  títulos, listas, tabelas, código com copiar, math e links funcionam). O texto do passo é
  preservado **bruto** (`agentTrace.buildAgentTrace` não divide por linha em branco nem remove
  marcadores de lista); durante o streaming a linha mostra spinner e o caret aparece no último
  bloco expandido na fase de raciocínio.
- Tool: ícone + **verbo** (`Leu`, `Buscou`, `Alterou`/`Criou`, `Executou`, `Atualizou as tarefas`,
  `Plano proposto`…) + **alvo** em mono (path/comando/busca) + status + metadados:
  - escrita/edição: `+N −M` e, ao expandir, **diff com syntax highlight** (`DiffView`);
  - shell/verificações: badge `exit N` (verde=0, vermelho≠0), duração e, ao expandir, a **saída**
    (mono, scroll, copiar); falhas abrem a saída automaticamente;
  - validação de UI (`validate_ui`): linha `Validou a interface` (ícone `ShieldCheck`), resultado
    JSON sob demanda; é uma linha do Code, não o grupo agregado do Chat;
  - demais tools: saída/resultado sob demanda (região rolável, `tabindex=0`).
- Toda linha de tool expansível usa `aria-expanded`/`aria-controls`; a linha tem nome acessível
  (`aria-label`) com o texto completo ("Leu src/app.ts"). A linha de raciocínio também usa
  `aria-expanded`/`aria-controls` (nome acessível "Pensou").
- Header do bloco ao concluir: **"Trabalhou por Xs"** no layout Code (o tempo do turno inclui as
  ferramentas, não só o raciocínio); **"Pensou por Xs"** fica no layout Chat. Ao vivo os títulos
  continuam por fase ("Pensando…", "Executando ferramentas…") e turnos sem raciocínio exposto
  mostram "N passos".
- Tools do Chat (web/skills/artefatos) mantêm os grupos/resumos existentes (páginas, domínios,
  chips) sem mudança — a diferença Chat × Code é intencional e preservada.
- **Separação por resposta**: quando o passo emite narração antes de pedir tools
  (`trace[].text`), o layout Code (e o Agentes) deixa de usar o bloco único: a narração vira
  Markdown no corpo e o trabalho seguinte é resumido em uma linha de atividade ao vivo —
  "Analisando a solicitação · <raciocínio>", "Executando comandos · <comando>", "Editando
  arquivos · <path>", etc. (`toolActivityLabel`/`describeTraceActivity` em
  `src/lib/agentTrace.ts`) — que passa a **"Trabalhou por X"** quando o trecho termina (o último
  usa o tempo total do turno), com as linhas de raciocínio `Raciocínio Ns` e as linhas de tool.
  A linha da execução corrente abre durante o streaming; turnos sem narração intermediária e
  mensagens antigas continuam no bloco único. O Chat nunca separa.

Implementação: `AgentSteps` + `ToolCallRow` (chat) + `describeCodeTool` (`src/lib/agentTrace.ts`).

### 5.3 Aprovação (card inline)

```
┌ ⚠ Executar comando? ──────────────────────────────────────────────┐
│ pwsh · cwd: lumina-core                                           │
│ ┌───────────────────────────────────────────────────────────────┐ │
│ │ npm test -- --run                                             │ │
│ └───────────────────────────────────────────────────────────────┘ │
│ Risco: comando no workspace · nenhuma regra salva                 │
│ [ Permitir]  [ Negar]  [ Sempre permitir ▾ ]        motivo: …     │
└───────────────────────────────────────────────────────────────────┘
```

- Foco automático no card (primeiro botão = Permitir; `Esc` = Negar); anúncio em `aria-live`.
- "Sempre permitir ▾" abre escopos: **esta sessão** / **este workspace** / **sempre** (regra com
  matcher exibido: `comando começa com "npm test"`).
- Negar abre campo de motivo (opcional) que volta ao modelo.
- Para escrita: mostra o diff resumido antes dos botões (ver o que será gravado).
- Enquanto pendente, o composer fica disponível apenas para "Parar" (sem enviar mensagem).
- Estado resolvido vira uma linha: `Permitido · sempre neste workspace` / `Negado: “use pnpm”`.

### 5.4 Plano (modo Plano)

- Card com Markdown renderizado do plano + metadados (arquivos que serão tocados, passos,
  verificação). O gate é acessível (`role="alertdialog"`, foco no botão primário, `Esc`, `aria-busy`
  enquanto envia) e possui quatro saídas:
  **Aprovar e executar** (sai do Plano preservando o modo de permissão atual; o turno segue
  **no mesmo turno**) /
  **Aprovar e revisar cada edição** (sai do Plano → **Revisar**: cada escrita pede aprovação) /
  **Continuar planejando** (feedback livre persistido; o agente revisa e reenvia) /
  **Executar como Objetivo** (`approve_goal`: aprova/persiste o plano, preserva o modo de permissão,
  cria um Goal com continuidade automática e deixa a primeira rodada começar no `done` do turno).
- O plano aprovado entra integralmente no contexto da rodada do Goal (até 20 000 caracteres). O
  CTA de objetivo fica desabilitado, com motivo visível, quando a sessão já tem objetivo
  ativo/pausado/bloqueado; sem workspace o backend recusa a criação.
- O draft é persistido na submissão (`plan/submitted`) e o feedback em `plan/feedback`, então
  reabrir a sessão mostra o estado correto (planejando/aguardando revisão/aprovado).
- Depois de aprovado, o plano permanece acessível no popover do chip "Plano" (estado, markdown e
  status por passo vindo dos todos). O botão **Ver plano** abre o Markdown em uma **aba central** na
  mesma faixa das abas de sessão/arquivo, usando a prévia de Markdown do `FilePreview`
  (Documento ⇄ Código, copiar, quebra de linha global) e fechável pelo X — o conteúdo é um snapshot
  do plano aprovado, sem passar pelo backend. O gate também rola para a viewport e o header mostra o
  badge "Aguardando aprovação".
- O timeout de revisão é o do broker (default 10 min), não o timeout curto da tool.
- **Qualidade do plano**: o agente investiga o repositório antes de planejar e o Markdown precisa
  ser implementável — contexto com arquivos/símbolos exatos, escopo, mudanças por arquivo, passos
  com critério de conclusão, testes/comandos, riscos/rollback e critérios de aceite. A profundidade
  acompanha o escopo (2–6 mil caracteres no típico, máx. 20 mil; sem código completo ou repetição).
  Planos com menos de 300 caracteres são recusados com `PLAN_TOO_BRIEF`.

### 5.5 Pergunta ao usuário

Card com opções (rádio/checkbox), recomendada marcada, texto livre opcional, botão "Ignorar e
continuar" (o modelo recebe `{ skipped: true }`). Nunca bloqueia a UI — o turno fica aguardando.

## 6. Composer

Reaproveita o `Composer` atual (draft, anexos, model picker, envio/parada) com:

1. **`@` arquivos/pastas**: digitar `@` abre popover com busca fuzzy (`search_workspace_files`,
   debounce 120 ms), navegação ↑/↓, `Tab`/`Enter` inserem chip; suporta faixa `@src/app.ts#L10-40`;
   chips removíveis (`Backspace`). O backend resolve os arquivos em "contexto anexado" com limite
   (cap por arquivo, total, sempre truncado com aviso).
2. **`/` comandos**: popover com comandos do harness (catálogo §12), agrupados em
   *Sessão* / *Plano* / *Git* / *Contexto*. Começam como atalho de intenção (preenchem o composer)
   ou ação direta (`/compact`, `/commit`, `/review`, `/test`, `/init`, `/plan`, `/permissoes`).
3. **Controles**: modelo (existente), anexos (existente), enviar/parar e, no lugar dos pills globais
   de ferramentas do Chat (`Busca web`/`Criar arquivos`), os **controles da sessão**: **modo de
   permissão** (chip/escudo: Leitura/Editar/Revisar/Autônomo, menu com a descrição de cada modo e
   atualização otimista com rollback; abaixo de 42rem de largura do composer o chip fica **somente
   ícone**, com o rótulo no `aria-label`/`title`), **Plano** (toggle somente ícone com `aria-pressed`; quando
   ativo o campo mostra um badge accent com o ícone e o rótulo “Plano” — `aria-label="Desativar
   modo Plano"` — na área de chips, ao lado do `/goal`, que desativa o modo ao clique) e o **popover de
   plano/tarefas** (trigger somente ícone + indicadores: progresso `N/M` das tarefas e contador de
   jobs quando existirem; estado do plano, markdown e status dos itens no popover). Tudo com
   `aria-label`/tooltip e navegável.
4. **Placeholder por estado**: com workspace → "Descreva a tarefa… @ para arquivos, / para comandos";
   sem workspace → "Abra uma pasta para trabalhar com código".
5. **Atalhos**: `Ctrl/Cmd+L` foca o composer (como o Paseo), `Ctrl+Enter` envia,
   `Ctrl+.` abre o seletor de modo, `Shift+Tab` alterna Plano quando o foco está no composer.
6. **Fila/steering (v1.2)**: enviar durante streaming enfileira; a mensagem entra no próximo passo
   (steer) ou após o turno (followup), conforme escolha no próprio envio.

## 7. CodePanel (direito)

Abas: **Arquivos** · **Alterações** · **Terminal** (v1.1) · (opcional) **Plano**. Barra de contexto
acima das abas: `⎇ main ▾` (lista de branches, criar/trocar), `+N −M`, botão atualizar (`⟳`),
`⋯` (ações: abrir no Explorer, copiar caminho, configurações do painel).

### 7.1 Arquivos

- Árvore do workspace (`role="tree"`, virtualizada): pastas expandíveis, ícones por tipo, filtro
  incremental no topo, **badges de estado git** (`M`, `A`, `D`, `U`, `!`), arquivos ignorados
  ocultos por padrão (toggle "mostrar ignorados").
- Clique curto → abre o arquivo em uma **aba central** (a mesma faixa de abas das sessões, como o
  diff de Alterações): **cada arquivo aberto tem a sua própria aba** (ícone do tipo + nome truncado
  + X para fechar), na ordem de abertura; clicar num arquivo já aberto apenas ativa a aba dele
  (sem duplicar). O conteúdo da aba ativa ocupa o centro, read-only, com **syntax highlight e
  números de linha** (Prism), **imagem** com zoom/ajuste à janela, **PDF via pdf.js** (páginas +
  zoom) e estados honestos para binário, truncado e encoding; "Abrir no Explorer", "Recarregar" e
  o botão de **quebra de linha** vivem no header. A quebra de linha é **global e persistida**: vale
  para todos os arquivos (inclusive os que forem abertos depois) e sobrevive ao reinício do app;
  desligada, linhas longas rolam na horizontal. Arquivos **Markdown** (`.md`/`.markdown`/`.mdx`)
  abrem por padrão como **documento renderizado** (mesmo pipeline GFM/KaTeX + sanitização do chat,
  largura de leitura centrada) e o header oferece a alternância **Documento ⇄ Código** para ver o
  fonte com o mesmo highlight/linhas/wrap — a escolha é local da aba e volta ao documento ao trocar
  de arquivo. Acima do limite inline (24 MiB) imagem/PDF viram cartão com o tamanho e a orientação
  de abrir fora do app.
- A antiga prévia inline do painel foi removida: a árvore ocupa o painel inteiro e o arquivo ativo
  fica destacado nela. Fechar a aba ativa (X) ativa a vizinha (direita, depois esquerda); fechar a
  última volta para a conversa; fechar uma aba em segundo plano não muda o centro. O gutter dos
  números de linha usa a mesma cor de fundo do código (`--background`) nos dois temas.
- Duplo clique → abrir no editor externo (`opener`); menu: copiar caminho, revelar no Explorer,
  "adicionar ao contexto" (vira `@` no composer).
- Estados: carregando (skeleton), vazio, erro de leitura, workspace grande ("mostrando 5.000 de
  38.000 arquivos — refine a busca").

### 7.2 Alterações

Duas origens, com origem marcada por arquivo:

- **Sessão** (journal do agente): o que a sessão tocou desde o último commit.
- **Git** (working tree): status real do repositório.

Agrupamentos: `Staged` / `Não staged` / `Novos` (`Untracked`); modo de visualização "somente
sessão" × "todos" (default todos, com a origem como badge). Cada linha: ícone, caminho relativo,
`+N −M`, badge `agente` quando aplicável, ações no hover (reverter arquivo, stage/unstage).
Acima da lista, a barra de ações em lote (**Preparar tudo** / **Desmarcar tudo**) usa
`git_stage_all` (`git add -A`) e `git_unstage_all` (`git restore --staged -- :/`); com conflitos de
merge, "Preparar tudo" fica bloqueado para não marcar conflitos como resolvidos. Clique abre o
**diff**:

- unificado (default) com números de linha, contexto 3, cabeçalhos de hunk, cores de adição/remoção;
- toggle lado-a-lado; "abrir arquivo"; "copiar patch"; "reverter hunk"? (não na v1 — ver §16);
- binário/grande: cartão com tipo/tamanho + "abrir" (sem diff).

Rodapé: **barra de commit** — escopo efetivo (Preparados com fallback para Tudo quando o índice
está vazio), `+N −M`, campo de mensagem (com **sugestão de IA** via botão `✨` →
`suggest_commit_message`), botão **Commit** à direita com menu dividido (seta): **Commit** (usa o
escopo efetivo), **Commit Staged**, **Commit All**, **Commit Selection**, **Commit (Amend)**,
**Commit & Push** e **Commit & Sync**. O botão é desabilitado sem mensagem/alterações (tooltip
explica); o menu desabilita variantes sem alvo. Há ainda **Commits recentes** colapsável (hash curto,
mensagem, autor, tempo; clique mostra o commit no painel). **Tudo** roda `git add -A` antes do
commit, incluindo arquivos modificados, novos e deletados; **Preparados** usa o índice existente;
**Seleção** prepara apenas os caminhos marcados. **Amend** reescreve o HEAD atual e exige um commit
anterior; **Push** roda `git push` depois do commit e **Sync** roda `git pull --no-edit` seguido de
`git push`. Falha de rede depois do commit gera um aviso separado — o commit já foi criado.

A barra workspace · branch tem o menu **Git** com **fetch**, **pull** e **push** (ações explícitas
do usuário, nunca tools do modelo): fetch é `git fetch --all --prune`; pull é `git pull --no-edit`
(respeita a configuração do usuário e nunca abre editor); push publica a branch em `origin` com
`--set-upstream` quando ainda não existe upstream. Os contadores `↑N`/`↓N` aparecem no menu e o
status é recarregado após cada operação; falhas de autenticação orientam configurar credential
helper/SSH. PR continua fora do escopo desta fase.

### 7.3 Terminal (v1.1)

- Aba com abas de terminal (múltiplos), botão novo terminal (`+`), cwd = workspace, shell do usuário.
  As abas/processos sobrevivem a trocar entre Arquivos/Alterações, recolher o painel e redimensionar
  a janela; cada conversa tem o seu próprio conjunto de terminais.
- O terminal também abre pelo menu do workspace na sidebar (**Abrir terminal**): a shell roda no
  caminho do projeto e a aba entra na faixa de abas central **sem criar sessão** — o cwd vem do
  workspace, não da conversa.
- Renderização `@xterm/xterm` + fit; scrollback 5.000 linhas; tema pelos tokens do app (inclusive a
  paleta ANSI clara/escura).
- Ações: novo, fechar, limpar, matar processo; aviso de estado (Rodando/Encerrado) no rodapé. Ao encerrar, a aba mostra
  o exit code e oferece reiniciar; fechar a aba encerra a árvore de processos.
- Terminal é do **usuário**, não do agente (agente tem `run_command`/jobs) — quando o agente usa o
  mesmo processo, o card de job abre no painel.

### 7.4 Jobs (no composer)

Jobs pertencem à sessão e ficam no **popover "Plano e tarefas"** do composer, junto de plano/tarefas
(seção "Trabalhos em segundo plano": status, comando truncado, tempo e ações ver/parar). O pill é
**somente ícone + indicadores** (progresso `N/M` das tarefas e contador de jobs quando existem); não
há mais faixa acima do composer. Saída ao vivo continua acessível pelo job/terminal no painel.

## 8. Fluxos principais

### 8.1 Primeiro uso do modo Code

1. Tela de boas-vindas do Code: título "Comece com uma pasta", botão **Abrir pasta…** (dialog
   nativo), lista de **workspaces recentes**, e 3 sugestões de tarefa (só quando há workspace).
2. Abrir pasta → workspace criado → pergunta de confiança (§8.2) → sessão criada automaticamente com
   o workspace, header mostra branch/status.
3. Sem git → chip "sem git" discreto; painel Alterações funciona pelo journal; aba Commits mostra
   "Não é um repositório Git".

### 8.2 Confiança na pasta (workspace trust)

Primeira abertura de um workspace pergunta: **"Confiar nesta pasta?"** com explicação (o agente
pode ler, editar e executar comandos aqui; instruções do projeto `AGENTS.md` e skills locais serão
carregadas). Escolhas: **Confiar** (default Editar), **Abrir em Leitura** (só leitura), **Cancelar**.
Workspace não confiável: modo Leitura, sem `AGENTS.md`/skills do projeto no prompt, sem shell.
Medida de segurança contra repo clonado malicioso (padrão Claude Code/Cursor).

### 8.3 Tarefa com plano

`/plan Corrija o bug de arredondamento no cálculo de juros` → modo Plano ativa → agente explora
(leitura/busca) → gate de plano → **Aprovar e revisar cada edição** → agente edita (cada escrita
aparece no painel Alterações e no fecho do turno; sem card de diff no chat) → roda testes com
aprovação → fecho de turno com `+2 −1` → painel Alterações → commit.

### 8.4 Aprovação de comando

Agente chama `run_command` → card de aprovação → usuário "Sempre permitir" com escopo workspace →
regra salva → próximas execuções passam; auditoria registra a regra. Destrutivo continua pedindo.

### 8.5 Revisão e entrega

Fim do turno → `Ver alterações` → diff por arquivo → ajustes conversando com o agente →
`✨ Sugerir mensagem` → revisar → **Commit**. Fecho: toasts `Commit criado (a1b2c3)` e status da
sessão vira `Concluída`/`Pronta para revisar`.

### 8.6 Reverter

- **Reverter arquivo**: no diff ou na linha → confirma → restaura o estado anterior do turno (se o
  arquivo mudou por fora, aviso e opção "abrir diff atual").
- **Reverter turno**: no fecho do turno → confirma → restaura todos os arquivos do turno (ordem
  inversa) + registra evento; a conversa **não** é apagada.
- **Voltar a este ponto** (v1.1): reverter turno + truncar a conversa até aquela mensagem
  (reusa `truncate_conversation`).

### 8.7 Sessões em paralelo

Abrir outra sessão no mesmo workspace é permitido; badge `Trabalhando` por aba e notificação
(sonner + notificação do SO, opt-in) quando uma sessão em segundo plano termina/aguarda aprovação.
Conflito de arquivo: aviso "o arquivo foi alterado por outra sessão".

## 9. Estados (matriz)

| Situação | UI |
| --- | --- |
| Sem workspace | welcome "Abra uma pasta" + recentes; composer desabilitado com placeholder próprio |
| Workspace não confiável | banner "Modo leitura — confie na pasta para liberar edições" + botão |
| Sem git | chip "sem git"; commit desabilitado com tooltip; Alterações por sessão funcionam |
| Carregando sessão | skeleton do transcript + header; nunca spinner de página inteira |
| Turno rodando | aba com pulso; composer vira "Parar"; jobs no popover do composer; "Thinking" incremental |
| Aguardando aprovação | badge âmbar na aba/header + card inline; notificação se app em background |
| Erro de turno | card de erro com código + hint + "tentar de novo"; parcial preservado |
| Provider sem credencial | gate existente do Chat (reuso) |
| Arquivo binário/grande | cartão, sem diff |
| Alterações vazias | "Nenhuma alteração pendente" + dica |
| Jobs vazios | mensagem no popover do composer; pill sem contador |
| Contexto compactado | nota no popover do medidor de contexto "N mensagens resumidas" |
| Limite de passos | aviso "Limite de passos atingido — continuar?" com botão que abre novo turno |
| Workspace removido/renomeado no disco | banner "pasta não encontrada" + "localizar pasta" |
| Git com conflito | aviso no painel Alterações, commit bloqueado |

## 10. Acessibilidade

- Cabeçalho/abas: `role="tablist"`/`tab` com `aria-selected`, `aria-controls`, setas/Home/End;
  fechar aba com `aria-label="Fechar aba <título>"`.
- Árvore: `role="tree"`/`treeitem`, `aria-expanded`, `aria-selected`, teclado completo
  (↑/↓/←/→/Home/End/Enter).
- Aprovação: `role="alertdialog"` no card, foco no primeiro botão, `Esc` = negar, retorno de foco ao
  composer ao resolver; anúncio `aria-live="assertive"`.
- Cards inline restantes (aprovação/pergunta): foco, `aria-expanded` quando expandem; conteúdo longo
  em região com `tabindex=0`. A timeline do "Thinking" tem linhas por tool com `aria-label` completo,
  `aria-expanded`/`aria-controls` no detalhe (diff/saída) e falhas anunciadas por texto + cor.
- Diff: cada linha com `aria-label` ("linha 12, adicionada, ...") apenas no modo acessível; cabeçalhos
  de hunk focáveis.
- Contraste AA em todos os tokens; nenhuma informação só por cor (badges com letra/símbolo).
- `prefers-reduced-motion` respeitado (pulso de status desliga, transições encurtam).
- Atalhos documentados na paleta de comandos (`?` abre ajuda).

## 11. Motion e visual

- Transições 150–220 ms `ease-out-soft` (tokens existentes); sem animação em streaming de texto.
- Status pulsante apenas em "Trabalhando" (e desligado com reduced motion).
- Diff com fundos `bg-success-subtle`/`bg-danger-subtle` (tokens existentes; criar se faltar,
  sempre no `globals.css`), nunca hex.
- Cards com `border-border`, `bg-surface`, `rounded-lg`, sombra só no hover/seleção.
- Ícones lucide 16/18 px, stroke 1.75–2.

## 12. Comandos `/` (catálogo do composer)

| Comando | Ação | Fase |
| --- | --- | --- |
| `/plan [instrução]` | entra no modo Plano (com instrução opcional) | v1.0 |
| `/plan off` | sai do modo Plano | v1.0 |
| `/permissoes` | aponta o seletor de modo de permissão no composer | v1.0 |
| `/compact` | compacta o contexto agora | v1.0 |
| `/limpar` | limpa o composer | v1.0 |
| `/commit` | abre o commit do painel | v1.0 |
| `/test` | roda a verificação do projeto (comando detectado) com aprovação | v1.2 |
| `/review` | pede revisão do diff atual (agente revisor) | v1.2 |
| `/init` | gera `AGENTS.md` do projeto | v1.2 |
| `/fix` | pede correção dos testes/erros atuais | v1.2 |
| `/novo` | nova sessão no workspace ativo | v1.0 |

Comandos de projeto (`.lumina/commands/*.md`) entram na v1.3 (mesmo parser, precedência projeto >
usuário). A paleta ⌘K continua com os comandos globais.

## 13. Glossário (pt-BR) e microcopy

| Termo | Uso |
| --- | --- |
| workspace | manter "workspace" (já usado na fase 1) |
| sessão | uma conversa/agente no Code |
| agente | a instância que executa (modelo + tools) |
| turno | uma execução do agente a partir de uma mensagem |
| alterações | mudanças de arquivo pendentes (não "diff" no rótulo da aba; "diff" no conteúdo técnico) |
| commit / branch / merge / PR | manter (termos do git) |
| aprovar / negar / permitir | ações de permissão |
| confiar na pasta | trust do workspace |

Microcopy-chave:

- Vazio de workspace: "Nenhuma pasta aberta" / "Abra uma pasta para o agente ler, editar e rodar comandos aqui." / botão **Abrir pasta…**
- Vazio de alterações: "Nenhuma alteração pendente" / "As edições do agente e as mudanças do git aparecem aqui."
- Vazio de commits: "Sem commits ainda" (nunca "0 commits").
- Aprovação: "Executar comando?" / "Gravar alteração?" / "Ler arquivo fora do projeto?" com o
  caminho absoluto e o motivo.
- Bloqueio por modo: "O modo Leitura não permite editar arquivos. Mude para Editar para continuar."
- Erro de path: "O caminho fica fora do workspace. Permitir acesso?" (nunca "operação inválida").
- Contexto: "Contexto em 78% — o próximo passo deve compactar automaticamente."
- Fim de turno: "Trabalhou por 4m 29s" / "Pronta para revisar" / "2 arquivos alterados".
- Fecho do turno (card): "N arquivos alterados" / "1 arquivo alterado" / "Todos os N arquivos" /
  "Mostrar menos".

## 14. Responsivo

- ≥ 1440 px: 3 colunas folgadas, painel 480–560.
- 1120–1440: painel 420–480; abas de sessão com scroll horizontal.
- 900–1120: painel fechado por padrão (abre em overlay); header colapsa o chip de workspace em
  ícone com tooltip.
- < 900: sidebar drawer, painel overlay, abas viram select; composer ocupa largura total.
- Nunca: esconder o botão de parar, o modo de permissão ou o card de aprovação.

## 15. Matriz de testes (UI)

| Componente/serviço | Testes |
| --- | --- |
| `CodeSidebar` | workspaces (agrupamento, expansão, menu, remover sem apagar pasta), sessões por status, abrir pasta, empty state |
| `CodeSessionHeader` | título, chip workspace (branch/sujo/ahead), medidor, toggle painel, abas persistidas (os controles de permissão/Plano vivem no composer) |
| `FileTree` | expandir/colapsar, filtro, badges git, virtualização, seleção, teclado, estado grande/vazio |
| `ChangesPanel` | agrupamentos, origem, contadores, diff, reverter arquivo/turno (com confirmação), preparar/desmarcar tudo, conflitos bloqueiam o stage em lote, commit desabilitado/habilitado |
| `GitActionsMenu` | fetch/pull/push via api, estados de loading/erro, contadores ↑/↓, atualizar status, fora de repo desabilitado |
| `DiffView` | unificado, linhas, hunks, binário, grande, lado-a-lado, a11y |
| `CommitBar` | mensagem, sugestão IA, escopo staged→all, menu dividido (staged/all/selection/amend/push/sync), estados de erro |
| `ApprovalCard` | render por tipo (comando/path/segredo), aprovar/negar/motivo/escopo, teclado, aria-live, resolução |
| `PlanCard` | render markdown, aprovar/revisar cada edição/continuar, feedback, estado aprovado |
| `AskUserCard` | opções single/multi, texto livre, ignorar, teclado |
| `TodoCard` / `ContextMeter` / `JobsBar` | estados, contadores, ações (plano/tarefas/jobs no popover do composer) |
| `Composer` (novos) | `@` (busca, chips, faixa de linhas, backspace), `/` (filtro, teclado, execução), modo de permissão/Plano no Code, popover Plano/tarefas/jobs, placeholder por estado |
| `chatStore` | aplicação de eventos novos (aprov/plan/todo/changes/context/job), `presentation` persistida (não renderizada no transcript), tolerância a eventos desconhecidos |
| `CodeTurnSummary` | agregação das edições por path e totais, singular/plural, recolher/expandir (4 linhas), só no layout Code e com o turno encerrado, clique abre o diff na aba central (com `knownDiff` ou fallback `get_file_diff`) |
| `uiStore` | workspace ativo, abas por workspace, painel/aba, persistência e merge |

## 16. Não-objetivos desta fase (registrados)

- Editor de código completo dentro do app (a edição é do agente; o painel é prévia/diff). Abrir no
  editor externo é o caminho.
- Revisão por hunk com aceitar/rejeitar antes de aplicar (o modelo é "aplicar + reverter"; v2 pode
  introduzir staging de edições).
- Browser embutido, plugins, múltiplos clientes (daemon/mobile) e voz — escopo do Paseo, não do
  Lumina local-first.
- Tabs heterogêneas (terminal/browser/arquivo como abas de sessão) — o painel fixo cobre; reavaliar
  depois do terminal.
- i18n: pt-BR fixo (decisão do app).

## 17. Objetivo (Goal) — v1.11

Produto/contrato completo: `docs/goals/code-goals/PLAN.md` §10. Superfícies e regras de UI:

| Superfície | Componente | Comportamento |
| --- | --- | --- |
| Pill + popover no composer | `GoalControls` (entre **Plano** e **Plano e tarefas**) | botão **somente ícone** (sem texto/rounds), no mesmo padrão do toggle de Plano: sem objetivo alterna o chip `/goal` (`accent` + `aria-pressed` quando armado; clicar no chip remove a intenção); com objetivo abre popover com `GoalCard` completo (Pausar/Retomar/Armar/Nova rodada/Concluir com confirmação/Editar/Estender/Abrir). Durante streaming só "Pausar após esta rodada" + Abrir |
| Badge + aba no header | `CodeSessionHeader` | badge clicável → `openCodeGoal()` (accent+spinner na rodada, warning pausado, danger bloqueado, `N/M` ativo, oculto concluído); aba central "Objetivo" com teclado setas/Home/End/Delete e X |
| Painel central | `GoalPanel` (`codeView='goal'`, `id="code-goal-panel"`) | resumo (rodadas/tempo/tokens/custo/última atividade), objetivo em Markdown com scroll/copiar, timeline de rodadas (200 máx; Em andamento/Concluída/Cancelada/Erro/Interrompida), estados vazio/loading/erro+retry |
| Diálogo | `GoalDialog` (`uiStore.goalDialog`) | caminho de **edição** (título/objetivo/limite; Switch de continuidade só com objetivo ativo) + zona de perigo "Encerrar objetivo"; criação não é mais aberta pela UI (fluxo `/goal`); `Esc` fecha; `aria-invalid`/`aria-describedby`/`aria-busy` |
| Transcript | `GoalRoundDivider` + `ToolPresentationCard` | `origin='goal_round'` vira divisor (`role="separator"`, Target, relativeTime, spinner), sem bolha/editar/regenerar; card da tool `goal` compacto/readOnly; `AgentSteps` com ícone `Target` e labels pt-BR |
| Card de atenção | `GoalAttentionCard` em `CodeSessionCards` | pausado(error/stalled/max/interrupted)/bloqueado/concluído; motivo+detalhe, resumo, Retomar/Estender/Concluir/Abrir/Dispensar (X); dispensável por revisão (`dismissedGoalRevision`) |
| Comando `/goal` | `commands.ts` (grupo **Objetivo**) | comando de **intenção** (`action: 'intent'`): vira um chip `/goal` removível no composer **sem alterar a mensagem**; ao enviar, a mensagem segue intacta com `goalRequest=true` e o harness injeta a instrução de criação no runtime context — o agente cria o objetivo pela tool `goal` (action `create`) |
| Estado global | `codeStore` (`goal`, `goalRounds`, `goalStarting`, `dismissedGoalRevision`) + `uiStore` (`codeView='goal'`, `codeGoalOpen`, `goalDialog`) | snapshot autoritativo + reducer `goal_updated`; ações com otimista/rollback/CAS |

Regras: a interface **nunca** inicia rodada sozinha a partir de uma ação declarativa; a
autocontinuação é do driver após `done` (uma rodada por vez, sessão ativa no Code, objetivo armado,
sem plano/aprovação/pergunta). Parar uma rodada pausa a continuidade. Nenhuma ação de objetivo
substitui aprovação/permissão do harness.
