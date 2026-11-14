# Docker de execução — contrato

> Estado: execução local/Docker para `run_command`/`run_checks`/jobs, `run_code`
> e terminal interativo; hardening de container, imagem gráfica separada,
> override de imagem por agente e comandos de status/validação/cleanup.

## Settings

- `executionEnvironment`: `local` (default) ou `docker`;
- `dockerImage`: imagem dos comandos (default `node:22-bookworm`);
- `dockerNetwork`: rede do container (default `false`);
- `dockerMemoryMb` (256–16384, default 2048), `dockerCpus` (0.25–16, default 2)
  e `dockerPidsLimit` (32–4096, default 256);
- `dockerReadOnlyRoot` (default `true`; `/workspace` e `/tmp` continuam
  graváveis);
- `computerDockerImage` / `computerDockerContainer`: computer use gráfico. O
  default é a imagem publicada `ghcr.io/hyska-software/zylara-computer:latest`
  (publicada pelo workflow `computer-image.yml`). O app não faz pull
  automático: a UI oferece **Baixar imagem** em Configurações → Agentes e
  no estado de erro do painel Tela. Também aceita uma imagem local construída
  com `docker build -t zylara/computer:latest docker/computer`. O nome
  configurado é um **prefixo**; cada conversa usa
  `<nome>-<conversationId>`, sem porta gráfica publicada; a interface usa uma
  ponte local de uso único por `docker exec`;
- `browserAllowedDomains` / `browserBlockedDomains` /
  `browserAllowPrivateHosts`: política de hosts do navegador;
- `computerAllowedApps` / `computerBlockedApps`: allow/deny de apps desktop;
- `computerAllowUnattendedBrowser`: navegador em rotinas sem card (desktop
  continua fail-closed);
- limites de concorrência/orçamento em `maxConcurrentTurns`,
  `maxConcurrentTurnsPerAgent`, `maxQueueLengthPerThread`,
  `agentDailyCostLimitUsd`.

## Comandos (`run_command`/`run_checks`/jobs)

Quando `executionEnvironment=docker`, `workspace::exec::docker_shell_for` monta:

```text
docker run --rm --init -i
  --cap-drop ALL
  --security-opt no-new-privileges
  --label zylara.owner=zylara
  --pids-limit <dockerPidsLimit>
  --memory <dockerMemoryMb>m
  --cpus <dockerCpus>
  --user 1000:1000
  --tmpfs /tmp:rw,exec,nosuid,size=512m
  [--read-only]
  --mount type=bind,source=<workspace>,target=/workspace
  --workdir /workspace/<subdir>
  [--network none]
  <image> sh -lc <command>
```

Nunca monta home, `/`, socket do Docker ou credenciais. O output continua
passando por timeout/cancelamento/spill do runner.

## `run_code` em Docker

- O workspace temporário de `run_code` é montado em `/workspace`; o script roda
  com `python -u` ou `node` dentro da imagem.
- O container recebe `--network none`, `--cap-drop ALL`,
  `no-new-privileges`, limites de CPU/memória/pids, rootfs read-only (quando
  configurado) e `--tmpfs /tmp`.
- Timeout/cancelamento forçam `docker rm -f` do container além de matar o CLI.
- Artefatos continuam sendo coletados do workspace mesmo em falha/timeout.
- Integração real (ignorada por padrão):
  `cargo test --lib docker_mode_runs_node_and_collects_artifacts -- --ignored`
  com a imagem `node:24-bookworm-slim` presente.

## Terminal do painel em Docker

- `open_terminal` lê `Settings`; no modo Docker o PTY roda
  `docker run --rm -it` com o workspace da conversa em `/workspace`.
- O shell tenta `bash` e cai para `sh`; variáveis sensíveis do app não entram no
  container.
- Fechar/encerrar a aba mata o processo e remove o container (`docker rm -f`).
- Não há noVNC nem portas publicadas para o terminal.

## Perfil por agente

- `agents.docker_image` (opcional, ≤200 chars) só é aplicado quando
  `AgentCapabilities.dockerExecution=true`.
- O harness troca `executionEnvironment` para `docker` e usa a imagem do agente
  no turno; sem imagem explícita, herda o setting global.
- A UI do editor do agente desabilita o campo sem a capability.

## Imagens

- Comandos/terminal: `docker/agent` (Node 22 + Python 3 + git/rg/jq +
  build-essential) ou qualquer imagem com `sh`/`bash`; a imagem precisa existir
  no daemon.
- `run_code`: Python precisa de uma imagem com `python`; JavaScript, `node`.
- Computer use: `ghcr.io/hyska-software/zylara-computer:latest` (publicada
  pelo workflow `.github/workflows/computer-image.yml`, multi-arquitetura) ou
  `docker/computer/Dockerfile` (Xvfb + openbox + Chromium + xdotool + scrot +
  RFB) para build local. O pacote do GHCR precisa estar público para o pull
  anônimo; imagens privadas exigem `docker login ghcr.io`.
- Produção: pinar `image@sha256:...`; o validador mostra id/arquitetura e roda um
  smoke test com `--entrypoint /bin/sh` (a imagem gráfica inicia o desktop no
  entrypoint e não termina sozinha).

## Comandos Tauri

- `docker_status` — daemon, versão, imagens;
- `docker_pull_image` — pull explícito com timeout; antes do pull o backend
  garante o engine (abre o Docker Desktop e espera até 120 s) e devolve
  `DOCKER_DAEMON_UNAVAILABLE`/`DOCKER_DAEMON_START_TIMEOUT`/
  `DOCKER_DAEMON_LAUNCH_FAILED` quando o problema é o daemon, não a imagem;
- `docker_start_daemon` — ação explícita da UI para abrir o Docker Desktop e
  aguardar o engine (`{ running, started, serverVersion }`);
- `docker_validate_image` — inspect + smoke run (mesma checagem de daemon). O
  smoke roda com `--entrypoint /bin/sh` e procura o marcador `zylara-smoke-ok`
  no stdout: a imagem gráfica não termina sozinha, então `docker run <imagem> sh
  -lc true` ficaria bloqueado até o timeout de 60 s;
- `docker_cleanup` — remove containers com label `zylara.owner=zylara`.
- No boot, o app encerra sessões de computer use órfãs e remove containers
  Zylara deixados pelo processo anterior. A limpeza não roda periodicamente para
  não matar terminais/`run_code` legítimos em execução.

## Testes

- `workspace::exec::tests::docker_shell_mounts_the_workspace_and_disables_network_by_default`
  cobre mount/workdir/rede/hardening/flags.
- `config::tests::execution_environment_and_docker_image_are_normalized` cobre
  memória/CPU/pids.
- `terminal::tests::docker_terminal_uses_hardened_container_flags`.
- Integração real com daemon é condicional ao ambiente (não roda na suíte
  padrão); `run_code` Docker tem teste `#[ignore]`.

## Limitações atuais

- Perfil por workspace e `.devcontainer`/compose ainda não implementados.
- `--read-only` pode exigir imagem compatível (caches em `/tmp`/workspace).
- Windows usa Docker Desktop (containers Linux); não há suporte a containers
  Windows. O auto-start do engine só cobre o Docker Desktop (Windows/macOS): no
  Linux o app apenas detecta e orienta a iniciar o daemon.
- Não há pull automático: o download da imagem gráfica é explícito na UI
  (Configurações → Agentes ou erro do painel Tela). O que existe é auto-start do
  engine nessas ações explícitas, nunca no boot.
