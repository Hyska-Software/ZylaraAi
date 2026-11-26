# Agentes — contrato do layout, memória, workspace e colaboração

> Este documento descreve o layout **Agentes** (v1.14): personas persistentes,
> memória durável, workspace opcional, fila, rotinas, canais, templates e
> import/export. Ele complementa `docs/ARCHITECTURE.md` (visão técnica),
> `docs/DESIGN.md` (UI/UX) e `docs/goals/code-harness/` (harness de código).

## 1. Layout

O aplicativo tem três layouts, persistidos em `uiStore.layoutMode`:

| Layout | Sessões | Sidebar | Centro |
| --- | --- | --- | --- |
| `chat` | `conversations.mode = 'chat'` | conversas, Biblioteca, Skills | `ChatView` |
| `code` | `mode = 'code'` + sessões do Chat com `code_linked` | workspaces/sessões | workbench de código |
| `agent` | `mode = 'agent'` de uma persona | agentes, canais, threads | home/thread do agente ou canal + `AgentPanel` à direita |

Uma sessão nasce em um layout e não vaza para os outros. A única exceção é
`code_linked` (sessão do Chat adicionada ao Code). Threads de canal têm
`channel_id` e são **ocultas** das listas de agente; elas pertencem ao canal.

Arquivos principais:

- `src-tauri/src/acp/**` — runtime de agentes ACP externos (Registry + subprocesso JSON-RPC);
  uma persona aponta para um agente ACP escolhendo `provider_id = 'acp__<registry-id>'` no
  seletor normal, e a thread registra `conversations.agent_kind = 'acp:<registry-id>'`. O modelo
  do agente é escolhido no **mesmo** seletor do composer — não existe seletor ACP separado
  (detalhes em `docs/goals/acp-providers/PLAN.md` D13).
- `src/components/agents/**` — sidebar, home, editor, memória, rotinas, canais,
  templates e construtor por IA.
- `src/lib/store/agentStore.ts` — catálogo de personas.
- `src/lib/store/messageQueueStore.ts` — fila FIFO de mensagens por conversa
  (localStorage), compartilhada por Chat, Code e Agentes.
- `src-tauri/src/agents/mod.rs` — domínio, validação, prompt, memória, rotinas,
  canais e documento de export.
- `src-tauri/src/commands/agents.rs`, `routines.rs`, `channels.rs` — comandos.
- `src-tauri/src/harness/mod.rs` — composição de prompt/tools, memória volátil,
  runtime de ferramentas de agentes com workspace explícito ou interno.
- `src-tauri/src/tools/memory.rs` — ferramenta `memory` (Chat e Code).
- `src-tauri/src/tools/registry.rs` + `harness/code/tools.rs` — execução das
  tools do perfil Code e fronteira de execução.

## 2. Modelo de dados

### `agents`

Identidade (`name`, `role`, `description`, `avatar_json`, `department`), modelo
(`provider_id`, `model_id`, `reasoning_json`), modelo de reserva opcional
(`fallback_provider_id`, `fallback_model_id`), instruções, `prompt_version`,
starters, `capabilities_json`, `memory_enabled`, `workspace_id`,
`permission_mode`, `docker_image`, pin/ordem e arquivamento.

- `avatar_json` guarda o avatar da persona em três origens: `mascot` (corpo,
  expressão e cor desenhados em SVG; olhos e boca usam uma única cor escolhida
  pelo usuário, Branco ou Preto, sem pupila), `image` (data URL normalizada) e
  `emoji` (avatares legados). O formato é
  `mascot | circle | rounded | square`. O diálogo "Avatar" (clique no avatar da
  home ou menu da sidebar) persiste na hora; a aba Avatar do editor persiste no
  Salvar. Trocar o avatar **não** sobe `prompt_version`.
- Imagens: PNG/JPEG são centro-cortados e redimensionados para 256×256; GIF/WebP
  animados até 512 KB preservam a animação; a entrada aceita até 10 MB.

- `prompt_version` sobe quando um campo que muda o prompt muda (nome, papel,
  descrição, instruções, memória). A snapshot key do Chat/Code inclui
  `agent.id` + `prompt_version`, então editar o prompt causa **exatamente um**
  cache miss e nunca reutiliza o prompt de outra persona.
- `workspace_id` é opcional; sem ele cada conversa usa uma pasta interna própria.
- `permission_mode` é herdado pela conversa criada e pode ser trocado na sessão
  pelo chip do Code.
- O seletor de modelo do composer do layout Agentes edita a rota da persona
  (provedor, modelo e raciocínio). Antes da primeira mensagem ele também
  sincroniza o par congelado da thread vazia; depois disso o modelo da conversa
  fica travado e o segmento ✦ continua ajustando o raciocínio da persona.

### `conversations` — conversa principal

Cada agente tem exatamente uma conversa principal (`conversations.is_main = 1`,
índice único parcial por `agent_id`), criada na mesma transação do agente e
recriada pelo backfill para bancos antigos e pelo `reset`. Ela nasce com
`pinned = 1` e título **Conversa principal**, aparece acima de qualquer thread
fixada no histórico do agente e é o destino de todas as execuções de rotina.
A principal não pode ser desafixada nem excluída isoladamente; é removida junto
com o agente quando não há outras conversas. Cliques no agente continuam abrindo
a home, que oferece um botão dedicado **Conversa principal**. Editar a persona
sincroniza rota/workspace/permissão da principal enquanto ela está vazia; depois
da primeira mensagem vale o congelamento normal de thread. `list_agent_threads`
continua por recência; Sidebar/Home aplicam a ordem principal-first.

### `agent_memories`

Uma linha por memória: `kind` (`fact`/`preference`/`procedure`/`note`),
`content`, origem (`source_conversation_id`), `pinned`, timestamps. Limites:
4 KiB por memória e 200 memórias por agente.

### `agent_routines`

`title`, `prompt`, `schedule_kind` (`interval`/`daily`), `interval_minutes`,
`hour`/`minute`, `enabled`, `conversation_id` (id da conversa principal do
agente), `next_run_at`, `last_run_at`, `last_status` (`queued` incluso),
`last_error`. Execuções aguardam em `agent_routine_queue` (FIFO persistente por
conversa principal, com `source` schedule/event/manual, `scheduled_for`,
`status` pending/running e `error` de recuperação).

### `agent_channels` / `agent_channel_members` / `agent_channel_messages`

Um canal tem nome, membros (até 6) e um histórico cronológico `user`/`agent`;
cada mensagem guarda `attachments` (JSON `[]` nas antigas). Cada membro tem uma
thread privada oculta (`conversations.channel_id`) usada para o turno real.

## 3. Capabilities — aplicadas no backend

`AgentCapabilities` só **remove** acesso:

- `webSearch` → gate de `web_search`;
- `fileAccess` → gate de `create_file`;
- `codeExecution` → gate de `run_code` (além do gate global);
- `delegation` → gate de `delegate_task`/`handoff_task`/`send_message`; as tools
  de dono (`task_list`, `task_get`, `task_wait`, `task_cancel`, `accept_task`,
  `decline_task`, `update_task`, `finish_task`) ficam disponíveis para qualquer
  agente concluir ou encerrar trabalho atribuído;
- `automation` → gate de `routine_list`/`routine_create`/`routine_update`/
  `routine_delete`; `agent_directory` e `agent_usage` são somente leitura e
  ficam disponíveis a qualquer agente;
- `computerUse`/`screenCapture` → gate das tools de computer use;
- `dockerExecution` → permite `agents.docker_image` como override de imagem;
- `skills: null` herda todas; `Some([...])` é allowlist (`Some([])` nega todas);
- `tools: null` herda todas; `Some([...])` é allowlist;
- `mcpServers: null` herda todos os servidores MCP; `Some([...])` é allowlist.

A aplicação acontece em três camadas:

1. **Catálogo**: `tools::definitions` (Chat) e `code_tool_definitions_with_mcp`
   (Code) são filtrados antes do wire e do prompt.
2. **Execução**: `tools::execute` recusa tools fora da allowlist; o Code usa
   `ToolCtx::is_tool_enabled` como fronteira de execução.
3. **Conteúdo**: `list_skills`/`read_skill` escondem skills não autorizadas;
   o catálogo de skills do prompt é filtrado; tools MCP de servidores não
   autorizados não entram no catálogo.

### Tools exclusivas do layout Agentes

Elas não entram no catálogo de uma sessão normal do Chat/Code; o harness resolve
a persona pela conversa, nunca pelo modelo:

- `agent_directory` — roster ativo (id, nome, papel, modelo, capabilities,
  workspace, threads) e canais dos quais o chamador participa. Instruções e
  memórias de outros agentes não são expostas.
- `agent_usage` — uso all-time, uso do dia local, limite diário e saldo.
- `routine_list`/`routine_create`/`routine_update`/`routine_delete` — somente
  com `automation`; o agente só enxerga/altera as próprias rotinas e o backend
  limita 50 rotinas por agente.

As tools de tarefa (`task_wait`, `task_cancel`) são compartilhadas com o layout
Code e descritas em `docs/TASKS.md`.

O renderer nunca envia a allowlist: o harness resolve as capabilities da
persona vinculada à conversa. `TurnOptions` carrega esses campos com
`#[serde(skip)]`.

## 4. Memória durável

- Ativada por `agents.memory_enabled`.
- A ferramenta `memory` (`list`/`save`/`update`/`forget`) grava em
  `agent_memories`. Ela existe no Chat e no Code-profile de agentes; no Code ela
  resolve o agente pela conversa e falha fechado se a memória estiver desligada.
- No início do turno, o harness carrega as memórias e injeta um bloco
  `surface_item kind="memory"` na **cauda volátil** do histórico. Nunca entra no
  system prompt congelado.
- O bloco leva uma revisão monotônica (`agents.memory_revision`) gerada por
  qualquer create/update/delete/clear; uma mudança no conjunto gera um novo
  item mesmo quando a memória apagada era a mais recente. Apenas o item de
  memória mais recente é renderizado (`load_surface_items`), então fatos
  apagados não sobrevivem em blocos antigos. Desligar a memória remove os
  `surface_items` antigos das threads do agente.
- Orçamento de contexto: 8 KiB; memórias fixadas primeiro, depois as mais
  recentes. O agente é instruído a não guardar segredos, credenciais, estado
  transitório ou transcripts.

## 5. Workspace e perfil Code

Threads de agentes usam o runtime de ferramentas do **Code**, inclusive quando
o renderer envia o perfil Chat e a conversa não tem pasta selecionada:

- Sem workspace explícito, o backend cria e reutiliza
  `<app-data>/agent-workspaces/<sha256 do id da conversa>`, sem registrar essa
  pasta como workspace visível no Code. Conversas diferentes usam pastas
  distintas. O prompt identifica a pasta como **Pasta do agente**, informa que
  ela persiste entre turnos e não imprime mais “No workspace is open”.
- Sem uma **pasta de projeto** selecionada, as tools somente leitura
  (`read_file`, `list_dir`, `search_files`, `search_text`) aceitam caminhos
  absolutos em qualquer lugar do PC; o diretório interno serve de base para
  caminhos relativos. Escritas/edições continuam confinadas a essa pasta. Ao
  selecionar um workspace explícito, todas as tools voltam a ficar confinadas
  ao projeto.
- O editor do agente e o cabeçalho da conversa permitem escolher uma pasta sem
  abrir o Code; uma pasta externa precisa estar marcada como confiável. A troca
  da pasta da conversa é recusada enquanto qualquer turno dela estiver ativo.
- A conversa mantém o workspace com que foi criada: mudar o workspace padrão
  da persona depois não altera threads existentes. Selecionar a pasta interna
  novamente não move nem apaga arquivos.
- A conversa herda `workspace_id` e `permission_mode` do agente na criação.
- O prompt do Code recebe o bloco `# Agent profile` (identidade/instruções/
  memória) e a snapshot key inclui `agent.id` + `prompt_version`.
- O layout Agentes usa o perfil Code; a seção de UI generativa do prompt do Code
  vale para threads e canais, e os blocos `ui` renderizam inline. O agente deve
  preferir um bloco `ui` sempre que julgar viável e a resposta tiver dados
  estruturados.
- Com pasta explícita, tools de FS/shell/git/jobs/plano/objetivo/subagente,
  política de aprovação, journal/diff e jobs seguem o Code.
- O layout Agentes mostra o painel Arquivos/Alterações e as abas centrais de
  diff/arquivo/plano/commits/objetivo; aprovações continuam inline.
- A pasta interna não concede `run_command`, `run_checks`, `task` ou MCP.
  Artefatos e `run_code` do Chat continuam disponíveis conforme suas opções e
  capabilities; `run_code` continua sujeito ao opt-in global e não é sandbox.
  Navegador e desktop dependem de suas próprias capabilities e aprovações.

**Computer use local**: o agente pode usar o computador do usuário quando a
capability `computerUse`/`screenCapture` está ligada: screenshot, clique,
teclado, janelas, foco e UI tree, com aprovação por ação fora do Autônomo e auditoria. O
detalhamento (backend Windows/Docker, denylist, rate limit e imagens para
modelos com visão) está em `docs/COMPUTER.md`.

**Execução em Docker**: `Settings.executionEnvironment` (`local` | `docker`)
escolhe onde `run_command`/`run_checks`/jobs, `run_code` e o terminal interativo
rodam. No modo Docker o workspace é montado em `/workspace`, a rede fica
desligada por padrão (`--network none`) e a imagem vem de `dockerImage`
(padrão `node:22-bookworm`) ou de `agents.docker_image` quando a capability
`dockerExecution` está ligada. Limites de CPU/memória/pids/rootfs são
configuráveis. O detalhamento está em `docs/DOCKER.md`.

Permissões: `read_only`, `review`, `edit`, `autonomous`. O chip do composer
troca o modo da sessão; toda mutação passa por `policy::decide`. No Autônomo não
há confirmação de comandos/edições/segredos/computador/MCP; regras explícitas de
negação e o modo Plano continuam valendo.

**Modelo de reserva** (opcional): quando a rota principal não resolve
(provedor/modelo indisponível) ou não tem credencial utilizável, o harness tenta
a rota de reserva antes de persistir o turno. A conversa continua a mesma e o
modo de raciocínio vai como `Auto`, porque o esforço do modelo principal pode
não existir na reserva. Falhas de quota no meio do stream ainda encerram o turno
com erro — o fallback é de rota, não um retry infinito.

## 6. Concorrência e fila (FIFO por thread)

- `chatStore.streamsByConversation` guarda **um stream por conversa** (turno
  ativo). `streaming` é só a fatia visível de `activeId`; trocar de thread
  reata o stream daquela conversa e nunca apaga o de outra. Enquanto existe
  stream local, as mensagens em memória são a fonte da verdade ao reabrir a
  thread: o checkpoint do banco pode estar defasado (ou ser ainda o placeholder
  vazio), então `openConversation` não relê `get_conversation` nesse caso — os
  detalhes de execução (raciocínio/passos/ferramentas) não desaparecem ao trocar
  de conversa.
- Várias threads de agente rodam ao mesmo tempo. O backend aceita **um turno
  por conversa** (`register_if_idle`); o renderer enfileira só a thread ocupada.
- `messageQueueStore` persiste a fila em `localStorage` (`zylara.agent-queue.v1`,
  chave legada) e cada item carrega texto, anexos, rota e `turnOptions`/`goalRequest`.
  O composer oferece **Enfileirar mensagem** (padrão do Enter) em **todos os
  layouts** enquanto há streaming; **Enviar agora** (botão ⚡ e ação do toast)
  enfileira e interrompe o turno atual. O item só sai da fila quando o novo turno
  começa; `settleTurn` reconcilia o snapshot do Code, entrega a preempção, drena
  o FIFO e só então decide a autocontinuação do Goal (`processQueue` antes de
  `maybeContinueGoal`). `cancelled` pausa a fila apenas no Stop (sem preempção).
  As filas persistidas são sanitizadas ao reidratar e retomadas depois do
  `reattachTurns` (`drainMessageQueues`, em qualquer layout).
- Interromper uma rodada do Goal com **Enviar agora** retoma o objetivo depois
  da nova mensagem (a rodada cancelada continua contada). Cancelar um gate
  `submit_plan`/pergunta resolve o gate como cancelado: o plano volta a
  `planning` com o feedback de revisão cancelada e a nova mensagem roda no modo
  Plano. `waitForIdleTurn` espera o backend liberar a conversa antes de iniciar
  o próximo turno (a `cancelled` chega antes do `finish_turn`).
- A sidebar mostra o contador da fila e um spinner por thread/agente que está
  respondendo (lido do mapa, não do stream visível); threads com aprovação
  pendente, pergunta pendente ou último turno com erro exibem um ícone de
  atenção no lugar do horário.
- Ao concluir um turno de agente enquanto o usuário está em outro layout ou
  thread, um toast in-app avisa (respeita `notificationsEnabled`).
- O erro visível (`error`/`errorCode`/`errorHint`) é da thread ativa: uma falha
  em segundo plano não pinta o banner por cima de outra conversa.
- **Sessões paralelas.** Turnos interativos (envio, regenerar, retomar e rodada de
  objetivo via `run_turn`) **não têm limite de slots**: qualquer número de
  conversas roda ao mesmo tempo no mesmo workspace, inclusive várias threads da
  mesma persona. A única barreira é por conversa: `register_turn_if_idle` recusa
  um segundo turno na mesma thread com `TURN_BUSY`, e a fila de mensagens é FIFO
  por conversa. O backend emite `accepted` (e não `queued`) na admissão, então a
  UI nunca mostra espera por slot em turno interativo.
- Escritas concorrentes no mesmo workspace são coordenadas **por operação**
  (`src-tauri/src/workspace/access.rs`): `write_file`/`edit_file` seguram o lock
  da raiz apenas durante ler → validar → gravar → journal, e o mesmo lock cobre
  revert e as mutações de Git (stage/commit/discard). A versão observada de cada
  arquivo é **por conversa**, então duas sessões não autorizam a escrita uma da
  outra: quem chega depois recebe `FS_STALE_VERSION` e relê.
- O backend aplica `ConcurrencyGovernor` apenas nas **execuções não assistidas**:
  `maxConcurrentTurns` global (padrão 10, faixa 1–32) e
  `maxConcurrentTurnsPerAgent` por agente (padrão 1, faixa 1–4) em tarefas,
  canais, inbox e rotinas. Execuções além do limite aguardam com o token de
  cancelamento (Stop/Cancelar libera); conversas não passam por esse gate.
- `agentDailyCostLimitUsd` é aplicado no harness por **dia local** (todas as
  threads do agente) e bloqueia novos turnos com `BUDGET_EXCEEDED`; canais e
  rotinas passam pelo mesmo gate.
- Sidebar tem Stop por thread; o diálogo **Atividade** lista os streams do
  renderer **e** turnos de task/rotina/canal registrados no backend, além de
  aprovações/perguntas e tarefas aguardando o usuário, e oferece “Parar tudo”
  (com `cancel_all_turns`).
- Aprovação/pergunta em thread de fundo gera toast + notificação do SO via
  `notify_desktop`; conclusão/falha de thread não ativa também notifica. O toast
  tem ação **Abrir** e há dedupe de 5 s por conversa/categoria.
- `notificationsApprovals`, `notificationsQuestions`, `notificationsCompletions`,
  `notificationsTasks` e `notificationsDnd` controlam as categorias; DND mantém
  os avisos apenas no diálogo Atividade.
- Cada evento de turno é persistido em `turn_events` com `seq` e espelhado em
  `zylara:turn-event`. Ao recarregar o webview, `reattachTurns()` reconstrói o
  stream ativo sem duplicar mensagens; turnos de outra instância são aplicados
  pelo barramento global. Um turno admitido que ainda não persistiu mensagem
  aparece como `accepted`: não cria bolha nem stream fantasma, mas mantém a
  conversa ocupada (envio enfileira, Stop cancela por id).

## 7. Rotinas

- Página central `AgentRoutinesView` (rodapé da sidebar → **Rotinas** e menu do
  agente → **Rotinas**): calendário **Dia/Semana/Mês** com a agenda prevista
  (passado e futuro), filtro por agente, **Hoje**, seletor de mês/ano e a lista
  **Todas as rotinas**. O menu do agente abre a página já filtrada por ele.
- CRUD no `AgentRoutineEditorDialog` compartilhado (página, aba **Rotinas** do
  painel direito e editor do painel); excluir preserva a conversa principal do
  agente. **Execuções** lista `agent_routine_runs` em diálogo próprio.
- `list_all_agent_routines` alimenta a página; a lista é recarregada no mount,
  no evento `zylara:agent-routine-run`, no foco da janela e no botão de
  recarregar.
- Com a capability `automation`, o próprio agente pode listar, criar, editar e
  excluir rotinas pelas tools `routine_*`; cada agente tem no máximo 50 rotinas
  e só acessa as próprias.
- O agendador roda no Rust enquanto o app está aberto (tick de 30 s). Ele não é
  um serviço de nuvem nem promete execução com o app fechado.
- Cada rotina executa um turno normal na **conversa principal** do agente, com o
  modelo, instruções, memória e workspace dele. O resultado aparece nela. Quando
  a principal já tem um turno ativo, a execução fica `queued` em
  `agent_routine_queue` e um worker a inicia quando a conversa fica livre (FIFO
  por conversa; itens de agentes diferentes podem rodar em paralelo).
- Frequência: intervalo mínimo de 5 min (máx. 7 dias) ou horário diário local.
  Rotinas diárias têm `days_of_week` (bitmask segunda=1 … domingo=64; padrão
  127 = todos os dias); intervalos são contínuos. As tools `routine_create`/
  `routine_update` aceitam `daysOfWeek`.
- Status/erro ficam na rotina; o evento `zylara:agent-routine-run` atualiza a
  lista de conversas e mostra um toast.
- Cada execução grava uma linha em `agent_routine_runs` (status, início/fim,
  erro, conversa); o painel do agente lista esse histórico em **Rotinas →
  Registros de execução**.
- Execuções não assistidas não têm card de aprovação/pergunta: tools que exigem
  interação falham fechado imediatamente (sem esperar o timeout).

## 8. Canais (agentes no mesmo thread)

- Criados na sidebar (Canais → +) com até 6 agentes. A linha do canal mostra
  os avatares dos membros (dois visíveis + chip `+N`) no lugar do ícone `#`.
- Líder opcional (`agent_channels.leader_agent_id`): com líder ativo, **somente
  ele** responde ao post do usuário, sempre primeiro. O líder pode criar tarefas
  para outros membros com `delegate_task` mesmo sem a capability `delegation`
  (o papel concede apenas essa tool, respeitando a allowlist da persona). A
  resposta dele é publicada e as tarefas delegadas rodam depois: o scheduler
  mantém tarefas cuja thread de origem é a do líder em `queued` enquanto o turno
  dele estiver ativo. `task_wait` não entra no catálogo do líder nesse turno.
  Menções `@nome` viram dicas para o líder; sem líder, o roteamento antigo
  (menções ou todos) continua. Arquivar/excluir o líder limpa o campo.
- O schema `agent_channel_messages` guarda `attachments` (JSON com os metadados
  de `AttachmentInfo`; coluna aditiva, mensagens antigas têm `[]`).
- A view do canal espelha o chat padrão dos agentes (mesma coluna, mensagens,
  rolagem inteligente e shell do composer), **sem seletor de modelos**: cada
  membro já tem a própria rota. O header mostra a pilha de avatares dos membros,
  a contagem e os nomes do grupo; `@` navega os membros por teclado e o envio
  segue a preferência `sendKey` do chat. O composer aceita **anexos** pelo botão
  `+`, por `Ctrl+V` (clipboard) e por drag & drop roteado pelo `App.tsx`
  (`zylara:channel-drop`): os chips mostram tipo/tamanho, miniatura de imagens e
  prévia ao clicar; remover o chip apaga o arquivo importado.
- Publicar uma mensagem: Grava a mensagem `user` (texto pode ser vazio quando há
  anexos), e cada membro **mencionado** (ou todos, quando não há
  `@nome`/`@everyone`) executa um turno em sua thread privada oculta. Os anexos
  do post entram no payload do turno (`attachment_ids`): o texto extraído é
  sempre injetado e imagens são enviadas quando o modelo do membro tem visão. O
  histórico compartilhado entra como `surface_item` `kind="channel"` (volátil,
  últimas 24 mensagens/12 KiB, delimitado e marcado como não confiável, com os
  nomes dos anexos de cada mensagem), não como mensagem `user` duplicada. A
  resposta é publicada no canal e um evento `zylara:agent-channel-updated`
  atualiza a view; como os turnos são sequenciais, o segundo agente vê a resposta
  do primeiro.
- Threads de canal são ocultas das listas/paleta (`channelId`), mas preservadas
  ao sair do canal; excluir o canal remove as threads derivadas. A criação da
  thread do membro é serializada para não duplicar histórico em posts
  concorrentes.
- Erros de um agente não derrubam os demais: vêm em `errors` e aparecem no
  painel do canal. Respostas de canal são não assistidas: aprovações/perguntas
  falham fechado em vez de bloquear o canal.

## 9. Templates, construtor e portabilidade

- `src/lib/agentTemplates.ts` contém 8 templates locais (assistente,
  pesquisador, engenheiro, revisor, redator, operações, analista, suporte).
- “Criar com IA” (`suggest_agent`) usa o modelo selecionado para devolver um
  rascunho JSON; o editor abre com o draft e **nada é salvo sem revisão**.
- “Editar com IA” (`revise_agent`) recebe um pedido em linguagem natural,
  devolve um patch JSON, normaliza/valida no backend e abre um diálogo com o
  **diff campo a campo** (antes/depois). Só `name`, `role`, `description`,
  `department`, `instructions`, `starters` e `memoryEnabled` são revisáveis;
  avatar, rota, reserva, workspace, permissões e capabilities continuam no
  editor estruturado. Aplicar chama o mesmo `update_agent` do editor.
- Duplicar agente copia configuração (não conversas nem memórias), incluindo o
  avatar.
- Uso por agente: `get_agent_usage`/`list_agent_usage` agregam `usage_log` por
  `conversations.agent_id` (turnos, tokens de entrada/saída/raciocínio, total,
  custo e última atividade). A Equipe e a home do agente mostram esses números;
  threads de rotina/canal entram no mesmo agregado.
- Exportar gera um documento `zylara-agent` **versão 2** (JSON) com configuração
  + memórias; a importação ainda lê documentos versão 1 convertendo o `emoji`
  antigo em avatar. Importar valida versão, modelo/workspace e recria o agente.
- Arquivar/restaurar/excluir ficam na **Equipe** (página central): cada card
  ativo arquiva; a seção **Arquivados** restaura ou exclui. Excluir um agente
  ativo exige que ele não tenha outras conversas (arquivar preserva o
  histórico); excluir um agente **arquivado** remove permanentemente a persona,
  a conversa principal e todas as demais conversas, com aviso explícito no
  diálogo.
- Skills/tools/MCP e workspace são escolhidos no editor; permissões continuam
  limitadas pelo backend.

## 9.1 Delegação agente↔agente

Contrato completo: `docs/TASKS.md`.

- `agent_tasks` + `agent_task_events`; dono único, brief, aceite, orçamento,
  deadline, lease/version, `origin_conversation_id` e profundidade máxima 2.
- Tools de criação/transferência (capability `delegation`): `delegate_task`,
  `handoff_task`, `send_message`. Tools de dono, sempre disponíveis:
  `task_list`, `task_get`, `task_wait`, `task_cancel`, `accept_task`,
  `decline_task`, `update_task`, `finish_task` (escopo por dono/criador/canal).
- O scheduler Rust roda tarefas a cada 5 s em paralelo sob o governador,
  recupera leases expirados, aplica deadline, cria/reusa thread oculta com
  `task_id`, roda múltiplos turnos com orçamento e publica o resultado no canal.
- Handoff é **imediato**: muda o dono, zera `conversation_id` (o novo dono ganha
  thread própria; a antiga é desvinculada) e o destino pode recusar no primeiro
  turno com `decline_task`. Ao terminar, o resultado é entregue como mensagem
  `system` na conversa de origem; não inicia um turno automático.
- `waiting_input`/`waiting_approval`/`review` param o runner; **Retomar**
  (`resume_agent_task`) devolve a tarefa para a fila. `run_agent_task_now` inicia
  em background e retorna sem bloquear; `cancel_agent_task` encerra o turno real.
- UI: menu do agente → **Tarefas**; botão **Quadro de tarefas** na sidebar com
  colunas (incluindo encerradas), retomar, reatribuir e cancelar; diálogo
  **Atividade** centraliza pendências e turnos de fundo.

## 9.2 Computer use

Contrato completo: `docs/COMPUTER.md`.

- Capabilities `computerUse`, `screenCapture`, `browserUse`.
- Windows local: screenshot, clique, teclado, janelas, foco e árvore de
  acessibilidade; Docker gráfico via `docker/computer/` (Xvfb + noVNC).
- `browserUse` usa o navegador local controlado por CDP (abas, endereço,
  snapshot com refs, click/type, wait, extract e download) em um perfil isolado
  por conversa; apenas http/https. O Chromium/Edge roda headless e a página é
  exibida dentro do painel Navegador, sem janela externa do sistema.
- `RiskClass::Computer` pede aprovação fora do Autônomo; o card
  mostra screenshot/alvo e só oferece permitir uma vez/negar; sem canal de
  aprovação a tool falha fechada.
- Toda ação tem sessão/registro em `computer_sessions`/`computer_actions`, sem
  texto digitado ou bytes de screenshot; rate limit por turno/hora.
- `computer_screenshot` vira imagem para modelos com visão (máx. 2/turno,
  1280 px) e texto/UI tree para modelos sem visão.
- macOS/Linux local ainda não implementados; a denylist de apps sensíveis está
  ativa. O navegador CDP desta fase é local (Windows); no Docker o navegador
  gráfico continua via screenshot/xdotool.

## 9.3 Docker de produção

Contrato completo: `docs/DOCKER.md`.

- `executionEnvironment` local/docker; imagem, rede, CPU, memória, pids e
  rootfs configuráveis; override de imagem por agente com `dockerExecution`.
- `run_command`/`run_checks`/jobs usam `docker run` com workspace em
  `/workspace`, non-root, cap-drop, no-new-privileges, read-only, tmpfs,
  limites e rede off.
- `run_code` e o terminal interativo também rodam em Docker, com cleanup de
  container no timeout/cancelamento/fechamento da aba e label
  `zylara.owner=zylara` para limpeza no boot.
- `docker_status`, `docker_pull_image`, `docker_validate_image`,
  `docker_cleanup`; imagem do computer use é separada.
- Perfil por workspace, compose/devcontainer e containers gráficos por sessão
  ainda não implementados.

## 9.4 Painel direito do agente

- Configurações → **Agentes** reúne as preferências globais do layout:
  concorrência/fila, orçamento diário, notificações de threads, política de
  navegador, apps do desktop e imagem/limites do Desktop privado. Modelo,
  instruções, workspace, permissões e capabilities continuam por persona no
  editor do agente; o composer também oferece a troca rápida de modelo e
  raciocínio (a mesma rota do editor). O chip de cache do composer do Chat e o
  segmento de cache do medidor de contexto do header não aparecem no layout
  Agentes.
- `AgentPanel` é a sidebar direita do layout Agentes, com abas **Tela**,
  **Rotinas**, **Navegador** e **Dados**. Docked acima de 1120 px; overlay com
  backdrop/Escape abaixo disso.
- O `CodePanel` (Arquivos/Alterações/Terminal) continua **separado**: os botões
  do header alternam qual painel ocupa o dock; não há aba "Código" dentro do
  `AgentPanel`.
- Reabertura: o toggle `PanelRight` da sidebar esquerda, do header da thread e do
  canal, e o botão flutuante (`AgentPanelOpener`) das superfícies sem header
  (home e agente arquivado) trazem o painel de volta; recolhê-lo nunca deixa a
  tela sem um controle para reabri-lo.
- Estado em `uiStore` (`agentPanelOpen`, `agentPanelTab`, `agentRightPanel`) e
  largura em `sidePanelWidth`.
- Tela: desktop privado integrado por RFB com modo somente leitura e controle;
  captura local contínua no Windows; `computer_preview` é captura inicial sem
  modelo/DB. `computer_take_control`/`release_computer_control` serializam a
  transferência e a pausa bloqueia tools no backend (`COMPUTER_PAUSED`).
- Toda ação grava `computer_actions` como `pending` antes de executar e fecha em
  `ok`/`error`; boot marca pendentes como `interrupted`.
- Container gráfico por conversa (não global), sem porta gráfica publicada;
  a ponte local usa token de uso único e `docker exec`, inclusive sem rede no
  container. Cleanup no Stop/boot.
- Ações CUA: drag, scroll, move, wait e clipboard read/write.
- Política de apps (`computerAllowedApps`/`BlockedApps`) e hosts
  (`browserAllowedDomains`/`BlockedDomains`, private hosts e metadata).
- Navegador: clique/digitação reais via `Input.dispatchMouseEvent`/
  `Input.insertText`, scroll/hover/select/upload e takeover interativo no
  preview (clique + teclado quando o humano assume).
- `computerAllowUnattendedBrowser` permite navegador em rotinas sem card;
  desktop continua fail-closed.
- Rotinas/Tarefas: execuções em `agent_routine_runs`; navegador não assistido é
  opt-in e continua sujeito à política de hosts.
- Ambiente por agente em `agents.computer_environment` (`auto`,
  `private_desktop`, `this_computer`, `browser`, `off`). “Desktop na nuvem” fica
  desabilitado como **Em breve**.
- Navegador: sessão CDP local, abas/endereço/voltar/avançar/reload, frame ao
  vivo, “Assumir o controle” e encerramento. Downloads vão para
  `<workspace>/downloads` (ou pasta do app).
- Dados: identidade/modelo/capabilities, uso, memória, tarefas, fila, conversa e
  auditoria recente de computer use.

## 10. Cache e segurança

- O prompt do agente é congelado por sessão; a memória e o estado de rotina/
  canal entram como `surface_items` voláteis.
- Mudanças de capabilities alteram o catálogo de tools e, portanto, o
  `tools_hash`/snapshot key.
- Instruções do agente são configuração, não autorização; o prompt base de
  segurança vem antes.
- A allowlist de tools/skills/MCP é aplicada no backend; o renderer não é
  autoridade.
- Segredos nunca entram na memória ou no workspace do agente. O agente de Code
  continua sujeito ao confinamento de path, journal e aprovação.

## 11. Verificação

- `pnpm typecheck`
- `pnpm test`
- `cd src-tauri && cargo test --lib` (ou filtros `agent`, `memory`)
- `cd src-tauri && cargo check`

Testes específicos deste contrato:

- `src/lib/store/__tests__/messageQueueStore.test.ts`
- `src/components/chat/MessageQueueBar.test.tsx`
- `src/lib/__tests__/chatStore.test.ts` (streams simultâneos, fila em segundo
  plano, Enviar agora e notificações)
- `src/components/agents/AgentSidebar.test.tsx`
- `src/components/agents/AgentMemoryPanel.test.tsx`
- `src/components/agents/AgentRevisionDialog.test.tsx`
- `src/components/agents/TeamView.test.tsx`
- `src-tauri/src/agents/mod.rs` (prompt, memória, rotinas, capabilities,
  export, fallback e revisão)
- `src-tauri/src/db.rs` (CRUD de agente, threads, canais, rotinas)
- `src-tauri/src/tools/memory.rs` e `src-tauri/src/tools/mod.rs` (allowlist)
- `src-tauri/src/workspace/exec.rs` (argv/hardening do Docker)
- `src/components/settings/ToolsTab.test.tsx` (ambiente Docker)
- `src-tauri/src/concurrency.rs` (governador global/por agente)
- `src-tauri/src/tools/tasks.rs` (delegação/ownership/handoff pendente)
- `src-tauri/src/db.rs` (conversa principal/backfill, fila de rotinas; tarefas:
  claim/transições/handoff/lease; auditoria de computer use; `turn_events`)
- `src-tauri/src/commands/tasks.rs` (runner multi-turno/cancelamento/heartbeat)
- `src-tauri/src/commands/turn.rs` (eventos persistidos/reattach)
- `src-tauri/src/computer/mod.rs` (backend local/Docker e ambiente por agente)
- `src-tauri/src/computer/browser.rs` (CDP local, URL policy, perfil/refs)
- `src-tauri/src/commands/routines.rs` (runs/logs de rotina)
- `src-tauri/src/tools/code/computer.rs` (browser tools/auditoria)
- `src-tauri/src/tools/code_exec.rs` (`run_code` Docker, teste `#[ignore]`)
- `src-tauri/src/terminal/mod.rs` (terminal Docker hardening)
- `src-tauri/src/harness/mod.rs` (imagens de tool para modelos com visão)
- `src/lib/__tests__/chatStore.test.ts` (reattach e notificações)
- `src/components/agents/AgentPanel.test.tsx` (Tela/Navegador)
- `src/components/agents/AgentHome.test.tsx` (conversa principal)
- `src/components/settings/AgentsTab.test.tsx` (concorrência, notificações, navegador e computer use)
- `src/components/agents/AgentTaskBoardDialog.test.tsx`
- `src/components/agents/AgentActivityDialog.test.tsx`
- `docs/TASKS.md`, `docs/COMPUTER.md`, `docs/DOCKER.md`
