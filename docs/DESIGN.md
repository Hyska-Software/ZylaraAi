# Zylara — Design & UI/UX

## 1. Direção

Zylara é um chat de IA **calmo, preciso e premium**, inspirado na hierarquia do ChatGPT e na contenção visual do Claude, com identidade própria: a marca Zylara — mascote roedor violeta `#5E34FB` com focinho lilás `#EADFFC` — usada apenas em momentos de marca (logo, avatar do assistente, splash, Sobre). Nos ícones do Windows e Linux o símbolo aparece sobre fundo transparente; o tile grafite-claro `#EBEBEB` fica reservado ao favicon, à UI do instalador e ao ícone do macOS.

Princípios:
- **Conteúdo primeiro**: a conversa ocupa o centro, sem molduras pesadas. Superfícies neutras, **sem contornos fechados** (a separação vem do contraste de superfície), divisores de 1px apenas entre conteúdo e sombras suaves em camadas flutuantes.
- **Movimento discreto**: transições de 150–260ms, ease-out; nada de bounce exagerado. Respeitar `prefers-reduced-motion`.
- **Densidade confortável**: linha de texto 1.7, blocos de 12–20px de respiro; máximo de largura de leitura 768px.
- **Feedback imediato**: toda ação tem estado (hover, active, loading, streaming, erro).
- **Acessibilidade**: foco visível, navegação por teclado completa, ARIA em diálogos/menus, contraste AA.

## 2. Identidade

| Token | Valor |
| --- | --- |
| Nome | Zylara |
| Símbolo | mascote roedor estilizado em violeta `#5E34FB`, com orelhas arredondadas, olho escuro, focinho lilás `#EADFFC` com nariz em Y e pata lilás sobre a barriga |
| Ícone | Windows/Linux: o símbolo recortado sobre **fundo transparente**, com ~7% de respiro nas laterais; macOS, favicon e instalador: o mesmo símbolo sobre tile grafite-claro `#EBEBEB` (cantos arredondados, bordas transparentes) |
| Arquivos | `assets/Zylara_Logo.svg` (original); vetores usados pelo app em `public/brand/zylara-tile.svg` e `public/brand/zylara-mark.svg`; `assets/app-icon.svg` (master quadrado transparente) gera `app-icon.png` (1024×1024) e `src-tauri/icons` com `pnpm brand`, que também regenera as camadas tipadas do símbolo em `src/components/chat/brandMarkArt.ts` |
| Uso | tile → favicon, UI do instalador e ícone do macOS; marca sem fundo → titlebar, avatar do assistente, boas-vindas, splash, Sobre e ícones do Windows/Linux |
| Tema | no tema embutido **Zylara** (claro e escuro) o símbolo mantém as cores oficiais; em qualquer outro tema ele assume a cor principal (`accent` no corpo, `background` nos recortes do focinho/orelhas/pata e `foreground` no olho). O tile, o favicon e os ícones do SO nunca são recoloridos |
| Voz | português brasileiro, direta, sem excesso de exclamações; termos técnicos em inglês quando consagrados |

## 3. Paleta (tokens em `src/styles/globals.css`)

| Token | Light | Dark |
| --- | --- | --- |
| background | `#ffffff` | `#17171a` |
| surface (sidebar) | `#f7f7f8` | `#101012` |
| surface-raised | `#ffffff` | `#1e1e22` |
| surface-hover | `#f0f0f2` | `#242429` |
| foreground | `#0e0e11` | `#ececf1` |
| foreground-muted | `#5f6066` | `#a1a1ab` |
| foreground-subtle | `#8b8c93` | `#6f6f7a` |
| border | `#e8e8ec` | `#28282e` |
| border-strong | `#d9d9e0` | `#3a3a43` |
| accent | `#6b4eff` | `#8b7bff` |
| accent-soft | `#f1edff` | `#221d3a` |
| success | `#16a34a` | `#4ade80` |
| warning | `#b45309` | `#fbbf24` |
| danger | `#dc2626` | `#f87171` |
| user-bubble | `#f2f2f4` | `#242429` |

Regras: nunca usar hex solto em componentes — sempre `bg-background`, `text-foreground-muted`, `divide-border`, etc. **Nenhum elemento desenha contorno sólido** (`border` sem lado, `outline` estático ou anel usado como moldura): a contenção vem do contraste entre `background` → `surface` → `surface-hover`/`surface-raised`. `border`/`border-strong` existem apenas para divisores de 1px (`border-t|b|l|r|x|y`, `divide-*`, `hr`, `Separator`), barras de rolagem, trilho do slider e o grid do calendário. Exceções: anéis transitórios de `:focus-visible` e o trilho animado do composer. GenUI e Markdown mantêm as molduras que já tinham. A marca é servida como asset vetorial (`public/brand/`, ver §2): no tema embutido Zylara as cores oficiais são preservadas e, em qualquer outro tema, o símbolo é recolorizado pelos tokens (`BrandMark` com `tint="theme"` — corpo em `accent`, recortes em `background`, olho em `foreground`; `tint="brand"` força a arte oficial, como no card do tema padrão em Configurações › Temas). O botão de enviar ativo e o estado "pensando" usam apenas `accent`/`accent-soft`.

## 4. Tipografia

- Família: **Inter Variable** (`--font-sans`), fallback Segoe UI; monoespaçada **JetBrains Mono Variable**.
- Escala: 12 (meta) / 13 (labels) / 14.5 (UI) / 15 (corpo do chat) / 17 (título de diálogo) / 20–24 (títulos de tela) / 32 (hero).
- Títulos com `tracking-tight` (-0.011em); corpo 1.7; tabelas 13px.
- Números tabulares em métricas (`tabular-nums`).

## 5. Layout

```
┌──────────────────────────────── janela (1320×860) ────────────────────────────────┐
│ banda de chrome 40px — sidebar: [logo] [☰] · centro: sessão/abas · [update] [— □ ×] │
│               ╭──────────────────────── painel do chat ────────────────────────────│
│ Sidebar 272px │  Chat (max-w-3xl centrado)                    │ Artifact panel    │
│  novo chat    │  mensagens…                                   │ 360–900px, dock   │
│  busca        │                                               │                   │
│  grupos       │  ┌─ Composer (sticky, 2xl, sombra) ─────────┐ │                   │
│  config/perfil│  │ anexos · textarea · tools · modelo · send │ │                   │
└───────────────┴──┴──────────────────────────────────────────┴─┴───────────────────┘
```

- **Chrome contínuo**: as linhas de chrome de cada layout, a sidebar e o painel direito do Code formam uma única superfície (`bg-surface`), sem linhas divisórias entre si. O chat é um painel `bg-background` com **apenas os cantos superiores arredondados** (`rounded-tl-lg` sempre; `rounded-tr-lg` quando o painel direito do Code está aberto), encostado nas áreas — a divisão é feita só pelo contraste de superfície, sem `border` de 1px. O canto esquerdo acompanha a borda da sidebar ao abrir/fechar/redimensionar; os painéis de Artefatos/Fontes do Chat mantêm a moldura própria.
- **Chrome sem topbar (40px)**: `decorations: false` e nenhuma linha de título dedicada. Cada layout pinta **uma** linha de chrome de 40px no topo da coluna central (`LayoutTopRow`): no Chat ela mostra o título da conversa; no Code é a linha do cabeçalho da sessão (título, selos, chip do workspace, medidor de contexto, botão do painel); nos Agentes é o `AgentTopBar` (agente/visão atual) acima do header da thread. A sidebar começa com a mesma linha (`SidebarChromeRow`: **ícone do app sem o nome** + botão da sidebar; no drawer compacto, o ícone + fechar). Quando a sidebar está recolhida ou compacta, o ícone e o botão passam para a linha do centro — nunca somem nem duplicam. Todas as linhas são arrastáveis (`data-tauri-drag-region`; duplo clique maximiza, ignorando botões, abas e campos de texto). À direita de cada linha ficam as **ações globais** (slot `titlebar.actions` + `UpdateChip`) e, no canto superior direito da janela, o `ChromeCorner` com os controles nativos custom (minimizar/maximizar-restaurar/fechar; hover `surface-hover`, fechar em vermelho). O canto ocupa 128px fixos: as linhas de chrome e os headers dos painéis direitos reservam esse espaço (`useChromeCornerReserve`), então os controles nunca são cobertos — nem com o painel dockado, nem sobre um painel sobreposto, nem na largura mínima (900px). O indicador "Plano ChatGPT" foi removido da interface; o estado do plano continua em Configurações › Provedores, no seletor de modelos e no banner de limite de uso.
- **Atualização disponível**: quando há uma release estável mais nova, a linha de chrome mostra um **pill de 28px** (`UpdateChip`) antes dos controles de janela: ícone `ArrowUpCircle` + `v<versão> disponível` (accent-soft, texto accent; abaixo de 1024px só o ícone) + chevron. Ele é o aviso persistente e também o feedback: `Baixando 42%` com uma barra de 2px na base, `Verificando…`, `Instalar vX` (success-soft) e `Falha na atualização` (danger-soft). Clicar abre um popover de 360px com **Novidades** (texto puro, rolável, link para o GitHub), plataforma/tamanho/SHA-256, progresso em bytes/velocidade com Cancelar, “Download verificado”, **Instalar agora** / **Abrir pasta**, “Agora não” e “Ignorar esta versão”. O botão some quando não há atualização, quando a versão foi ignorada ou durante a checagem automática silenciosa; a checagem manual mostra `Verificando…`. A instalação nunca é silenciosa: no Windows abre o wizard do instalador existente, no macOS abre o DMG e no Linux abre o pacote/AppImage. O mesmo estado e as mesmas ações aparecem em **Configurações → Sobre → Atualizações**.
- **Sidebar**: 272px (padrão), `bg-surface` (sem borda divisória à direita), colapsável (⌘/Ctrl+B) e **redimensionável** arrastando a borda direita (220–480px, largura persistida; duplo clique restaura 272px; foco no divisor + ←/→ movem 16px, Home/End vão aos limites). Contém: botão "Novo chat" (pill com preenchimento `surface-raised`), item **"Biblioteca"** (abre a página de arquivos no lugar do chat; sempre visível), item **"Skills"** logo **abaixo** de Biblioteca (abre a view de gestão no lugar do chat; oculto quando o painel é desativado nas configurações), busca, lista agrupada (Fixadas, Hoje, Ontem, 7 dias, 30 dias, Mais antigas), rodapé com atalho de configurações e seletor de layout (botão apenas com o ícone do modo atual que abre uma lista simples com ícone e texto).
- **Chat**: painel `bg-background` (`rounded-tl-lg`) que recebe a coluna central `max-w-3xl` (768px), padding 24px, espaçamento entre mensagens 28px.
- **Composer**: sticky no rodapé com gradiente de fade; container `rounded-3xl`, fundo `surface-raised`, sombra sutil (sem contorno); cresce até 10 linhas.
- **Artifact panel**: side panel à direita, **redimensionável** arrastando a borda esquerda (360–900px, padrão 480px; largura persistida; duplo clique restaura 480px; divisor focável + ←/→/Home/End) e com **dois modos** alternáveis pelo botão do header (preferência persistida): **sobreposto** (padrão — flutua sobre o chat, slide-in 240ms, largura limitada a `92vw`) e **fixo/docked** (divide a linha com o chat, que reflui e mantém no mínimo 480px; disponível em janelas ≥1120px — abaixo disso cai automaticamente no sobreposto; sem sombra/slide). Em ambos os modos a largura é re-clampada ao espaço disponível quando a janela muda de tamanho. Com dois modos de conteúdo controlados pelo `uiStore`: **lista** — header "Artefatos" com contador, cards compactos por artefato (tipo, nome e tamanho) e estado vazio discreto — e **prévia** — header com nome, tipo, ações (Ver lista, anterior/próximo, Salvar como…, Abrir, Excluir, Fechar) e conteúdo scrollável. O botão "+" do chat abre o painel na lista; clicar em um card ("Abrir") abre a prévia; "Ver lista" volta para a lista. A prévia é específica por tipo (v1.5): **imagem/SVG** com barra de formato + dimensões, zoom (−/+, ajustar à janela, tamanho real), fundo xadrez para transparência e pan por arrasto; **PDF** com navegação de páginas e zoom; **áudio/vídeo** com player nativo e metadados discretos; **ZIP** com resumo e lista de entradas (ícone, nome, tamanho); **binário** com formato detectado e hexdump colapsável (offset + ASCII); **Markdown** com alternância Documento/Código; **JSON** com alternância Árvore/Código (árvore colapsável); **CSV/TSV** em grade com cabeçalho fixo; **código/texto** com syntax highlight, números de linha, contagem de linhas e alternância de quebra de linha. Header do painel mostra tipo (badge), tamanho e linguagem. Estados de carregamento/erro têm spinner e "Tentar novamente"; formatos não suportados caem no cartão com "Salvar como…"/"Abrir" e o motivo.
- **Sources panel**: mesmo painel lateral (mesma largura redimensionável e mesmos modos sobreposto/fixo, alternados pelo mesmo botão do header), aberto pelo botão **+ N fontes** dos chips de citação; header "Fontes" com contador, lista de todas as fontes usadas na conversa (letra/inicial do domínio, domínio e título truncado) que abrem no navegador padrão, estado vazio e rodapé com contagem. É mutuamente exclusivo com o painel de artefatos (abrir um fecha o outro).
- **Página Biblioteca** (`activeView: 'library'`, no lugar da coluna do chat, aberta pelo item "Biblioteca" da sidebar): header com "Voltar ao chat", título **Biblioteca** e descrição curta; à direita, **busca** (pill com ícone e botão limpar), **ordenação** (Recentes/Mais antigos/Nome/Tamanho), alternância **grade/lista** e botão primário **Enviar arquivos** (seletor nativo múltiplo; drag & drop com a página aberta). Abaixo, a faixa de **filtros em pills**: Tudo · Favoritos · Imagens · Documentos · Código · Mídia · Outros, com contagem. O conteúdo é uma **grade** de cards (`auto-fill`, mínimo 180px) ou **lista** de linhas: card com tile do tipo nas cores do design system, nome truncado (até 2 linhas), estrela de favorito, menu de ações (Renomear, Favoritar, Salvar como…, Abrir, Excluir), **miniatura** para imagens (PNG ≤512 px gerada no backend) ou ícone grande do tipo, e rodapé com `tipo · tamanho`, data e origem ("Biblioteca" ou título da conversa). Clicar abre a **prévia em dialog** (mesmos renderizadores do painel de artefatos) com navegação anterior/próximo, favoritar, renomear inline, salvar/abrir/excluir e rodapé "X de N". Estados: carregando (skeleton), erro com "Tentar novamente", biblioteca vazia (CTA Enviar arquivos) e filtro sem resultados ("Limpar filtros"). Sem molduras pesadas, sem tabela burocrática; mesmo sistema visual e tokens do resto do app.
- **Modos da aplicação (Chat | Code | Agentes)**: o seletor vive no rodapé das três sidebars: um botão apenas com o ícone do modo atual abre uma lista simples com ícone e nome dos layouts habilitados (o ativo destacado), com nomes também em `aria-label`/`title`; a escolha é persistida em `uiStore.layoutMode` e também acessível pela paleta ("Ir para o modo Chat/Code/Agentes"). A visibilidade dos layouts continua em Configurações → Geral → Layouts. **As sessões são separadas por layout**: uma conversa nasce no Chat (`mode: 'chat'`, default para dados antigos) ou no Code (`mode: 'code'`) e só aparece no layout de origem; cada layout lembra sua **própria sessão ativa** ao alternar. Uma sessão do Chat pode ser **adicionada ao Code** (`codeLinked: true`) e passa a ser compartilhada (mesma conversa, aparece nos dois layouts, pode ser removida do Code). O **modo Chat** é o layout de conversa descrito acima. O **modo Code** é o workbench de codificação inspirado no Paseo (o harness de agentes entra na etapa seguinte; por ora o que depende dele é estado vazio honesto), com o mesmo chrome contínuo (`bg-surface`) e o painel central `bg-background rounded-tl-lg`:
  - **Sidebar do Code** (mesma largura/redimensionamento/drawer compacto da sidebar do Chat, `aria-label` "Sessões"): ações compactas **+ Abrir pasta** (seletor nativo; cria/abre workspace), **+ Novo agente** (cria sessão `mode: 'code'` no workspace ativo), **Adicionar sessão do Chat**, **Buscar** (paleta) e **Skills**; seção **Workspaces** real (nome, ícone repo/pasta, `branch` + sujo, contagem de sessões, expandir/recolher, ativo destacado; menu **Nova sessão / Renomear / Abrir no Explorer / Copiar caminho / Remover do Zylara** — remover não apaga a pasta) e diálogo **“Confiar nesta pasta?”** (Confiar / Abrir em Leitura / Cancelar); seção **Sessões** agrupada por workspace (sem workspace → “Sem workspace” com chevron para recolher/expandir o grupo e `+` para criar uma sessão sem pasta; compartilhadas do Chat com selo **Do Chat**; a sessão em execução exibe um spinner de carregamento; sessões ociosas não exibem indicador; cada grupo mostra no máximo **10 sessões** e, quando há mais, um botão **Mostrar mais N sessões** revela a próxima página (a sessão ativa é sempre revelada, a busca ignora o limite e reordenar persiste a ordem do grupo inteiro); cada sessão tem o botão **…** com **Fixar/Desafixar, Renomear, Exportar, Remover do Code** (compartilhadas) e **Excluir** com confirmação, como no layout Chat); estados vazios honestos e rodapé Configurações + seletor de layout. **Sem Biblioteca** — a página só existe no modo Chat.
  - **Centro**: cabeçalho da sessão (h≈44px) com título, **chip do workspace** (nome/branch/dirty; menu Atualizar/Trocar workspace/Abrir no Explorer/Copiar caminho/Confiar; “Sem workspace” com CTA) e **medidor de contexto em tempo real** (chip com anel de progresso e `role="progressbar"`; o clique abre um popover com `X% do contexto usado`, `~usado / janela`, barra segmentada e legenda **Prompt de sistema / Definições de ferramentas / Mensagens**, além do limite de saída; ao lado do anel fica o **selo de cache do prompt** (`cache NN%`; o popover traz lido/gravado/novo, teto `P/(P+Δ)`, estado, última quebra, TTL e economia — `docs/goals/prompt-cache/PLAN.md` §7)), além do botão do painel direito (`PanelRight`, `aria-pressed`); abaixo, **abas de sessão** (`role="tablist"`, h≈40px, abas persistidas por workspace) com abrir/fechar/ativar, `+` e teclado; **todas as abas abertas no centro** (sessões, terminais, arquivos, diff, commits, subagentes, plano, objetivo, PRs e issues) são reordenáveis por arrasto (Alt+←/→ pelo teclado), com a ordem persistida em `uiStore.codeTabOrder`. A conversa é a **mesma `ChatView`** do Chat (rascunho/anexos/scroll preservados); a tela vazia usa o **welcome do Code** (sem workspace: “Comece com uma pasta” + Abrir pasta + recentes; com workspace: caminho/branch + sugestões). O composer é o **console da tarefa**: `@` busca arquivos do workspace (chips + `[arquivo: path]`), `/` abre o catálogo de comandos (`/plan`, `/plan off`, `/permissoes`, `/compact`, `/commit`, `/test`, `/review`, `/init`, `/novo`, `/limpar`), placeholder “Descreva a tarefa… @ para arquivos, / para comandos”, `Ctrl/Cmd+L` foca; ao lado do anexo ficam os **controles da sessão** — **chip de modo de permissão** (`Leitura`/`Editar`/`Revisar`/`Autônomo`, menu com a descrição de cada modo, atualização otimista com rollback), **toggle Plano somente ícone** (`aria-pressed`, accent-soft quando ativo; com o Plano ligado o campo mostra um **badge accent com ícone e o rótulo “Plano”** na área de chips, ao lado do `/goal`, que desativa o modo ao clique), **botão de objetivo somente ícone** (`Target`; alterna o chip `/goal` com a mesma lógica — accent + `aria-pressed` quando armado, clique no chip desativa a intenção; com objetivo persistente abre o popover) e **popover Plano, tarefas e trabalhos em segundo plano** — no lugar dos pills globais `Busca web`/`Criar arquivos`, que continuam apenas no composer do Chat (e em Configurações › Ferramentas).
  - **Painel direito do Code** (mesma superfície `bg-surface` da sidebar e sem borda vertical contra o chat, nos dois temas; Arquivos | Alterações; 360–900px, largura persistida compartilhada, divisor acessível, fecha abaixo de 1120px para manter ≥480px de conversa): as três abas (**Arquivos | Alterações | Terminal**) são reordenáveis por arrasto (Alt+←/→ pelo teclado) e a ordem fica em `uiStore.codePanelTabOrder`; as abas internas do terminal usam a mesma interação e atualizam a ordem global do `terminalManager`; barra com o workspace e o **seletor de branch** (somente na aba **Alterações**; as abas Arquivos/Terminal não repetem o contexto) e atualizar. O seletor de branch é um popover: campo de pesquisa (sem acento/caixa, casa nome, nome sem o prefixo do remoto, upstream e assunto do commit), lista agrupada em **Locais** (branch atual no topo, com `↑N`/`↓N`) e **uma seção por remoto**, marcação da branch atual, badge `removida` para upstream inexistente, botão **Nova branch** (cria a partir do HEAD atual e já troca) e **fetch** para atualizar as remotas. Escolher uma linha remota (`origin/feat`) faz checkout criando a branch local de tracking; toda mutação passa por `git_switch_branch`/`git_create_branch` e, ao terminar, o painel recarrega árvore/status/commits e o contexto do workspace (o chip do cabeçalho e a sidebar param de mostrar a branch antiga). Atalhos: `↑`/`↓` movem o destaque, `Enter` troca, `Esc` limpa a pesquisa. **Arquivos** = árvore real com menu de ações (clique direito na linha ou botão “…” no cabeçalho: criar arquivo/pasta, abrir ao lado em editor dividido, copiar caminho absoluto/relativo, mostrar no Explorer, baixar, renomear, duplicar e excluir com confirmação) (`role="tree"`, badges git `M/A/D/U/?`, filtro, teclado) com **ícones coloridos reais por tipo de arquivo** (Material Icon Theme, MIT — mapa e licença em `docs/FILE_ICONS.md`; pastas continuam no par lucide `Folder`/`FolderOpen` tingido por `accent`). **Abrir um arquivo agora abre uma aba central** (mesma faixa de abas das sessões, ícone do tipo + nome truncado + X): **cada arquivo aberto ganha a própria aba** na ordem de abertura — clicar num arquivo já aberto só ativa a aba dele, e fechar a aba ativa ativa a vizinha (fechar a última volta à conversa). O plano aprovado aberto por "Ver plano" usa a mesma aba central: Markdown com alternância Documento ⇄ Código, como um `.md` da filetree. O conteúdo ocupa o centro e é read-only — **código/texto** com Prism, números de linha e contagem (gutter com o mesmo fundo `--background` do código), **Markdown** com alternância Documento (renderizado pelo pipeline GFM/KaTeX do chat, padrão) ⇄ Código, **imagem** com zoom/ajustar à janela, **PDF** via pdf.js (páginas + zoom), e cartões honestos para binário/truncado/encoding e para imagem/PDF acima do limite inline (24 MiB); header com ícone do tipo, botão de **quebra de linha** (global, persistido e aplicado a todos os arquivos), "Recarregar", copiar caminho e "Abrir no Explorer". A antiga prévia inline do painel foi removida: a árvore ocupa o painel inteiro e o arquivo ativo fica destacado; clicar na aba da sessão volta à conversa; **Alterações** = agrupamentos Preparados/Não preparados/Novos/Da sessão, `+N −M`, cada linha com o ícone do tipo do arquivo, diff por arquivo (unificado, hunks, copiar patch), stage/unstage e reverter arquivo/turno com confirmação, rodapé de **commit** (alvo, mensagem, sugestão de IA, histórico). **Histórico de commits** (estilo Zed): a aba Alterações ganha **Histórico**, que abre uma aba central com a lista de commits do workspace; clicar num commit mostra autor/e-mail/data, SHA copiável, arquivos com status/`+N −M` e o **diff completo por arquivo** expansível (todos de uma vez com “Expandir diffs”). **Diff com syntax highlight**: as linhas do diff usam o Prism/tema compartilhado (`SYNTAX_THEME`, tokens em variáveis CSS) — as cores acompanham o tema claro/escuro e as linhas mantêm o fundo de adição/remoção; acima de 4.000 linhas o diff cai em texto puro para não travar. **Abrir diff** de um arquivo abre por padrão uma **aba central** ao lado das abas de sessão (ícone `FileDiff`, fechável; `Settings.diffOpenMode` alterna entre “Em uma aba do chat” (padrão) e “No painel lateral”, configurável em Configurações → Ferramentas → Workbench de código). Sem workspace: estados vazios honestos (“Nenhum workspace aberto”); sem git: aviso claro e Alterações da sessão continuam pelo journal.
  - **Sidebar do Chat**: lista apenas as sessões do Chat (as compartilhadas continuam nela); o menu da conversa ganha **“Usar no Code”** / **“Remover do Code”**.
  - **Skills** continua acessível no modo Code (item da sidebar; a página abre no centro com "Voltar à sessão"). **Biblioteca** não é renderizada no Code nem oferecida pela paleta; os comandos de artefatos/fontes do Chat também ficam ausentes nesse modo (a paleta nunca oferece beco sem saída). A **busca da paleta** (e os recentes) lista apenas sessões do layout atual.
  - **Modo Agentes (v1.14)**: terceiro segmento da pílula (`Agentes`). A sidebar agrupa **Canais**, **Fixados**, departamentos e threads da persona; o menu do agente abre **Nova conversa, Ver todas as conversas, Rotinas, Editar, Personalizar avatar, Duplicar, Exportar, Fixar, Arquivar e Excluir**. Cada thread tem menu próprio (**Fixar, Renomear, Exportar, Excluir**), contador de fila, indicador de atividade quando está respondendo e ícone de atenção quando aguarda aprovação/resposta ou o último turno falhou. O centro é a home da persona (avatar, papel, modelo, starters, conversas recentes) ou a thread; cada persona tem uma **conversa principal** fixada acima do histórico, aberta por um botão dedicado na home, e todas as rotinas executam nela (com fila persistente quando já há um turno ativo); com workspace, o header ganha o painel Arquivos/Alterações e as abas centrais de diff/arquivo/plano/commits/objetivo. As abas do painel do agente e as abas contribuídas por plugins (dock e sidebar, nos layouts Chat, Code e Agentes) também são reordenáveis por arrasto, com a ordem persistida por layout em `uiStore`. O composer mostra a fila (`Na fila · N`, pausar/retomar, remover, limpar), o seletor de modelo/raciocínio da persona (sem o chip de cache do Chat) e, no workspace, os controles de sessão do Code. O editor tem abas **Identidade / Avatar / Modelo / Comportamento / Capacidades / Memória**; “Criar com IA” devolve um rascunho revisável, “Editar com IA” mostra um diff campo a campo antes de aplicar, e Templates/Importar/Exportar ficam na Equipe; a própria Equipe lista os **Arquivados** com Restaurar/Excluir e oferece **Arquivar** no card de cada agente ativo. Várias threads podem responder ao mesmo tempo: cada uma mantém seu indicador de atividade na sidebar, a fila drena na própria thread e a thread visível controla o composer/Stop. A Equipe e a home mostram tokens/custo por agente. Contrato: `docs/AGENTS.md`.

  - **Avatar do agente**: clicar no avatar da home (ou usar **Personalizar avatar** no menu da sidebar) abre o diálogo **Avatar**, com prévia, envio de imagem (PNG/JPEG/GIF/WebP até 10 MB), formato, 10 expressões, 12 cores, 10 corpos e **Cor dos olhos** (Branco/Preto). Olhos e boca usam uma única cor sólida, sem pupila. O editor do agente repete o mesmo seletor na aba **Avatar**; ali as mudanças entram no Salvar, enquanto o diálogo rápido persiste na hora.
  - **Execução do agente**: enquanto `streamsByConversation`/`isStreaming` indica um turno ativo, o avatar da persona faz uma distorção suave (squash/stretch com bob) e pisca no sidebar, no header da thread e na mensagem em streaming; um indicador de três pontos aparece na linha do agente/thread e no chip **Executando** do header. `reduceMotion` desliga o movimento e mantém o anel e os pontos estáticos.

## 6. Estados da conversa

### 6.1 Boas-vindas (vazia)
- Marca 64px com glow suave, título 32px "Como posso ajudar?" e subtítulo muted.
- Grid 2×2 de sugestões (cards com ícone, título e descrição curta) que preenchem o composer.
- Dica de atalhos abaixo (`⌘K` comandos, `⌘B` sidebar).

### 6.2 Mensagem do usuário
- Alinhada à direita, bolha `bg-user-bubble` `rounded-3xl` `px-4 py-2.5`, largura máx. 80%.
- Anexos como chips acima do texto (ícone por tipo, nome truncado, tamanho).
- Ações no hover: copiar, editar.

### 6.3 Mensagem do assistente
- Alinhada à esquerda, sem bolha (fundo transparente), avatar 24px (marca Zylara) no topo esquerdo. No layout **Code** o avatar do app é omitido (workbench focado na tarefa).
- **Markdown completo** (contrato em `docs/MARKDOWN.md`): CommonMark (títulos h1–h6 ATX/setext, parágrafos, citações aninhadas, listas ordenadas/não ordenadas/aninhadas, código cercado e indentado, réguas, links, imagens, quebras duras, escapes) + GFM (tabelas com alinhamento e wrapper rolável, task lists somente-leitura, riscado, autolinks, notas de rodapé) + extensões do app (KaTeX inline/display, Mermaid, fences `chart`/`html`/`svg`, blocos `ui`, código com header de linguagem e botão copiar). Alertas GitHub (`> [!NOTE]` etc.) usam os tokens de cor do tema com ícone Lucide e rótulo pt-BR. HTML cru é permitido apenas no subconjunto seguro (ex.: `br`, `kbd`, `mark`, `sup`, `sub`, `details`/`summary`, `abbr`), sempre sanitizado — sem scripts, estilos inline, iframes ou handlers.
- **Segurança e resiliência do Markdown**: links externos e `mailto:` abrem no navegador/app padrão (nunca no webview); âncoras internas das notas de rodapé rolam na mensagem; imagens usam `alt` e têm fallback "Imagem indisponível" quando falham ou não têm fonte segura; URL insegura não vira link clicável.
- **Passos do agente (espaço de pensamento)**: um único bloco colapsável acima do texto, no lugar dos antigos cards de ferramenta. Header com ícone `Brain`, shimmer enquanto o agente trabalha ("Pensando…", "Executando ferramentas…"), contador de tempo ao vivo e, ao concluir, o total ("Pensou por 10s"; no layout **Code**, "Trabalhou por 10s", porque ali o tempo do turno inclui as ferramentas; sem raciocínio exposto, "N passos"). Expandido, uma timeline intercala os blocos de raciocínio (cada um é uma linha "Pensou" recolhível, fechada por padrão como as tools; expandir revela o Markdown do passo) com uma linha por atividade, na ordem em que aconteceram: "Encontrou 8 páginas web" (+ avatares de domínio das fontes), "Leu 3 páginas" (+ chips de páginas com sublinhado tracejado que abrem no navegador), "Criou 2 arquivos" (+ chips dos nomes), "Encontrou 3 artefatos" (busca na biblioteca), "Leu o artefato `relatorio.pdf`" (+ chips dos arquivos lidos), "Validou a interface". Cada linha mostra spinner enquanto executa, ícone da ferramenta ao concluir e mensagem em `danger` em caso de erro. O painel abre sozinho durante o streaming e recolhe quando a resposta começa a chegar; com a opção **Raciocínio recolhido por padrão** (Configurações → Geral) ligada, ele começa fechado e não abre sozinho, ficando a expansão por conta do usuário. No **Chat**, a visualização padrão é a compacta: o cabeçalho resume as ações por família ("Executou N comandos, leu N arquivos, pesquisou N vezes e usou N outras ferramentas") e o corpo é uma lista rolável com uma linha por ação (raciocínio recolhível e uma linha por chamada de ferramenta), limitada a `max-h-80` também durante o streaming. A linha do tempo detalhada descrita acima — com resumos agrupados, domínios, páginas, chips de arquivo e detalhes por chamada — continua disponível ao ativar **Passos detalhados do agente** em Configurações → Geral; os layouts **Code** e **Agentes** não mudam. O raciocínio do modelo é renderizado como **Markdown completo** (mesmo contrato de `docs/MARKDOWN.md` §4, mesma sanitização): o texto de cada passo chega em Markdown e usa a variante compacta/discreta do renderer (13px, `foreground-muted`, ritmo vertical reduzido) — títulos, listas, tabelas, código com copiar, math, links e alertas funcionam também no Thinking. As diferenças entre os layouts são mantidas: no **Chat**, tools de web/skills/artefatos aparecem como resumos agrupados (domínios, páginas, chips de arquivo); no **Code**, uma linha por chamada do harness (verbo + alvo + status/exit/duração + diff/saída sob demanda), com o mesmo raciocínio em Markdown nos dois.
- **Respostas intermediárias (layouts Code e Agentes)**: quando o modelo narra entre passos (`trace[].text`), o transcript deixa de ter um único bloco: cada narração intermediária aparece como Markdown normal no corpo da mensagem e o trabalho seguinte (raciocínio + chamadas até a próxima narração) vira uma **linha de atividade** colapsável. Enquanto a execução corre, a linha mostra o que o agente está fazendo e uma prévia em uma linha: "Analisando a solicitação · <trecho do raciocínio>", "Executando comandos · <comando>", "Editando arquivos · <path>", "Lendo arquivos · <path>", "Pesquisando na web · <query>"… (ícone/spinner da atividade, shimmer e o trecho truncado). Ao terminar, a linha vira **"Trabalhou por X"** — tempo do trecho, e no último trecho o tempo total do turno, formatado em segundos/minutos/horas (`2 min 5s`, `1 h 30 min`). O tempo do trecho soma o tempo de modelo de cada passo (o raciocínio incluído) à execução das tools; o último trecho nunca mostra menos que a soma das partes e, enquanto a resposta final ainda está chegando (o `usage` do backend só fecha no fim do turno), usa o relógio do turno — o total nunca cai para o tempo das tools sozinho. Dentro dela ficam as linhas `Raciocínio Ns` (recolhíveis, Markdown do passo) e as mesmas linhas de tool (`ToolCallRow`). O bloco da execução corrente abre durante o streaming e fecha ao concluir o turno (com **Raciocínio recolhido por padrão** e no layout Agentes começam fechados); a resposta final continua abaixo da timeline. Turnos sem narração intermediária e mensagens antigas (trace sem `text`) mantêm o bloco único (`Trabalhou por …` no Code). O layout **Chat** mantém sempre o bloco único.
- **Citações**: chips de fonte em linha (`favicon`/letra do domínio, título truncado), abrem no navegador. Até 2 chips ficam visíveis; acima disso o excedente vira o botão **+ N fontes**, que abre o painel lateral de fontes com a lista completa da conversa (sem expansão inline). Nos layouts **Chat** e **Agentes**: o layout **Code** não exibe chips nem painel de fontes.
- **Artefatos**: cards compactos (tile do tipo — incluindo áudio, vídeo e arquivo compactado na v1.5 —, nome truncado, "tipo · tamanho" e os botões existentes **Abrir** e **Salvar como…**), em grid de até duas colunas. Quando o turno gera mais de 4 arquivos, o chat mostra os 4 primeiros e um botão **+ Ver todos (N)** que abre o painel lateral na lista completa de artefatos gerados; clicar em um card abre a prévia no painel. A lista é atualizada ao vivo pelos eventos `artifact_created` e reconciliada com o backend ao fim do turno/ao reabrir a conversa (ordem canônica de criação), sem cards órfãos ou duplicados.
- **Fecho do turno (somente no layout Code)**: ao terminar cada turno, a resposta termina com um card de resumo do que foi feito: título **N arquivos alterados**, totais `+N −M` (success/danger, `tabular-nums`), uma linha por arquivo (ícone colorido do tipo, path truncado e `+N −M`) e, acima de 4 arquivos, o botão **Todos os N arquivos** / **Mostrar menos** (`aria-expanded`/`aria-controls`, chevron 150ms). Clicar em uma linha abre o diff daquele arquivo na aba central, como no painel Alterações — usa o patch persistido da última edição do turno e, quando ausente, a aba busca o diff do arquivo. O card deriva das edições de arquivo já persistidas no turno (presentations `file_change` de `write_file`/`edit_file`), então continua visível ao reabrir a conversa; não aparece durante o streaming nem no layout Chat. O tempo/tokens do turno continuam no header do bloco "Thinking" ("Trabalhou por Xs"). Contrato e dados: `docs/goals/code-harness/WORKBENCH.md` §5.1.
- **UI generativa**: renderizada inline no fluxo do markdown nos dois layouts (Chat e Code), usando o design system (tokens, tipografia e raios do chat). Blocos interativos (`actions`, `tabs`, `reveal`) seguem regras próprias de UI/UX — ver `docs/GENUI.md` e §16.
- Rodapé da mensagem (hover): copiar, regenerar, feedback (like/dislike visual), modelo usado e tokens (se `showTokenUsage`).
- Streaming: caret `accent` piscando após o último caractere.

### 6.4 Erros
- Card `danger-soft` com ícone `AlertTriangle`, título "Não foi possível concluir", mensagem técnica resumida, botão "Tentar novamente".
- Erros de chave: CTA para abrir Configurações › Provedores.
- Toasts (sonner) para falhas assíncronas, canto inferior direito.

### 6.5 Cancelamento
- Órbita de execução no perímetro inteiro do composer durante o streaming (trilho accent contínuo + cometa de luz com cauda longa); com redução de movimento o perímetro fica com um traço accent estático; botão enviar vira quadrado "parar".
- Mensagem parcial permanece com selo "Cancelado".

## 7. Composer (detalhe)

```
┌──────────────────────────────────────────────────────────────┐
│ [chip anexo ×] [chip anexo ×]                                │
│ Textarea “Pergunte alguma coisa…”                       (⏎)  │
│ ──────────────────────────────────────────────────────────── │
│ [+] anexar   [🌐] [📄]                       [modelo ▾] [→]  │
└──────────────────────────────────────────────────────────────┘
```
- Enter envia / Shift+Enter quebra linha (configurável; Ctrl+Enter alternativo).
- Botão enviar: círculo 32px, `bg-foreground` (light) / `bg-foreground` (dark), ícone `ArrowUp`; desabilitado quando vazio; vira `Square` (parar) durante streaming.
- Anexar: seletor de arquivos nativo (`@tauri-apps/plugin-dialog`), também drag & drop na janela.
- **Toggles de ferramentas (Chat)**: `Busca web` e `Criar arquivos` com estado on/off (accent-soft quando ligado), **somente ícone**; `aria-label`/`title` mantêm o rótulo completo. No layout Code esses dois controles dão lugar aos **controles da sessão** (logo abaixo).
- **Variante do Code**: a mesma faixa de controles troca os toggles de ferramentas pelos **controles da sessão** — **chip de modo de permissão** (`Leitura`/`Revisar`/`Editar`/`Autônomo`; o modo inicial das novas sessões vem de Configurações → Ferramentas → Sessões de código, padrão Autônomo; menu com a descrição de cada modo e atualização otimista com rollback) e **toggle Plano somente ícone** (`aria-pressed`; accent-soft quando ativo). Com o Plano ativo, o campo mostra um **badge accent com o ícone e o rótulo “Plano”** (`aria-label="Desativar modo Plano"` e tooltip) na área de chips, ao lado do `/goal`; clicar nele desativa o modo. O **botão de objetivo** da barra segue o mesmo padrão: alterna o chip `/goal` (accent e `aria-pressed` quando armado; clicar no chip desativa a intenção) e, com objetivo persistente, abre o popover do objetivo. Ficam ao lado do botão de anexar, antes do seletor de modelo; `Busca web`/`Criar arquivos` continuam existindo no composer do Chat e em Configurações › Ferramentas.
- **No layout Agentes** o pill do composer mostra a rota da persona/thread e abre
  o mesmo popover. Antes da primeira mensagem ele edita o modelo da persona e
  sincroniza a thread vazia; depois do primeiro envio o cadeado trava o modelo
  (o ✦ continua ajustando o raciocínio). Os indicadores de cache do Chat não
  aparecem nesse layout (nem no composer nem no medidor de contexto do header).
- Seletor de modelo (no composer do chat): pill segmentado em duas partes — ① glifo da marca do modelo (LobeHub, mono, tingido por tokens) + nome; ② rótulo do pensamento (ex.: "Alto"). O nome trunca em **144px** (`max-w-36`; 96px no compacto) e o rótulo de pensamento em **128px** (`max-w-32`), com o texto completo em `aria-label`/`title`. A fileira de controles do composer é um **container de consulta**: abaixo de **42rem** de largura do composer, os dois rótulos somem e o pill fica só com os ícones (glifo + ✦, com cadeado/chevrons); o **chip de permissão** do Code segue a mesma regra (só o escudo). O pill abre um **popover em duas etapas**: a lista de modelos (busca com foco automático, alternância Go/Zen, Favoritos + famílias) e, ao escolher um modelo, a mesma superfície troca para os **modos de pensamento** (Desligado / esforços / orçamento), com a descrição de cada modo e botão de voltar. Os **detalhes do modelo** (contexto, custo, protocolo, capacidades, favoritar) aparecem numa **bolha flutuante ao lado do popover**, como uma tooltip: surge no hover ou na navegação por teclado, nunca empurra o layout. O segmento ② abre direto a etapa de pensamento; modelos sem controle de raciocínio mostram o segmento desabilitado ("Padrão"). A busca do popover consulta os dois provedores. O item **"Ver todos os modelos…"** no rodapé abre o **seletor completo** (dialog) — não há botão extra na interface do chat.
- **Ícones de marca**: o avatar de cada modelo (pill, lista do popover, bolha de detalhes e dialog) usa os glifos oficiais da [LobeHub Icons](https://icons.lobehub.com) (`@lobehub/icons-static-svg`, MIT) na variante mono, tingidos pelo token de cor da família; famílias sem marca oficial caem nas iniciais do nome. Mapa, decisão e licença em `docs/MODEL_ICONS.md`.
- **Bloqueio de modelo**: no **Chat**, depois do primeiro envio o modelo da conversa fica travado (cadeado no pill, com explicação ao clicar) — trocar de modelo no meio da conversa misturaria respostas de modelos diferentes e invalidaria o replay do raciocínio. No **layout Code**, sessões do Code (nativas ou compartilhadas) podem trocar modelo/provedor **entre turnos**: a escolha é uma propriedade da sessão, persistida na hora (`set_conversation_model`) sem alterar o modelo padrão das próximas conversas; as respostas antigas mantêm o modelo que as produziu (histórico neutro) e o transcript marca o ponto com o divisor "Modelo alterado para …". Durante o streaming o seletor continua bloqueado nos dois layouts ("Aguarde a resposta atual terminar"). O **modo de pensamento continua ajustável** pelo segmento ✦ em todos os casos. "Novo chat"/"Novo agente" volta ao modelo padrão configurado; ao abrir uma conversa existente, o seletor reflete o par persistido na sessão.
- **Indicador de execução**: enquanto um turno roda, todo o perímetro do composer vira um trilho accent sutil percorrido por um cometa de luz com cauda longa (traço de 1px rente à borda, sem interferir no campo de texto). Nos dois layouts o mesmo trilho é usado; com redução de movimento o perímetro fica com um traço accent estático.
- Dica de rodapé: "Zylara pode cometer erros. Verifique informações importantes." (11–12px, muted).

## 8. Model Picker (dialog completo)

> O caminho padrão é o pill com o popover em duas etapas (DESIGN §7). Este
> diálogo é o modo avançado, aberto por "Ver todos os modelos…" no rodapé da lista.

- Largura 760px, altura 580px, `rounded-2xl`, com `max-w`/`max-h` para janelas pequenas (mín. da janela: 900×620).
- Header: título "Selecionar modelo", descrição curta, busca (global, em todos os provedores) e chips de filtro — Favoritos, Visão, Raciocínio, Grátis (`aria-pressed`) — com contagem de modelos.
- Abas de provedor `OpenCode Go` / `OpenCode Zen` / `OpenAI (ChatGPT)` / `Anthropic` com dot de status (chave ou conta conectada; tooltip com a origem/estado). Com busca ativa, as abas dão lugar a "Todos os provedores" e os grupos viram "Go · Claude", "Zen · Claude", "ChatGPT · GPT", "Anthropic · Claude", etc. Modelos `estimated` (só da conta) mostram selo próprio; com plano ChatGPT ativo o preço por token é substituído por "Incluído no seu plano ChatGPT" + "Gerenciar uso".
- Lista agrupada por família (favoritos primeiro, "Outros" por último); cada linha: glifo da marca do modelo (LobeHub, mono, tingido por tokens), nome, badges (Grátis/Visão/Raciocínio/Preview), contexto, preço, check no modelo em uso e estrela de favorito (visível no hover/foco).
- Coluna direita (300px): identidade do modelo (nome, provedor, id), badges, descrição, especificações (contexto, saída máxima, custo, protocolo, entrada, conhecimento, lançamento), aviso de status (indisponível/preview/grátis), aviso de chave ausente com "Configurar" e **seletor de modo de pensamento** (segmented: Desligado + esforços; slider para `budget_tokens`).
- Interação: clique = prévia; duplo-clique, Enter na busca ou "Usar este modelo" = confirma. Setas/Home/End navegam e atualizam a prévia. Esc limpa a busca antes de fechar.
- Rodapé fixo com dicas de teclado (↑↓, ↵, Esc), badge "Em uso" e botão "Usar este modelo".
- Modelos indisponíveis aparecem desabilitados com motivo; o estado é remontado a cada abertura.
- Se o modelo está travado, o dialog mostra um aviso compacto com o modelo em uso e a dica de ajustar o pensamento pelo ✦, em vez do seletor. A copy segue o motivo: no Chat com conversa já iniciada é o bloqueio permanente; durante o streaming (qualquer layout, inclusive uma sessão do Code) é "Aguarde a resposta atual terminar" — o bloqueio permanente tem precedência quando os dois valem.

## 9. Configurações (dialog)

Tabs à esquerda (180px), conteúdo à direita (520px):
1. **Geral**: tema (Claro/Escuro/Sistema), idioma, tamanho da fonte, enviar com Enter/Ctrl+Enter, reduzir movimento, mostrar uso de tokens, raciocínio recolhido por padrão, passos detalhados do agente.
2. **Temas**: gerenciador de temas instalados (galeria com prévia de cores, aplicar, instalar pacote `.zip`, recarregar, abrir pasta e remover) e alternância Claro/Escuro/Sistema. Inclui os temas embutidos Zylara, Aurora, Ember, Grove, Nebula e Nocturne; os embutidos não podem ser removidos.
3. **Provedores**: lista **Provedores populares** num único card com divisórias — cada linha tem o glifo da marca (LobeHub mono, pacote `@lobehub/icons-static-svg` já usado pelos modelos — MIT — com iniciais como fallback), nome + selo **Recomendado** no provedor padrão (OpenCode Go), descrição curta do catálogo, selo de estado (Configurada/variável de ambiente/OpenCode CLI, Plano ChatGPT, Aguardando, Sessão expirada) e o botão **Conectar** (ícone `+`) ou **Gerenciar** (ícone de ajustes) que abre o modal de configuração. Abaixo da lista, **Ver mais provedores** abre um modal com os provedores fora do conjunto popular — hoje os 21 provedores de API key do catálogo (agrupados por categoria e com busca no topo do modal), e cada provedor novo entra ali automaticamente, com o mesmo botão de conectar. O modal `Conectar/Gerenciar <provedor>`: em provedores de API key traz o campo mascarado (rótulo + placeholder por provedor), **Continuar**, link do console, resumo da chave salva (origem, mascarada, `env`), **Remover**, **Testar conexão** e as notas do catálogo; no OpenAI traz **Continuar com ChatGPT** (OAuth oficial, sem API key), estados (aguardando/cancelar/abrir novamente/copiar link), aviso explícito com detalhes quando o opener do sistema não consegue abrir o navegador, conta conectada com e-mail + selo **Plano ChatGPT** + **Gerenciar uso** + **Sair** + detalhes (client/host mascarados, escopos, expiração de 1 h), "Ativar uso do plano" quando o escopo não foi concedido e API key `sk-…` como alternativa. Anthropic (`sk-ant-…`, console `platform.claude.com/settings/keys`) e Google Gemini (`AIza…`, `aistudio.google.com/apikey`) são só API key, sem OAuth. Erro de segredos corrompidos vira banner com "Abrir pasta de dados".
4. **Modelo padrão**: provider + modelo + modo de pensamento padrão (com uma conversa em andamento, alterações aqui valem apenas para novas conversas).
5. **Instruções do sistema**: textarea com o prompt customizado (placeholder mostra o padrão), contador de caracteres.
6. **Ferramentas**: busca web (on/off), criação de arquivos (on/off), máximo de passos do agente (1–1000, padrão 64), execução de código (opt-in + tempo limite), cache de prompt, **Sessões de código** (modo de permissão padrão das novas sessões do Code — Leitura/Revisar/Editar/Autônomo, padrão **Autônomo** — e onde o diff dos arquivos abre) e ambiente de código/skills.
7. **Dados**: abrir pasta de dados, exportar todas as conversas, limpar todos os dados (confirmação dupla).
8. **Sobre**: versão, Tauri, commits do catálogo, link do projeto.
9. **Experimental**: aviso de que os recursos estão em desenvolvimento e uma lista de switches para os recursos com `stage: 'experimental'` em `src/lib/experiments.ts` (plugin platform, reasoning slider, ACP agents e agent channels na primeira leva). Cada switch salva via `saveSettings` em `Settings.enabledExperimentalFeatures`, preservando campos legados quando existem. Ao promover um recurso para `stable`, basta trocar o `stage` no registro e remover o gate do consumidor: a entrada desaparece da aba e overrides antigos são ignorados.

## 10. Paleta de comandos (⌘K / Ctrl+K)

> Contrato completo (auditoria, catálogo e decisões): `docs/COMMAND_PALETTE.md`.

- Overlay 640px, topo ~9vh, lista com scroll (máx. 420px), fundo
  `surface-raised` e mesmos tokens do design system.
- **Duas fontes na mesma lista**: comandos locais (capability-aware: só aparece
  o que pode rodar no contexto) e conversas do histórico (busca no backend por
  título/conteúdo, 160ms de debounce, mínimo 2 caracteres, até 5 resultados,
  com fallback local normalizado). Query vazia: “Conversas recentes” → “Sugestões”
  (comandos recentes; fallback: novo chat, trocar modelo, configurações, tema,
  focar composer) → grupos de comandos. Query preenchida: “Conversas
  encontradas” → grupos de comandos.
- **Busca tolerante**: sem acentos/caixa, multi-token (AND) e fuzzy com
  subsequência; trecho casado em `<mark>` (`bg-accent-soft text-accent`).
  Resultado que casou só no conteúdo mostra o selo “Conteúdo”.
- **Escopos**: `>` só comandos, `#` só conversas (prefixo opcional).
- **Teclado**: ↑/↓ com wrap, Ctrl+N/P, Home/End, PageUp/PageDown, Enter executa,
  ⌘/Ctrl+Enter fixa/desafixa a conversa ativa (mantém aberta), Esc limpa a busca
  (primeiro) e fecha (segundo), ⌘K fecha. Com a paleta aberta nenhum outro
  atalho global age no fundo. IME nunca dispara Enter.
- **Ações** que abrem outra superfície fecham a paleta e agendam o efeito para o
  próximo tick (foco devolvido antes do dialog destino). Rodapé mostra dicas
  contextuais e a contagem (“N comandos · M conversas”).
- **Acessibilidade**: combobox com `aria-activedescendant`, listbox com grupos
  `role="group"`/`aria-labelledby`, opções com `aria-selected`/`aria-label`,
  região `aria-live` com a contagem, foco visível e foco inicial no input.
- **Atalhos exibidos**: novo chat (⌘N), configurações (⌘,), sidebar (⌘B), focar
  composer (⌘J). Ações contextuais: parar/regenerar (streaming), limpar anexos
  (pendentes), exportar/copiar/fixar (conversa ativa), skills (quando ligadas).

## 11. Motion

| Elemento | Animação |
| --- | --- |
| Mensagem nova | fade-in-up 260ms |
| Diálogos | entrada fade + scale 0.97→1 (180ms) e saída fade + scale 1→0.97 (150ms) |
| Popover do seletor de modelo | entrada fade + scale 0.97→1 (180ms) e saída scale-out (150ms) |
| Menus dropdown e tooltips | fade-in na abertura e fade-out no fechamento (160ms) |
| Views centrais (Biblioteca, Skills, Code diff/arquivo/terminal etc.) | fade + deslocamento vertical de 6px na entrada (180ms) e saída em fade; a conversa permanece montada |
| Sidebar | width/translate 220ms ease-out-soft |
| Seletor Chat/Code | a pílula ativa desliza entre os segmentos em 180ms ease-out-soft; com reduceMotion só troca de cor |
| Redimensionamento da sidebar | sem transição enquanto arrasta (a largura acompanha o cursor); abertura/colapso mantêm 220ms |
| Artifact panel | slide-in 240ms (modo sobreposto); no modo fixo o chat reflui imediatamente |
| Sources panel | slide-in 240ms (modo sobreposto; mesmo movimento do painel de artefatos) |
| Redimensionamento dos painéis laterais | sem transição de largura enquanto arrasta; slide-in/out mantém 240ms no modo sobreposto |
| Pensando | shimmer no texto + pulso da marca |
| Passos do agente | shimmer no header durante o streaming; timeline expande/recolhe |
| Execução do agente (composer) | cometa de luz orbita o perímetro do composer em 5.6s chamando a atenção para o estado ativo; com reduceMotion o perímetro fica com um traço accent estático |
| Timeline de passos | linha de atividade entra com fade, spinner enquanto executa |
| Reordenação por arrasto (listas e abas) | item elevado (scale 1.03) segue o cursor; linha de destino faz fade; vizinhos e item solto interpolam a nova posição em 180ms ease-out-soft |
| Caret de streaming | blink 1.1s |
| Hover de botões | 120ms |

Com `reduceMotion` (config ou media query), remover transformações e shimmer; manter apenas fade. A config adiciona `html.reduce-motion`, que desliga também as animações CSS; em conjunto com a media query `prefers-reduced-motion`, cobre diálogos, painéis e reordenação.

## 12. Acessibilidade

- Todos os ícones-botão têm `aria-label`; tooltips em hover/focus.
- Diálogos Radix (focus trap, escape, `aria-labelledby`).
- Mensagens com `aria-live="polite"` durante streaming (role log).
- Contraste mínimo 4.5:1 para texto normal; placeholders ≥3:1.
- Alvos de toque ≥32px; foco visível com anel `accent`.
- Navegação completa por teclado: composer, lista, sidebar, dialogs.
- Sidebar redimensionável: divisor focável (`role="separator"`, `aria-orientation="vertical"`, `aria-valuenow/min/max`), ←/→ movem 16px, Home/End vão aos limites, duplo clique restaura 272px, cursor `col-resize` e feedback visual de hover/foco/arrasto.
- Painéis laterais direitos (artefatos/fontes) redimensionáveis: mesmo divisor acessível na borda esquerda (360–900px, ←/→ movem 16px, Home/End nos limites, duplo clique restaura 480px), compartilhando a largura persistida entre os dois painéis. O botão de modo (fixar/soltar painel) usa `aria-pressed` e fica desabilitado quando a janela não comporta o modo fixo.
- Seletor de modelos: combobox + listbox com `aria-activedescendant`; busca focada ao abrir; setas/Home/End/Enter/Esc; grupos com `aria-label`; favoritos com `aria-pressed`; modelos indisponíveis com `aria-disabled`; foco devolvido ao pill ao fechar.
- Página Biblioteca: cada card é um botão com nome acessível (nome + tipo + origem), ícones-botão com `aria-label` (favoritar, menu de ações, enviar arquivos, limpar busca, grid/lista), pills de filtro como grupo de rádio (`role`/`aria-checked`) e foco visível; o dialog de prévia é Radix (focus trap, Esc) e a exclusão pede confirmação inline; Esc na página volta ao chat.

## 13. Responsivo

- < 1024px: sidebar vira overlay (drawer) com backdrop.
- < 768px: composer mais compacto; os toggles de ferramentas são somente ícone em qualquer largura.
- Composer com **container queries** (largura da própria fileira de controles, não a da janela): abaixo de **42rem**, o nome do modelo e o rótulo de pensamento do pill somem (ficam glifo + ✦) e o chip de permissão do Code fica só com o escudo; `aria-label`/`title` preservam o texto completo. Assim o layout reage também quando o painel direito ou o painel de artefatos estreitam a conversa.
- Artifact panel: no modo sobreposto ocupa até `92vw` em telas pequenas (sheet); o modo fixo só entra em janelas ≥1120px.
- Painel lateral direito: largura máxima é re-clampada em tempo real (modo sobreposto ≤ `92vw`; modo fixo ≤ janela − sidebar − 480px de chat). Abaixo de 1120px de janela o modo fixo degrada automaticamente para sobreposto (a preferência fica salva e volta a valer quando a janela cresce); a alça de redimensionamento usa esse limite dinâmico e a janela pode ser redimensionada com o painel aberto sem overflow.
- Modo Code: sidebar vira o mesmo drawer abaixo de 1024px; o painel Arquivos/Alterações só é renderizado a partir de 1120px (o botão do cabeçalho fica desabilitado com dica "Aumente a janela…" e a conversa mantém ≥480px). O seletor de layout vive no rodapé das sidebars, nunca na banda de chrome. Na banda de 40px: abaixo de 1024px o ícone do app e o botão da sidebar migram para a linha de chrome do centro (o drawer usa o botão fechar), o `UpdateChip` fica só com o ícone e as ações de plugin são limitadas a `28vw`; títulos truncam antes das ações globais e os controles de janela nunca encolhem (128px reservados em toda linha que ocupa o canto, com ou sem painel direito dockado).
- Chip de atualização: texto completo a partir de 1024px; abaixo disso fica só o ícone + chevron (o `aria-label`/tooltip mantém a versão e a etapa). O popover de 360px usa `collisionPadding` para não sair da janela em telas de 900px.

## 14. Microcopy (pt-BR)

- Novo chat, Buscar conversas, Configurações, Modelo padrão, Modo de pensamento, Buscar modelos…, Limpar busca, Usar este modelo, Configurar, Modelo bloqueado nesta conversa, Aguarde a resposta atual terminar, A troca de modelo fica disponível quando a resposta atual terminar, Troca de modelo indisponível durante a resposta, Modelo da sessão alterado, As próximas respostas usarão {nome}., Modelo alterado para {nome}., A conversa atual já foi iniciada. As alterações abaixo valem apenas para as próximas conversas., Anexar arquivos, Busca web, Criar arquivos, Pensando…, Executando ferramentas…, Pensou por 10s, Encontrou 8 páginas web, Leu 3 páginas, Criou 2 arquivos, Pesquisando nos artefatos…, Encontrou 3 artefatos, Nenhum artefato encontrado, Lendo o artefato relatorio.pdf…, Leu o artefato relatorio.pdf, Não foi possível ler o artefato, Validou a interface, Parar, Copiar, Regenerar, Artefatos, Ver lista de artefatos, Ver todos (N), Nenhum artefato nesta conversa, Fontes, Nenhuma fonte nesta conversa, Abre no navegador padrão, Salvar como…, Abrir, Excluir, Fixar, Renomear, Exportar, Limpar dados.
- Prévia de artefatos (v1.5): Controles da imagem, Ajustar à janela, Tamanho real, Aumentar/Diminuir zoom, Documento, Código, Árvore, Quebrar linhas, Rolagem horizontal, Primeiros N bytes, Mostrando X de Y entradas, Carregando prévia…, Tentar novamente, “Arquivo grande demais para reprodução inline; use Abrir/Salvar”, “Formato sem prévia no visualizador”.
- Prévia de skill (dialog da gestão de skills): Visualizar skill, Carregando conteúdo da skill…, Não foi possível carregar o conteúdo da skill, Tentar novamente, “Esta skill não tem instruções.”, Documento, Código.
- Painel lateral direito: Fixar painel ao lado do chat, Soltar painel sobre o chat, Aumente a janela para fixar o painel, Redimensionar painel de artefatos/fontes.
- Biblioteca: Biblioteca, Voltar ao chat, Pesquisar na biblioteca, Limpar busca, Enviar arquivos, Enviando arquivos…, N arquivo(s) enviado(s), Nenhum arquivo enviado, Solte para enviar à biblioteca, Tudo, Favoritos, Imagens, Documentos, Código, Mídia, Outros, Recentes, Mais antigos, Nome (A–Z), Tamanho, Grade, Lista, Sua biblioteca está vazia, Nenhum artefato encontrado, Limpar filtros, Favoritar, Desfavoritar, Renomear, Renomear arquivo, Salvar como…, Abrir, Excluir, Excluir arquivo, Esta ação não pode ser desfeita, arquivo(s), Carregando biblioteca…, Não foi possível carregar a biblioteca, Tentar novamente, Arquivo enviado, Biblioteca (enviado pelo usuário), Originado de “título da conversa”.
- Paleta de comandos: Buscar conversas ou comandos…, Conversas recentes, Sugestões, Conversas encontradas, Buscando conversas…, Nenhum resultado para “x”, Busca no histórico indisponível; mostrando título e prévia, Conteúdo, navegar, executar, fixar/desafixar, limpar busca, fechar.
- Modo Code (v1.9): Chat, Code, Abrir pasta, Novo agente, Nova sessão, Fechar <sessão>, Sessões, Workspaces, Nenhum workspace aberto, Abra uma pasta na barra lateral para o agente ler, editar e rodar comandos aqui., Pesquisar workspaces, Filtrar workspaces, Adicionar workspace, Pesquisar workspaces…, Todos, Com git, Sem git, Não confiáveis, Com sessões, Sem sessões, Nenhum workspace encontrado, Ajuste a pesquisa ou os filtros para ver outros workspaces., Limpar filtros, Limpar pesquisa, X de Y workspaces., Confiar nesta pasta?, Abrir em Leitura, Remover do Zylara, Do Chat, Buscar, Skills, Sem workspace, Nova sessão sem workspace, Mostrar mais N sessões, Mostrar mais N sessão, Arquivos, Alterações, Nenhuma alteração pendente, Preparados, Não preparados, Novos, Da sessão, Reverter arquivo, Reverter turno, Sugerir mensagem, Commit, Sem commits ainda, Descreva a tarefa… @ para arquivos, / para comandos, Modo Plano, Leitura, Editar, Revisar, Autônomo, Plano, Contexto, Contexto usado, Prompt de sistema, Definições de ferramentas, Mensagens, Limite de saída, Compactar agora, Trabalhou por …, Ver alterações, Permitir, Negar, Sempre permitir, Executar comando?, Gravar alteração?, Aprovar e executar, Aprovar e revisar cada edição, Continuar planejando, Voltar à sessão, Ir para o modo Code, Ir para o modo Chat, Recolher painel, Redimensionar painel de arquivos, Aumente a janela para ver o painel de arquivos., Resumo do turno, N arquivos alterados, 1 arquivo alterado, Todos os N arquivos, Mostrar menos, Abrir diff de ….
- Cards do harness: aprovação com risco (leitura/comando/destrutivo/segredo/fora do workspace) e pergunta com opções, inline no transcript (bloqueiam o turno). O transcript **não** renderiza cards de tool (diff, tarefas, plano, jobs, respostas): o "Thinking" resume a atividade e o popover do composer concentra **plano, tarefas e trabalhos em segundo plano** (status, comando, tempo, parar), além do medidor de contexto em tempo real (ok/atenção/compactando; breakdown Prompt de sistema / Definições de ferramentas / Mensagens e o **cache hit** em % com teto/estado/última quebra). Negar não cancela o turno: o motivo volta ao agente.
- Sessões separadas (v1.10): Adicionar sessão do Chat, Buscar sessão do Chat…, Nenhuma sessão do Chat disponível, Adicionar ao Code, Do Chat, Sessão compartilhada do Chat, Usar no Code, Remover do Code, Sessão adicionada ao Code, Sessão removida do Code, “Agora ela aparece nos dois layouts.”, “Ela continua disponível no Chat.”, Nenhuma sessão ainda., Comece um novo agente ou adicione uma sessão do Chat.
- Erros: "Não foi possível concluir", "Chave de API ausente", "Limite de uso atingido", "Tente novamente em instantes".

## 15. Anti-padrões proibidos

- Gradientes em botões/textos comuns, sombras coloridas, bordas neon.
- Emojis decorativos em excesso (apenas onde o conteúdo do modelo os trouxer).
- Cards dentro de cards sem hierarquia.
- Animações > 300ms em interações.
- Texto cinza claro sobre fundo claro, ou `opacity` como substituto de cor.
- **Contorno fechado**: nenhum elemento usa `border` nos quatro lados, anel
  estático ou `outline` como moldura — a hierarquia vem de superfícies e
  espaçamento. **Divisores assimétricos** são permitidos apenas como linha de 1px
  uniforme entre conteúdo (`divide-y`, `border-b`, `hr`), nunca como moldura
  parcial de um lado só.
- **Caixas de alerta/tip no Markdown** (`> [!TIP]` etc.): alertas renderizam
  como bloco neutro (ícone + rótulo + texto, sem caixa/fundo/borda). Citações
  também são texto sem moldura.
- **UI generativa**: props de estilo (cores, fontes, raios, sombras) — o agente
  usa apenas os componentes e tokens do design system; card dentro de card;
  containers vazios; `grid` com linha incompleta; tabela/gráfico sem título;
  botões que enviam mensagem sem o usuário revisar; duas ações `primary`;
  **caixas de nota coloridas (`callout`, descontinuado)**; emojis e Markdown
  dentro de props. Detalhes e limites: `docs/GENUI.md`.

## 16. UI generativa na conversa (Chat, Code e Agentes)

Regras de apresentação específicas das interfaces que o agente cria durante a
execução (contrato e regras completas em `docs/GENUI.md`):

- **Uso padrão**: o agente prefere um bloco `ui` sempre que julgar viável e a
  resposta tiver dados estruturados; o Markdown fica para texto corrido,
  explicações e listas simples.
- **Mesmo sistema visual do chat**: superfícies `surface-raised`, moldura de 1px
  (exceção consciente: GenUI e Markdown mantêm o desenho emoldurado),
  raio `rounded-xl`/`rounded-2xl`, tipografia 12–13,5px, números `tabular-nums`.
  Componentes não aceitam props de cor/tamanho — não há “tema paralelo”.
- **Hierarquia**: um `card` raiz com `title` (ou `section` para feeds/listas);
  dentro dele `grid`/`chart`/`table`/`text`/`source`; `actions`/`choices` por
  último. Sem card aninhado, sem container vazio, sem divisor decorativo.
- **Densidade**: 1 bloco por resposta (máx. 2), ~60 componentes (máx. 120),
  até 6 níveis; linhas de leitura confortáveis; conteúdo longo vai para
  Markdown/artefato.
- **Interação**: `actions` são botões do design system (sm, 32px) em grupo
  acessível; `primary` única, `secondary`/`ghost` para o resto; clicar em
  `prompt` preenche o composer (o usuário revisa e envia) e `copy` copia com
  toast discreto. `choices` é um formulário de seleção local (rádio/checkbox/
  segmentado) com contador e progresso sincronizados; o botão de envio preenche
  o composer com `submitPrefix + seleção` — nunca envia sozinho. `reveal` usa
  `<details>` com chevron 150ms; `tabs` usa Radix.
- **Feed/conteúdo rico**: `section` + `stack` `direction: row` + `image`
  (`size: thumb`) + `badge` + `text` + `source` monta cartões de notícia como
  no feed; `source` e itens de `list` com `href` abrem no navegador padrão;
  `checklist` mostra etapas/capacidades com ícone e status.
- **Estados**: bloco inválido degrada para código + diagnóstico discreto
  (nunca tela quebrada); avisos de design vão apenas para o console do DevTools
  em DEV, nunca para a mensagem; carregamento de
  imagem tem fallback; tabela vazia/gráfico inválido têm mensagem muted.
- **Acessibilidade**: contraste AA, foco visível (`ring-accent`), alvos ≥32px,
  teclado completo, `aria-label` em ícones e grupos, `alt` obrigatório em
  imagens, `prefers-reduced-motion` respeitado.
- **Copy**: título e rótulos curtos em pt-BR, sentence case, sem ponto final em
  botões, sem emojis decorativos, sem repetir o que o Markdown já diz.
- **Nos layouts Code e Agentes**: o bloco renderiza inline no transcript (mesmo
  renderer); use para evidência estruturada (testes, métricas, comparação,
  achados) e próximos passos, sem repetir o card de arquivos alterados nem o
  diff do painel Alterações. Decisões bloqueantes usam `ask_user`; o plano é
  Markdown no card de plano.
