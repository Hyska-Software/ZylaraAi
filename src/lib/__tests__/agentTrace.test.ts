import { describe, expect, it } from 'vitest';
import {
  buildAgentResponseBlocks,
  buildAgentTrace,
  buildCompactTurnRows,
  countTraceTools,
  describeCodeTool,
  describeTraceActivity,
  hasTraceReasoning,
  hasTraceText,
  summarizeCompactTurn,
  toolActivityLabel,
  toolFamilyLabel,
  type AgentResponseBlock,
  type AgentTraceEntry,
  type CompactTurnRow,
  type ToolGroup,
} from '@/lib/agentTrace';
import type { ToolCallRecord, TraceStep } from '@/lib/types';

function tool(overrides: Partial<ToolCallRecord> & Pick<ToolCallRecord, 'name'>): ToolCallRecord {
  return {
    id: `tool-${Math.random().toString(36).slice(2, 8)}`,
    arguments: '{}',
    status: 'done',
    result: null,
    ...overrides,
  };
}

function reasoningTexts(entries: AgentTraceEntry[]): string[] {
  return entries
    .filter((entry): entry is { kind: 'reasoning'; text: string } => entry.kind === 'reasoning')
    .map((entry) => entry.text);
}

function toolGroups(entries: AgentTraceEntry[]): ToolGroup[] {
  return entries
    .filter((entry): entry is { kind: 'tools'; group: ToolGroup } => entry.kind === 'tools')
    .map((entry) => entry.group);
}

const SEARCH_RESULTS = JSON.stringify({
  query: 'universidades ia',
  results: [
    { title: 'MIT', url: 'https://www.mit.edu/ia' },
    { title: 'USP', url: 'https://usp.br/ia' },
    { title: 'MIT admissions', url: 'https://www.mit.edu/ia' },
  ],
});

describe('buildAgentTrace', () => {
  it('interleaves reasoning and tool groups following the persisted trace', () => {
    const trace: TraceStep[] = [
      { reasoning: 'Vou pesquisar faculdades.', toolCalls: 1 },
      { reasoning: 'Agora vou ler as páginas mais relevantes.', toolCalls: 2 },
      { reasoning: 'Tenho o suficiente para responder.', toolCalls: 0 },
    ];
    const tools = [
      tool({ name: 'web_search', result: SEARCH_RESULTS }),
      tool({
        name: 'fetch_url',
        arguments: '{"url":"https://mit.edu/ia"}',
        result: JSON.stringify({ url: 'https://mit.edu/ia', title: 'MIT — IA', content: '…' }),
      }),
      tool({
        name: 'fetch_url',
        arguments: '{"url":"https://usp.br/ia"}',
        result: JSON.stringify({ url: 'https://usp.br/ia', title: 'USP — IA', content: '…' }),
      }),
    ];

    const entries = buildAgentTrace({ reasoning: 'ignorado quando há trace', toolCalls: tools, trace });

    expect(entries.map((entry) => entry.kind)).toEqual([
      'reasoning',
      'tools',
      'reasoning',
      'tools',
      'reasoning',
    ]);
    expect(reasoningTexts(entries)).toEqual([
      'Vou pesquisar faculdades.',
      'Agora vou ler as páginas mais relevantes.',
      'Tenho o suficiente para responder.',
    ]);
    const groups = toolGroups(entries);
    expect(groups[0].name).toBe('web_search');
    expect(groups[0].label).toBe('Encontrou 2 páginas web');
    expect(groups[0].domains).toEqual(['mit.edu', 'usp.br']);
    expect(groups[1].name).toBe('fetch_url');
    expect(groups[1].label).toBe('Leu 2 páginas');
    expect(groups[1].pages.map((page) => page.title)).toEqual(['MIT — IA', 'USP — IA']);
  });

  it('normalizes the subagent type (default explore and general in pt-BR)', () => {
    const explore = describeCodeTool(
      tool({
        name: 'task',
        arguments: JSON.stringify({ description: 'Mapear src', prompt: 'Liste os arquivos' }),
      }),
    );
    expect(explore.verb).toBe('Delegou exploração a um subagente');

    const general = describeCodeTool(
      tool({
        name: 'task',
        arguments: JSON.stringify({
          description: 'Investigar',
          prompt: 'Resuma',
          subagent_type: 'general',
        }),
      }),
    );
    expect(general.verb).toBe('Delegou geral a um subagente');

    const review = describeCodeTool(
      tool({
        name: 'task',
        arguments: JSON.stringify({
          description: 'Revisar',
          prompt: 'Aponte bugs',
          subagent_type: 'review',
        }),
      }),
    );
    expect(review.verb).toBe('Delegou revisão a um subagente');

    const worker = describeCodeTool(
      tool({
        name: 'task',
        arguments: JSON.stringify({
          description: 'Implementar',
          prompt: 'Crie a fatia',
          subagent_type: 'worker',
        }),
      }),
    );
    expect(worker.verb).toBe('Delegou executor a um subagente');
  });

  it('describes the generative UI validation row in the Code timeline', () => {
    expect(describeCodeTool(tool({ name: 'validate_ui' })).verb).toBe(
      'Validou a interface',
    );
    expect(
      describeCodeTool(tool({ name: 'validate_ui', status: 'error' })).verb,
    ).toBe('A validação da interface falhou');
  });

  it('keeps adjacent calls of the same tool in one row and separates different tools', () => {
    const trace: TraceStep[] = [{ reasoning: null, toolCalls: 3 }];
    const tools = [
      tool({ name: 'web_search', summary: '2 resultado(s)', result: null }),
      tool({ name: 'web_search', summary: '3 resultado(s)', result: null }),
      tool({ name: 'fetch_url', arguments: '{"url":"https://a.dev/x"}' }),
    ];

    const entries = buildAgentTrace({ reasoning: null, toolCalls: tools, trace });
    const groups = toolGroups(entries);

    expect(groups).toHaveLength(2);
    // Summary fallback keeps the count even when the result JSON is absent.
    expect(groups[0].label).toBe('Encontrou 5 páginas web');
    expect(groups[0].tools).toHaveLength(2);
    expect(groups[1].label).toBe('Leu 1 página');
    expect(groups[1].pages[0].title).toBe('a.dev');
    expect(countTraceTools(entries)).toBe(3);
    expect(hasTraceReasoning(entries)).toBe(false);
  });

  it('falls back to a single reasoning block when the message has no trace (legacy messages)', () => {
    const tools = [
      tool({ name: 'web_search', result: SEARCH_RESULTS }),
      tool({ name: 'fetch_url', arguments: '{"url":"https://mit.edu/ia"}' }),
    ];
    const reasoning = 'Primeiro pensamento.\n\nSegundo pensamento.';
    const entries = buildAgentTrace({ reasoning, toolCalls: tools });

    // Legacy messages have no step boundaries: the whole raw reasoning is one
    // Markdown block, followed by every tool group.
    expect(reasoningTexts(entries)).toEqual([reasoning]);
    expect(entries.map((entry) => entry.kind)).toEqual(['reasoning', 'tools', 'tools']);
    expect(toolGroups(entries).map((group) => group.name)).toEqual(['web_search', 'fetch_url']);
  });

  it('renders tool calls the trace did not account for instead of hiding them', () => {
    const tools = [tool({ name: 'web_search', result: SEARCH_RESULTS }), tool({ name: 'create_file' })];
    const entries = buildAgentTrace({
      reasoning: null,
      toolCalls: tools,
      trace: [{ reasoning: null, toolCalls: 1 }],
    });

    const groups = toolGroups(entries);
    expect(groups.map((group) => group.name)).toEqual(['web_search', 'create_file']);
  });

  it('describes web searches with and without results', () => {
    const running = buildAgentTrace({
      reasoning: null,
      toolCalls: [tool({ name: 'web_search', status: 'running' })],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(running)[0].label).toBe('Buscando na web…');

    const empty = buildAgentTrace({
      reasoning: null,
      toolCalls: [tool({ name: 'web_search', result: '{"results":[]}', summary: '0 resultados' })],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(empty)[0].label).toBe('Nenhum resultado encontrado');

    const failed = buildAgentTrace({
      reasoning: null,
      toolCalls: [
        tool({ name: 'web_search', status: 'error', result: 'ERROR: a busca web está desativada' }),
      ],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(failed)[0].label).toBe('A busca web falhou');
    expect(toolGroups(failed)[0].errors).toEqual(['a busca web está desativada']);
  });

  it('describes file creation and UI validation rows', () => {
    const entries = buildAgentTrace({
      reasoning: null,
      toolCalls: [
        tool({ name: 'create_file', summary: 'relatorio.md · 1200 bytes' }),
        tool({ name: 'create_file', summary: 'dados.csv · 340 bytes' }),
        tool({ name: 'validate_ui', result: '{"ok":true}' }),
        tool({ name: 'validate_ui', result: '{"ok":true}' }),
      ],
      trace: [{ reasoning: null, toolCalls: 4 }],
    });
    const groups = toolGroups(entries);

    expect(groups[0].label).toBe('Criou 2 arquivos');
    expect(groups[0].files).toEqual(['relatorio.md', 'dados.csv']);
    expect(groups[1].label).toBe('Validou a interface 2 vezes');
  });

  it('uses failure copy for fetch and create-file groups that produced nothing', () => {
    const entries = buildAgentTrace({
      reasoning: null,
      toolCalls: [
        tool({ name: 'fetch_url', status: 'error', result: 'ERROR: HTTP 404', arguments: '{"url":"https://x.dev"}' }),
        tool({ name: 'create_file', status: 'error', result: 'ERROR: sem permissão' }),
      ],
      trace: [
        { reasoning: null, toolCalls: 1 },
        { reasoning: null, toolCalls: 1 },
      ],
    });
    const groups = toolGroups(entries);
    expect(groups[0].label).toBe('Não foi possível ler a página');
    expect(groups[0].errors).toEqual(['HTTP 404']);
    expect(groups[1].label).toBe('Falha ao criar arquivo');
    expect(groups[1].errors).toEqual(['sem permissão']);
  });

  it('groups unknown tools by name', () => {
    const entries = buildAgentTrace({
      reasoning: null,
      toolCalls: [tool({ name: 'minha_ferramenta' })],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(entries)[0].label).toBe('Executou minha ferramenta');
  });

  it('describes code execution rows with a short summary detail', () => {
    const running = buildAgentTrace({
      reasoning: null,
      toolCalls: [tool({ name: 'run_code', status: 'running' })],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(running)[0].label).toBe('Executando código…');

    const done = buildAgentTrace({
      reasoning: null,
      toolCalls: [tool({ name: 'run_code', summary: 'python · 2 arquivos · 1.2s' })],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(done)[0].label).toBe('Executou código · python · 2 arquivos');

    const withoutSummary = buildAgentTrace({
      reasoning: null,
      toolCalls: [tool({ name: 'run_code' })],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(withoutSummary)[0].label).toBe('Executou código');

    const failed = buildAgentTrace({
      reasoning: null,
      toolCalls: [
        tool({
          name: 'run_code',
          status: 'error',
          result: 'ERROR: interpretador python não encontrado',
        }),
      ],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    const failedGroup = toolGroups(failed)[0];
    expect(failedGroup.label).toBe('A execução de código falhou');
    expect(failedGroup.errors).toEqual(['interpretador python não encontrado']);
  });

  it('keeps adjacent code runs in a single row next to a skills listing', () => {
    const entries = buildAgentTrace({
      reasoning: null,
      toolCalls: [
        tool({ name: 'run_code', summary: 'python · 1 arquivo · 0.4s' }),
        tool({ name: 'run_code', summary: 'javascript · 2 arquivos · 0.2s' }),
        tool({ name: 'list_skills', result: '[]' }),
      ],
      trace: [{ reasoning: null, toolCalls: 3 }],
    });
    const groups = toolGroups(entries);

    expect(groups).toHaveLength(2);
    expect(groups[0].tools).toHaveLength(2);
    expect(groups[0].label).toBe('Executou código · javascript · 2 arquivos');
    expect(groups[1].label).toBe('Consultou as skills disponíveis');
  });

  it('describes skills listing and reading rows', () => {
    const listing = buildAgentTrace({
      reasoning: null,
      toolCalls: [tool({ name: 'list_skills', status: 'running' })],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(listing)[0].label).toBe('Consultando skills…');

    const reading = buildAgentTrace({
      reasoning: null,
      toolCalls: [
        tool({ name: 'read_skill', status: 'running', arguments: '{"name":"office-docx"}' }),
      ],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(reading)[0].label).toBe('Lendo skill office-docx…');

    const read = buildAgentTrace({
      reasoning: null,
      toolCalls: [tool({ name: 'read_skill', arguments: '{"name":"office-docx"}' })],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(read)[0].label).toBe('Leu a skill office-docx');
  });

  it('falls back to generic labels when a skill name is missing or invalid', () => {
    const cases: Array<{ arguments: string; status: ToolCallRecord['status']; label: string }> = [
      { arguments: '{}', status: 'done', label: 'Leu uma skill' },
      { arguments: '{oops', status: 'done', label: 'Leu uma skill' },
      { arguments: 'null', status: 'done', label: 'Leu uma skill' },
      { arguments: '"office-docx"', status: 'done', label: 'Leu uma skill' },
      { arguments: '{"name":42}', status: 'running', label: 'Lendo skill…' },
      { arguments: '{"name":"   "}', status: 'done', label: 'Leu uma skill' },
    ];

    for (const testCase of cases) {
      const entries = buildAgentTrace({
        reasoning: null,
        toolCalls: [
          tool({ name: 'read_skill', arguments: testCase.arguments, status: testCase.status }),
        ],
        trace: [{ reasoning: null, toolCalls: 1 }],
      });
      expect(toolGroups(entries)[0].label).toBe(testCase.label);
    }

    const failed = buildAgentTrace({
      reasoning: null,
      toolCalls: [
        tool({
          name: 'read_skill',
          arguments: '{"name":"pdf"}',
          status: 'error',
          result: 'ERROR: skill não encontrada',
        }),
      ],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(failed)[0].label).toBe('Não foi possível ler a skill');
    expect(toolGroups(failed)[0].errors).toEqual(['skill não encontrada']);
  });

  it('describes artifact library searches with and without results', () => {
    const running = buildAgentTrace({
      reasoning: null,
      toolCalls: [tool({ name: 'list_artifacts', status: 'running' })],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(running)[0].label).toBe('Pesquisando nos artefatos…');

    const found = buildAgentTrace({
      reasoning: null,
      toolCalls: [tool({ name: 'list_artifacts', summary: '3 artefatos' })],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(found)[0].label).toBe('Encontrou 3 artefatos');
    expect(toolGroups(found)[0].total).toBe(3);
    expect(toolGroups(found)[0].files).toEqual([]);

    // "3 de 10 artefatos": only the returned count belongs in the label.
    const partial = buildAgentTrace({
      reasoning: null,
      toolCalls: [tool({ name: 'list_artifacts', summary: '3 de 10 artefatos' })],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(partial)[0].label).toBe('Encontrou 3 artefatos');

    const empty = buildAgentTrace({
      reasoning: null,
      toolCalls: [
        tool({ name: 'list_artifacts', summary: 'nenhum artefato' }),
        tool({ name: 'list_artifacts', summary: '0 artefatos' }),
      ],
      trace: [{ reasoning: null, toolCalls: 2 }],
    });
    expect(toolGroups(empty)[0].label).toBe('Nenhum artefato encontrado');

    const withoutSummary = buildAgentTrace({
      reasoning: null,
      toolCalls: [tool({ name: 'list_artifacts', summary: 'ok' })],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(withoutSummary)[0].label).toBe('Consultou os artefatos');

    // Adjacent searches stay in one row and their counts add up.
    const multiple = buildAgentTrace({
      reasoning: null,
      toolCalls: [
        tool({ name: 'list_artifacts', summary: '2 artefatos' }),
        tool({ name: 'list_artifacts', summary: '1 artefato' }),
      ],
      trace: [{ reasoning: null, toolCalls: 2 }],
    });
    expect(toolGroups(multiple)[0].tools).toHaveLength(2);
    expect(toolGroups(multiple)[0].label).toBe('Encontrou 3 artefatos');

    const failed = buildAgentTrace({
      reasoning: null,
      toolCalls: [
        tool({
          name: 'list_artifacts',
          status: 'error',
          result: 'ERROR: falha ao consultar a biblioteca',
        }),
      ],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(failed)[0].label).toBe('A pesquisa nos artefatos falhou');
    expect(toolGroups(failed)[0].errors).toEqual(['falha ao consultar a biblioteca']);
  });

  it('describes artifact reads using the summary name and the arguments fallback', () => {
    const running = buildAgentTrace({
      reasoning: null,
      toolCalls: [
        tool({
          name: 'read_artifact',
          status: 'running',
          summary: 'relatorio.docx · 1.200 caracteres',
        }),
      ],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(running)[0].label).toBe('Lendo o artefato relatorio.docx…');
    expect(toolGroups(running)[0].files).toEqual(['relatorio.docx']);

    const anonymous = buildAgentTrace({
      reasoning: null,
      toolCalls: [tool({ name: 'read_artifact', status: 'running' })],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(anonymous)[0].label).toBe('Lendo um artefato…');

    const read = buildAgentTrace({
      reasoning: null,
      toolCalls: [tool({ name: 'read_artifact', summary: 'relatorio.docx · 1.200 caracteres' })],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(read)[0].label).toBe('Leu o artefato relatorio.docx');
    expect(toolGroups(read)[0].files).toEqual(['relatorio.docx']);

    // `read_artifact` may be called by id only: the name then comes from arguments.
    const byNameArg = buildAgentTrace({
      reasoning: null,
      toolCalls: [tool({ name: 'read_artifact', arguments: '{"name":"dados.csv"}' })],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(byNameArg)[0].label).toBe('Leu o artefato dados.csv');

    const multiple = buildAgentTrace({
      reasoning: null,
      toolCalls: [
        tool({ name: 'read_artifact', summary: 'relatorio.docx · 1.200 caracteres' }),
        tool({ name: 'read_artifact', arguments: '{"name":"dados.csv"}' }),
      ],
      trace: [{ reasoning: null, toolCalls: 2 }],
    });
    expect(toolGroups(multiple)[0].label).toBe('Leu 2 artefatos');
    expect(toolGroups(multiple)[0].files).toEqual(['relatorio.docx', 'dados.csv']);

    const repeated = buildAgentTrace({
      reasoning: null,
      toolCalls: [
        tool({ name: 'read_artifact', arguments: '{"name":"notas.md"}' }),
        tool({ name: 'read_artifact', arguments: '{"name":"notas.md"}' }),
      ],
      trace: [{ reasoning: null, toolCalls: 2 }],
    });
    expect(toolGroups(repeated)[0].label).toBe('Leu o artefato notas.md');
    expect(toolGroups(repeated)[0].files).toEqual(['notas.md']);

    const failed = buildAgentTrace({
      reasoning: null,
      toolCalls: [
        tool({ name: 'read_artifact', status: 'error', result: 'ERROR: arquivo não encontrado' }),
      ],
      trace: [{ reasoning: null, toolCalls: 1 }],
    });
    expect(toolGroups(failed)[0].label).toBe('Não foi possível ler o artefato');
    expect(toolGroups(failed)[0].errors).toEqual(['arquivo não encontrado']);
    expect(toolGroups(failed)[0].files).toEqual([]);
  });

  it('falls back to generic artifact-read copy when the name is missing or invalid', () => {
    const cases: Array<{ arguments: string; status: ToolCallRecord['status']; label: string }> = [
      { arguments: '{}', status: 'done', label: 'Leu um artefato' },
      { arguments: '{oops', status: 'done', label: 'Leu um artefato' },
      { arguments: 'null', status: 'done', label: 'Leu um artefato' },
      { arguments: '"relatorio.docx"', status: 'done', label: 'Leu um artefato' },
      { arguments: '{"name":42}', status: 'running', label: 'Lendo um artefato…' },
      { arguments: '{"name":"   "}', status: 'done', label: 'Leu um artefato' },
      { arguments: '{"name":"dados.csv"}', status: 'running', label: 'Lendo o artefato dados.csv…' },
    ];

    for (const testCase of cases) {
      const entries = buildAgentTrace({
        reasoning: null,
        toolCalls: [
          tool({ name: 'read_artifact', arguments: testCase.arguments, status: testCase.status }),
        ],
        trace: [{ reasoning: null, toolCalls: 1 }],
      });
      expect(toolGroups(entries)[0].label).toBe(testCase.label);
    }
  });
});

describe('buildAgentTrace — Markdown do raciocínio', () => {
  it('emits exactly one raw reasoning entry per trace step (never splits paragraphs)', () => {
    const text = [
      '### Plano',
      '',
      'Vou verificar os arquivos.',
      '',
      '- item um',
      '- item dois',
      '',
      '| coluna | valor |',
      '| --- | --- |',
      '| a | 1 |',
      '',
      'A fórmula $x^2$ explica.',
    ].join('\n');

    const entries = buildAgentTrace({
      reasoning: null,
      toolCalls: [],
      trace: [{ reasoning: text, toolCalls: 0 }],
    });

    // One entry per step, with the raw Markdown — blank lines included.
    expect(entries).toHaveLength(1);
    expect(reasoningTexts(entries)).toEqual([text]);
  });

  it('preserves list markers and indentation instead of flattening bullets', () => {
    const text = '- item um\n- item dois\n  - aninhado\n\n1. passo';

    const entries = buildAgentTrace({
      reasoning: null,
      toolCalls: [],
      trace: [{ reasoning: text, toolCalls: 0 }],
    });

    expect(reasoningTexts(entries)).toEqual([text]);
  });

  it('keeps a fenced block with an internal blank line in the same entry', () => {
    const fence = ['```ts', 'const a = 1;', '', 'const b = 2;', '```', '', 'Depois do bloco.'].join(
      '\n',
    );

    const entries = buildAgentTrace({
      reasoning: null,
      toolCalls: [],
      trace: [{ reasoning: fence, toolCalls: 0 }],
    });

    expect(reasoningTexts(entries)).toEqual([fence]);
  });

  it('keeps heading, list and table together in a single Markdown entry', () => {
    const text = [
      '## Diagnóstico',
      '',
      '- causa provável: cache',
      '- próxima ação: limpar',
      '',
      '| arquivo | status |',
      '| --- | --- |',
      '| cache.ts | revisar |',
    ].join('\n');

    const entries = buildAgentTrace({
      reasoning: null,
      toolCalls: [],
      trace: [{ reasoning: text, toolCalls: 0 }],
    });

    expect(reasoningTexts(entries)).toEqual([text]);
  });

  it('keeps math and GitHub alerts untouched', () => {
    const text = 'Cálculo: $\\sum_{i=1}^{n} i$.\n\n> [!NOTE]\n> Continua como alerta.';

    const entries = buildAgentTrace({
      reasoning: null,
      toolCalls: [],
      trace: [{ reasoning: text, toolCalls: 0 }],
    });

    expect(reasoningTexts(entries)).toEqual([text]);
  });

  it('keeps blank-line separated paragraphs in one entry (only the edges are trimmed)', () => {
    const text = 'Primeiro parágrafo.\n\nSegundo parágrafo.\n\n- lista final';

    const entries = buildAgentTrace({
      reasoning: null,
      toolCalls: [],
      trace: [{ reasoning: `  \n${text}\n  `, toolCalls: 0 }],
    });

    expect(reasoningTexts(entries)).toEqual([text]);
  });

  it('skips blank reasoning and emits one entry per non-empty step', () => {
    const first = '**Primeiro** passo.\n\n- um\n- dois';
    const second = '### Segundo\n\n```ts\nconst x = 1;\n```';
    const entries = buildAgentTrace({
      reasoning: null,
      toolCalls: [],
      trace: [
        { reasoning: null, toolCalls: 0 },
        { reasoning: '   \n\t ', toolCalls: 0 },
        { reasoning: first, toolCalls: 0 },
        { reasoning: second, toolCalls: 0 },
      ],
    });

    expect(reasoningTexts(entries)).toEqual([first, second]);
    expect(entries.map((entry) => entry.kind)).toEqual(['reasoning', 'reasoning']);
  });

  it('keeps each step reasoning stable between builds (Markdown is memoized)', () => {
    const first = '**Passo** um.\n\n- a\n- b';
    const second = '## Passo dois';
    const message = {
      reasoning: null,
      toolCalls: [] as ToolCallRecord[],
      trace: [
        { reasoning: first, toolCalls: 0 },
        { reasoning: second, toolCalls: 0 },
      ],
    };

    const one = reasoningTexts(buildAgentTrace(message));
    const two = reasoningTexts(buildAgentTrace(message));

    expect(one).toEqual([first, second]);
    expect(two).toEqual(one);
    expect(two[0]).toBe(first);
    expect(two[1]).toBe(second);
  });

  it('keeps the raw Markdown of the legacy reasoning fallback in one block', () => {
    const reasoning = '# Título\n\n- um\n- dois\n\n```ts\nconst a = 1;\n```';

    const entries = buildAgentTrace({
      reasoning: `  ${reasoning}  `,
      toolCalls: [tool({ name: 'web_search', result: SEARCH_RESULTS })],
    });

    expect(reasoningTexts(entries)).toEqual([reasoning]);
    expect(entries.map((entry) => entry.kind)).toEqual(['reasoning', 'tools']);
  });

  it('interleaves per-step Markdown with the tool groups of that step', () => {
    const first = 'Buscando **fontes**.';
    const second = '- leitura\n- análise';
    const entries = buildAgentTrace({
      reasoning: null,
      toolCalls: [
        tool({ name: 'web_search', result: SEARCH_RESULTS }),
        tool({ name: 'fetch_url', arguments: '{"url":"https://mit.edu/ia"}' }),
      ],
      trace: [
        { reasoning: first, toolCalls: 1 },
        { reasoning: second, toolCalls: 1 },
      ],
    });

    expect(entries.map((entry) => entry.kind)).toEqual(['reasoning', 'tools', 'reasoning', 'tools']);
    expect(reasoningTexts(entries)).toEqual([first, second]);
    expect(toolGroups(entries).map((group) => group.name)).toEqual(['web_search', 'fetch_url']);
  });
});

describe('buildAgentTrace — objetivo (Goal)', () => {
  const goal = (overrides: Record<string, unknown> = {}) => ({
    kind: 'goal' as const,
    title: 'Objetivo',
    objective: 'Concluir a refatoração.',
    status: 'active' as const,
    autoContinue: true,
    rounds: 2,
    maxRounds: 25,
    revision: 3,
    origin: 'user' as const,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });

  it('agrupa chamadas da tool goal em uma linha com rótulo pt-BR', () => {
    const entries = buildAgentTrace({
      reasoning: null,
      toolCalls: [
        tool({ name: 'goal', presentation: goal({ status: 'completed' }) }),
      ],
    });
    const groups = toolGroups(entries);
    expect(groups.map((group) => group.name)).toEqual(['goal']);
    expect(groups[0].label).toBe('Objetivo concluído');
  });

  it('descreve progresso, bloqueio e falha da tool goal', () => {
    const progress = toolGroups(
      buildAgentTrace({
        reasoning: null,
        toolCalls: [tool({ name: 'goal', presentation: goal() })],
      }),
    )[0];
    expect(progress.label).toBe('Progrediu no objetivo');

    const blocked = toolGroups(
      buildAgentTrace({
        reasoning: null,
        toolCalls: [tool({ name: 'goal', presentation: goal({ status: 'blocked' }) })],
      }),
    )[0];
    expect(blocked.label).toBe('Objetivo bloqueado');

    const failed = toolGroups(
      buildAgentTrace({
        reasoning: null,
        toolCalls: [tool({ name: 'goal', status: 'error', result: 'falhou' })],
      }),
    )[0];
    expect(failed.label).toBe('Falha ao atualizar o objetivo');
  });
});

function blockKinds(blocks: AgentResponseBlock[]): string[] {
  return blocks.map((block) => block.kind);
}

function executionBlocks(
  blocks: AgentResponseBlock[],
): Array<Extract<AgentResponseBlock, { kind: 'execution' }>> {
  return blocks.flatMap((block) => (block.kind === 'execution' ? [block] : []));
}

function textBlocks(blocks: AgentResponseBlock[]): string[] {
  return blocks.flatMap((block) => (block.kind === 'text' ? [block.text] : []));
}

function toolEntry(tools: ToolCallRecord[]): AgentTraceEntry[] {
  return buildAgentTrace({ reasoning: null, toolCalls: tools }).filter(
    (entry): entry is Extract<AgentTraceEntry, { kind: 'tools' }> => entry.kind === 'tools',
  );
}

describe('buildAgentResponseBlocks', () => {
  const SHELL = tool({
    name: 'run_command',
    arguments: '{"command":"pnpm test"}',
    result: 'ok',
  });
  const EDIT = tool({
    name: 'edit_file',
    arguments: '{"path":"src/app.ts"}',
    presentation: { kind: 'file_change', path: 'src/app.ts', change: 'modified', diff: 'x', added: 1, removed: 1 },
  });

  const trace: TraceStep[] = [
    {
      reasoning: 'Vou checar o fixture.',
      text: 'Ambos rejeitados (exit 65).',
      durationMs: 2_000,
      toolCalls: 1,
    },
    {
      reasoning: 'Localizando o duplicado.',
      text: 'Duplicado no 834. Localizando e corrigindo:',
      durationMs: 6_000,
      toolCalls: 1,
    },
    {
      reasoning: 'Verificação final.',
      durationMs: 4_000,
      toolCalls: 0,
    },
  ];

  it('separa a narração e agrupa a execução que veio depois de cada resposta', () => {
    const blocks = buildAgentResponseBlocks({
      reasoning: null,
      toolCalls: [SHELL, EDIT],
      trace,
    });

    expect(blockKinds(blocks)).toEqual([
      'execution',
      'text',
      'execution',
      'text',
      'execution',
    ]);
    expect(textBlocks(blocks)).toEqual([
      'Ambos rejeitados (exit 65).',
      'Duplicado no 834. Localizando e corrigindo:',
    ]);

    const executions = executionBlocks(blocks);
    expect(executions[0].entries.map((entry) => entry.kind)).toEqual(['reasoning']);
    expect(executions[0].entries[0]).toMatchObject({
      kind: 'reasoning',
      text: 'Vou checar o fixture.',
      durationMs: 2_000,
    });

    const firstWork = executions[1];
    expect(firstWork.entries.map((entry) => entry.kind)).toEqual(['tools', 'reasoning']);

    const lastWork = executions[2];
    expect(lastWork.entries.map((entry) => entry.kind)).toEqual(['tools', 'reasoning']);

    // Work time per stretch: the model step time (2s/6s/4s), plus tool time when known.
    expect(executions.map((block) => block.durationMs)).toEqual([2_000, 6_000, 4_000]);
  });

  it('soma a duração real das tools quando conhecida', () => {
    const blocks = buildAgentResponseBlocks({
      reasoning: null,
      toolCalls: [
        tool({
          name: 'run_command',
          arguments: '{"command":"pnpm test"}',
          result: 'ok',
          startedAt: 1_000,
          finishedAt: 4_500,
        }),
      ],
      trace: [{ reasoning: null, text: 'Rodando.', toolCalls: 1, durationMs: 1_000 }],
    });
    // The 1s request precedes the narration; the 3.5s tool runs after it.
    expect(blockKinds(blocks)).toEqual(['execution', 'text', 'execution']);
    expect(executionBlocks(blocks).map((block) => block.durationMs)).toEqual([1_000, 3_500]);
  });

  it('conta o tempo do passo que narrou no trecho anterior, não no seguinte', () => {
    const blocks = buildAgentResponseBlocks({
      reasoning: null,
      toolCalls: [
        tool({
          name: 'run_command',
          arguments: '{"command":"pnpm test"}',
          startedAt: 10_000,
          finishedAt: 11_500,
        }),
        tool({
          name: 'read_file',
          arguments: '{"path":"src/app.ts"}',
          startedAt: 20_000,
          finishedAt: 20_500,
        }),
      ],
      trace: [
        { reasoning: 'Vou verificar.', durationMs: 2_000, toolCalls: 1 },
        {
          reasoning: null,
          text: 'Rodando os testes.',
          durationMs: 9_000,
          toolCalls: 1,
        },
        { reasoning: 'Verificação final.', durationMs: 1_000, toolCalls: 0 },
      ],
    });

    const executions = executionBlocks(blocks);
    // The first stretch is the 2s reasoning plus the 1.5s tool, then the 9s
    // request that produced the narration; the tool it requested (0.5s) and
    // the final 1s step come after the text.
    expect(executions.map((block) => block.durationMs)).toEqual([12_500, 1_500]);
    expect(blockKinds(blocks)).toEqual(['execution', 'text', 'execution']);
  });

  it('não perde o tempo de um passo inicial que só narrou', () => {
    const blocks = buildAgentResponseBlocks({
      reasoning: null,
      toolCalls: [
        tool({
          name: 'read_file',
          arguments: '{"path":"src/app.ts"}',
          startedAt: 0,
          finishedAt: 250,
        }),
      ],
      trace: [
        {
          reasoning: null,
          text: 'Vou começar explorando o projeto.',
          durationMs: 7_000,
          toolCalls: 1,
        },
      ],
    });

    expect(blockKinds(blocks)).toEqual(['execution', 'text', 'execution']);
    const executions = executionBlocks(blocks);
    expect(executions.map((block) => block.durationMs)).toEqual([7_000, 250]);
    expect(executions[0].entries).toEqual([]);
  });

  it('nunca perde tool calls fora do trace e ignora passos vazios', () => {
    const blocks = buildAgentResponseBlocks({
      reasoning: null,
      toolCalls: [SHELL, EDIT],
      trace: [
        { reasoning: null, text: 'Vou rodar tudo.', toolCalls: 0 },
        { reasoning: null, toolCalls: 0 },
      ],
    });

    expect(blockKinds(blocks)).toEqual(['text', 'execution']);
    expect(executionBlocks(blocks)[0].entries.length).toBe(2);
    expect(executionBlocks(blocks)[0].durationMs).toBe(0);
  });
});

describe('describeTraceActivity', () => {
  it('descreve o raciocínio em uma linha com prévia', () => {
    const activity = describeTraceActivity([
      {
        kind: 'reasoning',
        text: 'Given this is a large project,\n\nmaybe I should use teammates.',
        durationMs: 2_000,
      },
    ]);
    expect(activity).toEqual({
      kind: 'reasoning',
      label: 'Analisando a solicitação',
      preview: 'Given this is a large project, maybe I should use teammates.',
      running: true,
    });
  });

  it('descreve a tool em execução e o alvo como prévia', () => {
    const shell = tool({
      name: 'run_command',
      status: 'running',
      arguments: '{"command":"Select-String -Path docs/ARCHITECTURE.md"}',
    });
    expect(describeTraceActivity(toolEntry([shell]))).toEqual({
      kind: 'tool',
      label: 'Executando comandos',
      preview: 'Select-String -Path docs/ARCHITECTURE.md',
      toolName: 'run_command',
      running: true,
    });

    const edit = tool({
      name: 'edit_file',
      status: 'running',
      arguments: '{"path":"src/app.ts"}',
      presentation: { kind: 'file_change', path: 'src/app.ts', change: 'modified', added: 1, removed: 1 },
    });
    expect(describeTraceActivity(toolEntry([edit]))).toMatchObject({
      label: 'Editando arquivos',
      preview: 'src/app.ts',
    });

    const fetch = tool({
      name: 'fetch_url',
      status: 'running',
      arguments: '{"url":"https://tauri.app/start/"}',
    });
    expect(describeTraceActivity(toolEntry([fetch]))).toMatchObject({
      label: 'Lendo páginas',
      preview: 'https://tauri.app/start/',
    });
  });

  it('marca a tool concluída e cai no vazio sem entradas', () => {
    const read = tool({ name: 'read_file', arguments: '{"path":"src/app.ts"}' });
    expect(describeTraceActivity(toolEntry([read]))).toMatchObject({
      label: 'Lendo arquivos',
      running: false,
    });
    expect(describeTraceActivity([])).toBeNull();
  });

  it('traduz a atividade e mantém fallback legível', () => {
    expect(toolActivityLabel('run_checks')).toBe('Rodando verificações');
    expect(toolActivityLabel('minha_tool_nova')).toBe('Usando minha tool nova');
  });
});

describe('hasTraceText / toolFamilyLabel', () => {
  it('detecta narração intermediária apenas quando há texto', () => {
    expect(hasTraceText(null)).toBe(false);
    expect(hasTraceText([])).toBe(false);
    expect(hasTraceText([{ reasoning: 'x', toolCalls: 1 }])).toBe(false);
    expect(hasTraceText([{ text: '   ', toolCalls: 1 }])).toBe(false);
    expect(hasTraceText([{ text: 'Narração', toolCalls: 1 }])).toBe(true);
  });

  it('traduz famílias de tool e mantém fallback legível', () => {
    expect(toolFamilyLabel('run_command')).toBe('Shell');
    expect(toolFamilyLabel('edit_file')).toBe('Editar');
    expect(toolFamilyLabel('minha_tool_nova')).toBe('minha tool nova');
  });
});

describe('compact Chat turn view model', () => {
  it('keeps one row per call in chronological order, expanding adjacent groups', () => {
    const tools = [
      tool({ id: 'r1', name: 'read_file', arguments: '{"path":"src/a.ts"}' }),
      tool({ id: 'r2', name: 'read_file', arguments: '{"path":"src/b.ts"}' }),
      tool({ id: 's1', name: 'search_text', arguments: '{"pattern":"trace"}' }),
    ];
    const entries = buildAgentTrace({
      reasoning: 'Vou inspecionar.',
      toolCalls: tools,
      trace: [{ reasoning: 'Vou inspecionar.', toolCalls: 3 }],
    });

    const rows: CompactTurnRow[] = buildCompactTurnRows(entries);
    expect(rows.map((row) => row.id)).toEqual(['reasoning-0', 'r1', 'r2', 's1']);
    expect(rows[0]).toMatchObject({
      kind: 'reasoning',
      label: 'Pensou',
      detail: 'Vou inspecionar.',
    });
    expect(rows[1]).toMatchObject({
      kind: 'tool',
      toolName: 'read_file',
      label: 'Leu src/a.ts',
      detail: 'src/a.ts',
      status: 'done',
    });
    expect(rows[3].label).toBe('Buscou “trace”');
  });

  it('uses existing activity phrases for calls without a target and keeps the status', () => {
    const entries = buildAgentTrace({
      reasoning: '',
      toolCalls: [
        tool({ id: 'w1', name: 'web_search', arguments: '{"query":"rust"}', status: 'running' }),
      ],
      trace: [],
    });
    expect(buildCompactTurnRows(entries)[0]).toMatchObject({
      label: 'Pesquisando na web',
      detail: 'rust',
      status: 'running',
    });
  });

  it('counts tool calls by family without counting results or reasoning', () => {
    const tools = [
      tool({ name: 'run_command', arguments: '{"command":"pnpm test"}' }),
      tool({ name: 'read_file', arguments: '{"path":"src/a.ts"}' }),
      tool({ name: 'read_tool_output', arguments: '{"job_id":"j1"}' }),
      tool({ name: 'search_files', arguments: '{"pattern":"**/*.rs"}' }),
      tool({ name: 'web_search', result: SEARCH_RESULTS }),
      tool({ name: 'todo_write', arguments: '{"todos":[]}' }),
    ];
    const entries = buildAgentTrace({
      reasoning: 'Raciocínio longo',
      toolCalls: tools,
      trace: [{ reasoning: 'Raciocínio longo', toolCalls: tools.length }],
    });
    expect(summarizeCompactTurn(entries)).toEqual({
      commands: 1,
      reads: 2,
      searches: 2,
      other: 1,
    });
  });

  it('still flattens legacy messages without a persisted trace', () => {
    const entries = buildAgentTrace({
      reasoning: 'Sem trace',
      toolCalls: [tool({ id: 'legacy', name: 'list_dir', arguments: '{"path":"docs"}' })],
      trace: undefined,
    });
    expect(buildCompactTurnRows(entries).map((row) => row.id)).toEqual([
      'reasoning-0',
      'legacy',
    ]);
  });
});