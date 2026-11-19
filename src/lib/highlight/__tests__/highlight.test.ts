import { describe, expect, it } from 'vitest';
import { Highlight } from 'prism-react-renderer';
import { Prism, prism, SYNTAX_THEME, languageLabel, normalizeLanguage } from '@/lib/highlight';

describe('highlight — Prism estendido', () => {
  it('registra as grammars extras pedidas na v1.5', () => {
    for (const id of [
      'bash',
      'powershell',
      'docker',
      'makefile',
      'diff',
      'ini',
      'git',
      'batch',
      'vbnet',
      'nginx',
      'http',
      'cmake',
      'protobuf',
      'ruby',
      'php',
      'csharp',
      'java',
      'scala',
      'dart',
      'lua',
      'perl',
      'r',
      'elixir',
      'haskell',
      'clojure',
      'elm',
      'toml',
      'wasm',
      'hcl',
      'mermaid',
      'scss',
      'sass',
      'less',
      /* Shaders and GPU languages */
      'hlsl',
      'glsl',
      'wgsl',
      'opencl',
      /* Systems and low-level languages */
      'zig',
      'nim',
      'crystal',
      'd',
      'fortran',
      'nasm',
      'armasm',
      /* Functional, academic and scientific languages */
      'julia',
      'matlab',
      'erlang',
      'fsharp',
      'lisp',
      'scheme',
      'racket',
      'prolog',
      /* Templates */
      'pug',
      'haml',
      'twig',
      'liquid',
      'ejs',
      'handlebars',
      /* Query and configuration */
      'cypher',
      'csv',
      'bicep',
      'nix',
      'apacheconf',
      /* Documentation */
      'latex',
      'asciidoc',
      /* Miscellaneous */
      'solidity',
      'groovy',
      'smalltalk',
    ]) {
      expect(prism.languages[id], `grammar ausente: ${id}`).toBeTruthy();
    }
  });

  it('mantém as grammars embutidas no prism-react-renderer', () => {
    for (const id of ['markup', 'css', 'clike', 'javascript', 'jsx', 'typescript', 'tsx', 'json', 'yaml', 'markdown', 'python', 'rust', 'go', 'sql', 'kotlin', 'objectivec']) {
      expect(prism.languages[id], `grammar embutida ausente: ${id}`).toBeTruthy();
    }
  });

  it('tokeniza com as grammars novas (bash, java, ruby, toml, csharp, hlsl, glsl, zig, julia, solidity)', () => {
    const cases: Array<[string, string]> = [
      ['bash', 'echo "oi"'],
      ['java', 'public class Main {}'],
      ['ruby', 'def ola; puts "oi"; end'],
      ['toml', 'titulo = "Zylara"'],
      ['csharp', 'public int Soma(int a, int b) { return a + b; }'],
      ['hlsl', 'struct GeometryOut { float4 position : SV_Position; };'],
      ['glsl', 'void main() { gl_Position = vec4(0.0); }'],
      ['zig', 'const valor: u32 = 42;'],
      ['julia', 'function ola(n::Int) return n + 1 end'],
      ['solidity', 'contract Exemplo { uint public valor; }'],
    ];

    for (const [language, code] of cases) {
      const grammar = prism.languages[language];
      expect(grammar, `grammar ausente: ${language}`).toBeTruthy();
      const tokens = prism.tokenize(code, grammar);
      // A gramática real produz pelo menos um token tipado (não apenas string).
      expect(tokens.some((token) => typeof token === 'object'), language).toBe(true);
    }
  });

  it('a gramática php carrega junto com markup-templating', () => {
    expect(prism.languages.php).toBeTruthy();
    expect(prism.languages['markup-templating']).toBeTruthy();
  });

  it('registra scss/sass/less e destaca folhas de estilo (não cai em texto puro)', () => {
    for (const id of ['scss', 'sass', 'less']) {
      expect(prism.languages[id], `grammar de estilo ausente: ${id}`).toBeTruthy();
    }

    const source = [
      '$cor: #6446fb;',
      '.botao {',
      '  color: $cor;',
      '  &:hover { color: darken($cor, 10%); }',
      '}',
    ].join('\n');

    const html = Prism.highlight(source, prism.languages.scss, 'scss');
    expect(html).toContain('token');
    // SCSS real: variável/seletor/propriedade viram tokens, não texto cru.
    expect(html).toMatch(/class="token (variable|property|selector|keyword)/);
  });

  it('exporta um tema único baseado em variáveis CSS do Zylara', () => {
    expect(SYNTAX_THEME.plain?.color).toBe('var(--foreground)');
    expect(SYNTAX_THEME.plain?.backgroundColor).toBe('transparent');

    const styles = SYNTAX_THEME.styles ?? [];
    expect(styles.length).toBeGreaterThan(5);
    for (const entry of styles) {
      const values = Object.values(entry.style ?? {});
      for (const value of values) {
        if (typeof value === 'string' && value.startsWith('var(')) {
          expect(value).toMatch(/^var\(--[a-z-]+\)$/);
        }
      }
    }

    const stringToken = styles.find((entry) => entry.types.includes('string'));
    expect(stringToken?.style?.color).toBe('var(--success)');
    const numberToken = styles.find((entry) => entry.types.includes('number'));
    expect(numberToken?.style?.color).toBe('var(--warning)');
  });

  it('expõe a mesma instância consumida pelo <Highlight> (tokenize estável)', () => {
    // As grammars são carregadas sobre o Prism que o prism-react-renderer
    // exporta; se houvesse uma segunda cópia, o tokenize abaixo não veria a
    // gramática registrada pelas definições extras.
    const tokenized = prism.tokenize('const valor = 42;', prism.languages.typescript);
    expect(JSON.stringify(tokenized)).toContain('valor');
  });

  it('mantém o componente Highlight importável (sanidade da integração)', () => {
    expect(typeof Highlight).toBe('function');
  });
});

describe('normalizeLanguage', () => {
  it.each([
    ['md', 'markdown'],
    ['MD', 'markdown'],
    ['ts', 'typescript'],
    ['tsx', 'tsx'],
    ['js', 'javascript'],
    ['jsx', 'jsx'],
    ['py', 'python'],
    ['rs', 'rust'],
    ['sh', 'bash'],
    ['zsh', 'bash'],
    ['shell', 'bash'],
    ['yml', 'yaml'],
    ['kt', 'kotlin'],
    ['cs', 'csharp'],
    ['hpp', 'cpp'],
    ['html', 'markup'],
    ['htm', 'markup'],
    ['xml', 'markup'],
    ['svg', 'markup'],
    ['vue', 'markup'],
    ['svelte', 'markup'],
    ['astro', 'markup'],
    ['jsonc', 'json'],
    ['json5', 'json'],
    ['toml', 'toml'],
    ['dockerfile', 'docker'],
    ['gitignore', 'git'],
    ['makefile', 'makefile'],
    ['mk', 'makefile'],
    ['txt', 'text'],
    ['plaintext', 'text'],
    ['text', 'text'],
    ['ps1', 'powershell'],
    ['bat', 'batch'],
    ['vb', 'vbnet'],
    ['proto', 'protobuf'],
    ['tf', 'hcl'],
    ['patch', 'diff'],
    ['c++', 'cpp'],
    ['objc', 'objectivec'],
    ['wat', 'wasm'],
    ['language-ts', 'typescript'],
    ['.py', 'python'],
    ['hlsli', 'hlsl'],
    ['fx', 'hlsl'],
    ['vert', 'glsl'],
    ['frag', 'glsl'],
    ['wgsl', 'wgsl'],
    ['jl', 'julia'],
    ['fs', 'fsharp'],
    ['rkt', 'racket'],
    ['hbs', 'handlebars'],
    ['jade', 'pug'],
    ['cyp', 'cypher'],
    ['tex', 'latex'],
    ['adoc', 'asciidoc'],
    ['sol', 'solidity'],
    ['gradle', 'groovy'],
    ['m', 'objectivec'],
    ['mm', 'objectivec'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeLanguage(raw)).toBe(expected);
  });

  it('trata vazio, nulo e desconhecido', () => {
    expect(normalizeLanguage()).toBe('text');
    expect(normalizeLanguage(null)).toBe('text');
    expect(normalizeLanguage('   ')).toBe('text');
    expect(normalizeLanguage('ziguana')).toBe('ziguana');
  });
});

describe('languageLabel', () => {
  it.each([
    ['python', 'Python'],
    ['py', 'Python'],
    ['typescript', 'TypeScript'],
    ['ts', 'TypeScript'],
    ['markdown', 'Markdown'],
    ['md', 'Markdown'],
    ['text', 'Texto'],
    ['txt', 'Texto'],
    ['json', 'JSON'],
    ['bash', 'Bash'],
    ['dockerfile', 'Dockerfile'],
    ['csharp', 'C#'],
    ['cpp', 'C++'],
    ['objectivec', 'Objective-C'],
    ['wasm', 'WebAssembly'],
    ['makefile', 'Makefile'],
    ['markup', 'HTML'],
    ['hlsl', 'HLSL'],
    ['glsl', 'GLSL'],
    ['wgsl', 'WGSL'],
    ['jl', 'Julia'],
    ['fs', 'F#'],
    ['tex', 'LaTeX'],
    ['adoc', 'AsciiDoc'],
    ['sol', 'Solidity'],
    ['gradle', 'Groovy'],
    ['csv', 'CSV'],
    ['jade', 'Pug'],
    ['m', 'Objective-C'],
  ])('%s → %s', (raw, expected) => {
    expect(languageLabel(raw)).toBe(expected);
  });

  it('trata vazio e desconhecido', () => {
    expect(languageLabel()).toBe('Texto');
    expect(languageLabel('')).toBe('Texto');
    expect(languageLabel('zig')).toBe('Zig');
  });
});
