# Computer use — contrato

> Estado: backend local Windows + Docker gráfico. Aprovação por ação com
> screenshot, auditoria durável, rate limit, banner de controle e screenshot
> enviado a modelos com visão. Sem automação de mouse/teclado sem consentimento.

## Capabilities

`AgentCapabilities`:

- `computerUse` — screenshot + clique/teclado;
- `screenCapture` — somente leitura (screenshot/window list/UI tree);
- `browserUse` — navegador Chromium/Edge isolado por conversa, controlado por CDP;
- `dockerExecution` — necessária para override de imagem Docker por agente.

Todas começam `false` e só removem acesso. As tools só entram no catálogo do
turno quando a capability correspondente está ligada.

## Tools (perfil Code)

| Tool | Aprovação | Efeito |
| --- | --- | --- |
| `computer_screenshot` | não (leitura) | PNG em `<app-data>/computer/<conversa>/`, dimensões e imagem para modelos com visão |
| `computer_windows` | não (leitura) | lista id/título/app das janelas |
| `computer_ui_tree` | não (leitura) | árvore de acessibilidade (nome/tipo/bounds/id) |
| `computer_click` | fora do Autônomo | move + clique esquerdo/direito/meio |
| `computer_type` | fora do Autônomo | digita no foco; aprovação mostra só o tamanho |
| `computer_key` | fora do Autônomo | combinação de teclas |
| `computer_focus` | fora do Autônomo | foca uma janela por id |
| `browser_open` | fora do Autônomo | abre http(s) no navegador padrão (local) ou Chromium (Docker); a página é operada pelas tools acima |

`RiskClass::Computer` gera `Ask` fora do modo Autônomo; no Autônomo a ação roda
direto. O card usa
`ApprovalDetail::ComputerAction` com ação, alvo, coordenadas/URL, tamanho do
texto (nunca o texto) e screenshot do alvo via
`computer_screenshot_preview`. As opções são **Permitir uma vez** e **Negar**;
não há grant persistente. Sem canal de aprovação a tool falha fechada
(`APPROVAL_UNAVAILABLE`).

## Auditoria e limites

- `computer_sessions` e `computer_actions` registram backend, conversa, agente,
  turno, tool, alvo (coordenadas/URL/tamanho), decisão, resultado e erro.
- Nunca gravam texto digitado, bytes de screenshot ou segredo; a prévia lê o
  arquivo em `<app-data>/computer` e o renderer só recebe um data URL validado.
- `computer_max_actions_per_turn` (default 20) e
  `computer_max_actions_per_hour` (default 120) falham antes da aprovação com
  `COMPUTER_RATE_LIMIT`.
- A primeira ação abre a sessão; o fim do turno (`done`/erro/cancelamento)
  encerra a sessão. Comandos: `list_computer_actions`,
  `list_computer_sessions`, `list_active_computer_sessions`,
  `stop_computer_session`, `stop_all_computer_sessions`.
- Enquanto há sessão ativa, o topbar da thread do agente mostra o aviso
  compacto e **Parar** para aquela conversa. Fora do topbar (outros layouts ou
  sessões em outras threads), `ComputerControlBanner` continua como fail-safe,
  mostrando agente/thread/backend e **Parar tudo** (encerra as sessões e os
  turnos).

## Backends

### Local (Windows)

- Screenshot via `System.Drawing`/`System.Windows.Forms` (virtual screen).
- Input via `user32` `SetCursorPos`/`mouse_event` e `SendKeys`.
- Janelas via `Get-Process`; foco via `WScript.Shell.AppActivate`.
- UI tree via UI Automation (`UIAutomationClient`).
- Requer um workspace confiável no runtime (pasta escolhida pelo usuário ou
  pasta interna criada pelo aplicativo por conversa).

### Docker

- Imagem padrão publicada em `ghcr.io/hyska-software/zylara-computer:latest`
  (workflow `computer-image.yml`); também funciona uma imagem local de
  `docker/computer/` (Xvfb + openbox + Chromium + xdotool + scrot + RFB).
  O app oferece **Baixar imagem** em Configurações → Agentes → Desktop privado e
  no erro do painel Tela; não faz pull automático.
- Motor parado não é erro de imagem: antes de baixar/validar a imagem e antes do
  `docker run` do desktop, o backend confere o engine e, se o Docker Desktop
  estiver instalado, abre o app e espera até 120 s pelo daemon (`workspace::docker`).
  A UI também expõe **Iniciar Docker** com o código `DOCKER_DAEMON_UNAVAILABLE`.
- Container `<computerDockerContainer>-<conversationId>` iniciado no primeiro
  screenshot, com `--cap-drop ALL`, `no-new-privileges`, limites e
  `--network none`.
- Visualização e controle usam RFB integrado ao painel. Dois servidores escutam
  apenas no loopback do container: um é somente leitura e outro aceita entrada.
  Uma ponte WebSocket em loopback, com token aleatório de uso único, encaminha
  os bytes via `docker exec`/`socat`. Nenhuma porta gráfica do container é
  publicada no host e o fluxo também funciona com rede Docker desligada.
- O agente executa `scrot`/`xdotool`/`wmctrl` via `docker exec`.

## Imagens para o modelo

- `computer_screenshot` devolve até 2 imagens por turno em `ToolOutcome.images`.
- O harness redimensiona para 1280 px e grava JPEG em
  `<app-data>/tool-images/<uuid>.jpg`; o DB guarda **somente caminho/metadados**.
- Modelos com visão recebem a imagem no resultado da tool (Anthropic:
  `tool_result` com blocos `image`; Responses: `function_call_output` com
  `input_image`; Google: `inlineData`; Chat Completions: mensagem `user`
  rotulada após o resultado). Modelos sem visão recebem só o texto/UI tree.
- A imagem entra no orçamento de contexto e não é congelada no prompt.

### Navegador CDP

`browser_open` abre uma sessão **local** de Chromium/Edge em modo **headless**
(perfil isolado por conversa, porta CDP aleatória em loopback). O navegador não
abre nenhuma janela do sistema: a página é desenhada pelo screencast CDP dentro
da aba **Navegador** do painel do agente, que também fornece abas, barra de
endereço e o controle humano. As tools de página são:

| Tool | Aprovação | Efeito |
| --- | --- | --- |
| `browser_open` / `browser_navigate` | fora do Autônomo | navega no navegador controlado |
| `browser_snapshot` | não | URL/título, árvore de acessibilidade com refs `e1…` e screenshot |
| `browser_click` / `browser_type` / `browser_press` | fora do Autônomo | interage por ref/tecla; o card de `type` mostra só o tamanho |
| `browser_extract` | não | texto visível da página (script fixo, limite de 30k chars) |
| `browser_tabs` | não | lista abas |
| `browser_wait` | não | espera 50–5000 ms |
| `browser_download` | fora do Autônomo | clica no ref e espera o arquivo na pasta de downloads |

Segurança do navegador:

- apenas `http`/`https`; bloqueia `file://`, `chrome://`, `devtools://` e
  `javascript:`;
- perfil e downloads fora do perfil pessoal do usuário;
- sem `Runtime.evaluate` controlado pelo modelo (apenas scripts fixos);
- página nunca compartilha origem com o WebView do app;
- Docker gráfico continua sendo operado por screenshot/xdotool nesta fase.
- As tools de desktop/navegador são do **perfil Code**: o agente precisa ter um
  workspace no runtime para receber o catálogo e o canal de aprovação. Quando
  não há pasta vinculada, o aplicativo cria uma pasta interna por conversa;
  isso não dispensa capabilities, políticas ou aprovação para ações.

- O painel e `browser_open` resolvem a mesma pasta de downloads da conversa:
  `<workspace>/downloads`, inclusive quando o workspace é interno. A troca de
  pasta atualiza a sessão existente antes de confirmar a alteração. Se o destino
  não puder ser confirmado, a sessão é encerrada e a troca não é salva, pois
  uma resposta perdida pode ter aplicado a alteração mesmo após um erro.

## Painel do agente (sidebar direita)

O layout Agentes ganhou um painel dockable/overlay com abas **Tela**,
**Rotinas**, **Navegador** e **Dados** (`AgentPanel`). O painel de ferramentas do
workspace (`CodePanel`) continua separado: as duas superfícies alternam no mesmo
dock.

- **Tela** usa fluxo RFB no desktop privado e captura local contínua no Windows;
  `computer_preview` continua disponível para captura inicial e fallback.
  Os controles da interface permitem assumir, devolver e expandir a visualização.
  No Windows o usuário interage diretamente com o computador físico, não com a
  imagem espelhada.
- **Rotinas** lista/cria/executa e mostra `agent_routine_runs`.
- **Navegador** usa screencast CDP e encaminha eventos de mouse e teclado pelo
  painel quando o usuário assume; o backend valida o controle antes de cada input.
  Teclas e botões potencialmente pressionados são mantidos em memória por aba,
  inclusive quando a resposta CDP se perde. Ao devolver o controle, o backend
  aguarda os eventos de soltura sob o bloqueio da conversa; se falharem, o
  controle permanece com o usuário. Fechar uma aba pelo painel também exige a
  limpeza prévia. O registro não é persistido nem guarda o campo de texto CDP.
  Cada tomada de controle tem uma geração emitida pelo backend; eventos de
  teclado, mouse, inserção de texto, navegação, gestão de abas e pedidos de
  devolução usam a geração que
  tinham ao entrar na fila. Após devolver e assumir novamente, eventos antigos
  são recusados, inclusive se chegarem atrasados pelo IPC. Se o processo do
  navegador for reaberto durante a mesma posse, a geração também muda.
- **Dados** mostra identidade/modelo/capabilities, uso, memória, tarefas, fila e
  auditoria.

Ambiente por agente (`agents.computer_environment`):

```text
auto | private_desktop | this_computer | browser | off
```

`auto` segue `executionEnvironment`; `private_desktop` força Docker;
`this_computer` força Windows local; `browser` remove as tools de desktop;
`off` remove computador e navegador. “Desktop na nuvem” aparece desabilitado como
**Em breve** (local-first).

## Auditoria antes da ação (gateway)

Toda tool de computador/navegador passa por `tools::code::computer::run`, que:

1. aplica capability, ambiente, pausa e rate limit;
2. grava uma linha `pending` em `computer_actions` **antes** de executar;
3. executa a ação;
4. fecha a linha com `result`, decisão, erro, duração e `ended_at`.

Se o processo morrer no meio, o boot marca `pending` como `interrupted`. A linha
também guarda `policy_rule` (`computer.risk`) e `initiator` (`human`/`goal_round`).
Nunca grava texto digitado, clipboard ou bytes de screenshot.

## Isolamento do desktop gráfico

O container Docker é **por conversa**:

```text
<computerDockerContainer>-<conversationId>
```

Dois agentes/threads nunca compartilham o mesmo Xvfb, clipboard ou Chromium. Cada
container tem label `zylara.owner=zylara`, não publica portas gráficas no host e é
removido no Stop da sessão, no cleanup de boot e no `docker_cleanup`.

## Actions de desktop

Além de screenshot/click/type/key/focus/windows/UI tree:

- `computer_drag` — arrastar entre coordenadas;
- `computer_scroll` — roda do mouse em uma coordenada;
- `computer_move` — mover ponteiro sem clicar;
- `computer_wait` — espera 50–5000 ms;
- `computer_clipboard` — read/write com aprovação; write mostra só o tamanho.

`computer_clipboard` e `computer_drag`/`scroll`/`move` também passam pela denylist
de título e pela política de apps.

## Política de apps e hosts

Settings:

- `computerAllowedApps` / `computerBlockedApps` — allow/deny por processo ou
  título; denylist vence e é aplicada antes de qualquer input.
- `browserAllowedDomains` / `browserBlockedDomains` — hosts/sufixos; denylist
  vence. Allowlist vazia libera hosts públicos.
- `browserAllowPrivateHosts` — localhost/RFC1918; default ligado para dev local.
- metadata de nuvem (`169.254.169.254`, `metadata.google.internal`) é sempre
  bloqueada.
- `computerAllowUnattendedBrowser` — permite browser em rotinas/tarefas sem card
  de aprovação; desktop continua fail-closed.

## Takeover interativo no painel

O painel Navegador, quando “Assumir o controle” está ativo:

- ponteiro, roda e teclas são encaminhados ao CDP após conversão do letterbox;
- o agente fica pausado no backend e só volta com “Devolver ao agente”;
- eventos usam `Input.dispatchMouseEvent` e `Input.dispatchKeyEvent`, não
  `element.click()`/`value=`. A interação por IME e a fidelidade de alguns atalhos
  dependem do WebView e ainda precisam de validação específica.

A troca de controle é serializada por conversa e identifica o alvo (desktop ou
navegador), impedindo que um takeover de uma superfície autorize entrada na outra.
A posse do desktop físico também bloqueia automação local e de navegador de
outras conversas, pois todas compartilham o mesmo Windows.

Para pedir ajuda em login, CAPTCHA ou outro bloqueio, o agente pode usar
`ask_user` com o campo `header` igual a `computer_desktop` ou `computer_browser`
e oferecer uma opção de conclusão. No layout Agentes, o card abre a aba
correspondente; isso **não** concede controle nem responde à pergunta. O usuário
deve assumir e devolver o controle no painel e depois responder ao card. Nesses
pedidos, o campo de texto livre fica desabilitado para evitar envio acidental de
credenciais pela resposta estruturada.
A solicitação bloqueia novas
ações e cancela uma aprovação pendente; a transferência só é confirmada depois
da ação em curso terminar. A liberação invalida o canal interativo. Com a conexão
perdida ou após reiniciar, o agente não retoma automaticamente: o usuário deve
assumir e devolver o controle explicitamente. Após a devolução, a primeira ação
do agente deve observar o ambiente com `computer_screenshot` ou `browser_snapshot`.
As transferências são auditadas sem
registrar teclas, texto, clipboard ou frames.

## Limites de segurança

- 4.000 caracteres por `computer_type`; 80 por combinação de tecla.
- Aprovação por ação; não há grant automático persistente nesta versão.
- Denylist conservadora de títulos (gerenciadores de senha, bancos, UAC,
  “senha”, “credential”): input/foco falha fechado
  (`COMPUTER_SENSITIVE_WINDOW`). A lista é heurística e não substitui a revisão
  humana da aprovação.
- O navegador CDP é um processo local com perfil isolado por conversa; a política
  de hosts não deve ser confundida com um firewall completo de rede.
- macOS/Linux local ainda não implementados.

## Testes

- `computer::tests` (backend por settings, escape de SendKeys).
- `policy::tests::computer_control_asks_outside_autonomous_and_is_allowed_inside_it`.
- `db::tests::computer_audit_records_actions_without_text_and_counts_limits`.
- `harness::tests::tool_screenshots_are_persisted_as_paths_and_replayed_only_for_vision_models`.
- `providers::*::tests` (blocos de imagem por protocolo).
- `computer::browser::tests` (URL http/https, perfil sanitizado, refs CDP,
  allow/deny de hosts/private/metadata e transferência com servidor CDP
  simulado, incluindo respostas perdidas e concorrência).
- `computer::tests::graphical_container_is_isolated_per_conversation` e
  `screenshot_retention_removes_old_files_and_empty_dirs`.
- `db::tests::computer_audit_pending_action_is_finished_or_interrupted`.
- Integração real CDP (ignorada por padrão):
  `cargo test --lib local_cdp_browser_navigates_snapshots_and_types -- --ignored`.
- Integração real (ignorada por padrão):
  `cargo test --lib docker_graphical_backend_screenshot_and_click -- --ignored`
  após `docker build -t zylara/computer:test docker/computer`. O teste sobe o
  container, captura 1440×900, clica e remove o container.
- Ponte RFB e transferência real do backend (ignorado por padrão):
  `cargo test --lib rfb_input_is_cleared_on_disconnect_and_control_revocation -- --ignored --nocapture`.
  Com a mesma imagem local e a rede do container desligada, o teste envia tecla
  e botão por RFB, retém temporariamente a limpeza no container descartável e
  verifica que a ferramenta do agente falha fechada até a devolução concluir.
  Ele também verifica a observação obrigatória e a invalidação da conexão antiga;
  não cobre a interface Tauri/noVNC de ponta a ponta.
