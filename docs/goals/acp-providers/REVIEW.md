# REVIEW — Plano de provedores/agentes ACP

> Data: **2026-11-24**.
>
> Resultado final: **READY para implementação**, sem blockers restantes.

## 1. Base da revisão

O plano foi cruzado com:

- documentação oficial ACP v1 e schemas públicos;
- ACP Registry JSON, `registry.schema.json`, `agent.schema.json` e RFD;
- Rust SDK `agent-client-protocol` 5.6.0 e inspeção do código-fonte;
- código real do Zylara (`commands`, `harness`, `providers`, `db`, `state`,
  `workspace`, `policy`, `terminal`, renderer e stores);
- docs de arquitetura, modelos, design, agentes, plugins e arquivos.

Snapshot oficial verificado:

```text
Registry 1.0.0
46 agentes
23 npx · 24 binary · 2 uvx
37 artefatos binários sem sha256
5 agentes binários sem checksum em plataforma alguma
```

## 2. Rodadas de revisão

| Rodada | Veredito | Principais correções incorporadas |
| --- | --- | --- |
| 1 | NOT READY | Dispatcher compartilhado, replay/message map, processo persistente, Windows shim, custo cumulativo, seleção runtime-aware, env persistido, Markdown ACP-safe, duas camadas de permissão e supervisor de sessão |
| 2 | NOT READY | Gate único do workspace, `set_conversation_runtime`, PTY de auth, schema agregado do Registry, pipeline de conteúdo não textual, consentimento backend, direção do cancelamento, budget, limites e acceptance exaustivo |
| 3 | NOT READY | `RuntimeSelection`, sem fork no ACP v1, elicitation completa, roots de subagents, PEP 440, transcript durável, budget para todos os callers, Docker terminal, CAS, paginação e challenge de consentimento |
| 4 | NOT READY | Wire shape Rust↔TS, scopes/operações do challenge, escrita sem leitura prévia, delete histórico, approved roots, IPC bounded e feature `rmcp_3` |
| 5 | **READY** | Revisão focada confirmou os 12 achados finais resolvidos; nenhum blocker restante |

## 3. Matriz final

| Tema | Status | Evidência no plano |
| --- | --- | --- |
| ACP como runtime paralelo, não HTTP provider | ✅ | §1, §D1, §7.1 |
| Registry e instalação binary/npx/uvx | ✅ | §3.1, §8.1–8.2 |
| Autenticação agent/terminal/logout | ✅ | §5.5, §6.3, §8.3 |
| Sessões new/load/resume/close/list/delete | ✅ | §6.3, §8.4 |
| Streaming, tools, uso e erro | ✅ | §6.4, §8.5–8.6 |
| Conteúdo não textual persistente | ✅ | §6.2, §8.6.1 |
| Permissões ACP × política do cliente | ✅ | §8.7–8.8 |
| Filesystem com roots/CAS/journal | ✅ | §8.9 |
| Terminal local endurecido | ✅ | §8.10–8.11 |
| Cancelamento/crash/shutdown | ✅ | §8.8, §8.11 |
| Config, comandos, notices, compaction | ✅ | §8.15 |
| Subagents e mensagens entre sessões | ✅ | §8.15 |
| Custo cumulativo e budget | ✅ | §8.13, §7.1 |
| Chat, Code e Agentes | ✅ | §5, §10 |
| Provedores atuais isolados | ✅ | §2.2, §7, §12.5 |
| Testes e não regressão | ✅ | §12 |
| Rollout/rollback | ✅ | §17 |

## 4. Baseline de verificação

| Comando | Resultado |
| --- | --- |
| `pnpm typecheck` | Passou |
| `cargo check` | Passou com 205 warnings preexistentes |
| `cargo test --lib` | 1688 passed; 0 failed; 22 ignored |
| Vitest completo | 3288 passed; 8 preexisting failures; 4 arquivos |
| `git diff --check` nos documentos ACP | Sem erros de whitespace |
| Code fences do `PLAN.md` | 32, balanceados |

As 8 falhas Vitest preexistentes estão listadas em `RESEARCH.md` e devem ser
corrigidas ou explicitamente aceitas antes da implementação. A entrega ACP não
pode aumentar esse conjunto.

## 5. Decisões residuais não bloqueantes

- ACP v2 está em Preview e fica para follow-up; a entrega usa v1 estável.
- Transporte remoto ACP e sandbox de OS não entram nesta fase.
- O agente externo não é sandboxed; consentimento e aviso são obrigatórios.
- Tarefas ACP/líder de canal e memória durável dependem da Fase 6 MCP.
- A matriz ao vivo com credenciais reais é gate de implementação, não do plano.

## 6. Conclusão

O plano está internamente consistente com o código atual e com os contratos
oficiais consultados. Ele pode ser usado como base de implementação, desde que a
Fase 0 trate o baseline de testes e cada tarefa siga TDD.
