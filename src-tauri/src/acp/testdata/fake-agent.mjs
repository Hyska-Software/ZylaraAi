// Minimal deterministic ACP agent used by the Rust integration tests.
// Speaks JSON-RPC 2.0 over newline-delimited stdin/stdout (ACP stdio transport).
// No network, no filesystem writes, no external dependencies.

import readline from 'node:readline';

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

input.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    fail(null, -32700, 'Parse error');
    return;
  }
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false } },
        authMethods: [],
        agentInfo: { name: 'fake-agent', version: '1.0.0' },
      });
      break;

    case 'session/new':
      reply(id, {
        sessionId: 'sess-test',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'fake-1',
            options: [{ value: 'fake-1', name: 'Fake 1' }],
          },
        ],
      });
      break;

    case 'session/prompt': {
      const text = (params?.prompt ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('');
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-test',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg-1',
            content: { type: 'text', text: `echo:${text}` },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-test',
          update: {
            sessionUpdate: 'usage_update',
            used: 12,
            size: 1000,
            cost: { amount: 0.01, currency: 'USD' },
          },
        },
      });
      reply(id, { stopReason: 'end_turn' });
      break;
    }

    case 'session/set_config_option':
      reply(id, {});
      break;

    case 'session/cancel':
      reply(id, { stopReason: 'cancelled' });
      break;

    case 'session/close':
      reply(id, {});
      break;

    default:
      fail(id, -32601, 'Method not found');
  }
});
