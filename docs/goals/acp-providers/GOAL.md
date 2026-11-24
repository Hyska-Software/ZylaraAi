# GOAL — Suporte completo a agentes ACP

## Pedido

Adicionar suporte completo a provedores/agentes via **Agent Client Protocol**,
além dos provedores atuais, usando a documentação oficial e o **ACP Registry**.

## Restrições

- Integrar completamente com Chat, Code e Agentes.
- Modificar o que for necessário, sem alterar o funcionamento dos provedores
  HTTP atuais.
- Usar o Registry oficial como fonte de descoberta/instalação.
- Entregar primeiro um plano completo, analisado e revisado.

## Critérios de sucesso

1. Registry, instalação, atualização e autenticação de agentes ACP.
2. Sessões ACP persistidas e resumíveis.
3. Streaming, tools, permissões, filesystem, terminal e updates estáveis
   integrados aos eventos e à UI existentes.
4. Cancelamento, crash recovery e shutdown seguros.
5. Nenhuma regressão nos provedores HTTP nem nas rotas nativas.
6. Testes, documentação, i18n e evidência de verificação.

## Fonte oficial

<https://agentclientprotocol.com/get-started/registry>

## Plano

`PLAN.md`

## Pesquisa e baseline

`RESEARCH.md`

## Revisão

`REVIEW.md`
