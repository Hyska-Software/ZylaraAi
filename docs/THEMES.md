# Temas personalizados

O Zylara instala temas a partir de um pacote `.zip` local. Um tema é **declarativo**: ele fornece paletas (claro/escuro), raios, fontes e papel de parede opcionais. Não há CSS nem JavaScript arbitrário no pacote.

O tema embutido **Zylara** (`themeId: "zylara"`) é o padrão e não pode ser removido. O app também traz cinco temas prontos, com variantes clara e escura: **Aurora** (`aurora`), **Ember** (`ember`), **Grove** (`grove`), **Nebula** (`nebula`, inspirado no Aura Theme) e **Nocturne** (`nocturne`, inspirado no Dracula/Alucard). Eles são embarcados no binário (manifestos em `src-tauri/themes/*.json`, incluídos via `include_str!`), não ficam em `<app-data>/themes` e não podem ser reinstalados/removidos. O modo Claro/Escuro/Sistema é independente do tema: cada pacote fornece as duas paletas.

## Onde os temas ficam

```
<app-data>/themes/<id>/
  theme.json
  fonts/...
  images/...
```

O id vem do manifesto. Reinstalar o mesmo id substitui a pasta atomicamente. A pasta pode ser aberta em **Configurações → Temas → Abrir pasta de temas**; use **Recarregar temas** depois de copiar uma pasta manualmente.

## Pacote

- ZIP de até 24 MB, com até 256 arquivos.
- `theme.json` na raiz **ou** dentro de uma única pasta de primeiro nível (`meu-tema/theme.json`).
- Somente os arquivos referenciados pelo manifesto são extraídos (`fonts` e `wallpaper`).
- Nomes de arquivo usam `/`, sem `..`, sem caminho absoluto e sem `\`.

## Manifesto

```json
{
  "schemaVersion": 1,
  "id": "ocean",
  "name": "Ocean",
  "version": "1.0.0",
  "author": "Jane Doe",
  "description": "Azul profundo para uso noturno.",
  "tokens": {
    "light": {
      "background": "#f7fbff",
      "surface": "#eef5ff",
      "surface-raised": "#ffffff",
      "surface-hover": "#e3edff",
      "surface-active": "#d8e6ff",
      "foreground": "#0a1020",
      "foreground-muted": "#46536b",
      "foreground-subtle": "#6b7890",
      "border": "#d6e2f5",
      "border-strong": "#b9cbe6",
      "accent": "#2563eb",
      "accent-hover": "#1d4ed8",
      "accent-foreground": "#ffffff",
      "accent-soft": "#e8f0ff",
      "success": "#15803d",
      "success-soft": "#e8f8ee",
      "warning": "#a16207",
      "warning-soft": "#fff7e0",
      "danger": "#dc2626",
      "danger-soft": "#fef2f2",
      "user-bubble": "#e8f0ff",
      "code-bg": "#f4f8ff",
      "terminal-selection": "#2563eb33",
      "radius-md": "0.875rem"
    },
    "dark": {
      "background": "#071018",
      "surface": "#0b1624",
      "surface-raised": "#102033",
      "surface-hover": "#152942",
      "surface-active": "#1b3350",
      "foreground": "#e8f0ff",
      "foreground-muted": "#a7b8d0",
      "foreground-subtle": "#7186a3",
      "border": "#1c3048",
      "border-strong": "#2b4565",
      "accent": "#60a5fa",
      "accent-hover": "#93c5fd",
      "accent-foreground": "#04101f",
      "accent-soft": "#10263f",
      "success": "#4ade80",
      "success-soft": "#0d2418",
      "warning": "#fbbf24",
      "warning-soft": "#2a2110",
      "danger": "#f87171",
      "danger-soft": "#2b1313",
      "user-bubble": "#152942",
      "code-bg": "#0a1522",
      "terminal-selection": "#60a5fa44",
      "radius-md": "0.875rem"
    }
  },
  "fonts": {
    "sans": "fonts/Manrope.woff2",
    "mono": "fonts/JetBrainsMono.woff2"
  },
  "wallpaper": {
    "light": "images/ocean-light.webp",
    "dark": "images/ocean-dark.webp"
  }
}
```

### Tokens

As chaves são nomes de custom properties CSS **sem** `--`; valores são aplicados em `<html>`.

Obrigatórios nos dois modos (todos cores):

| Grupo | Tokens |
|---|---|
| Superfícies | `background`, `surface`, `surface-raised`, `surface-hover`, `surface-active` |
| Texto | `foreground`, `foreground-muted`, `foreground-subtle` |
| Bordas | `border`, `border-strong` |
| Marca | `accent`, `accent-hover`, `accent-foreground`, `accent-soft` |
| Estados | `success`, `success-soft`, `warning`, `warning-soft`, `danger`, `danger-soft` |
| Chat/código/terminal | `user-bubble`, `code-bg`, `terminal-selection` |

As cores de borda (`border`, `border-strong`) **não desenham molduras**: o app não usa contorno fechado em nenhum elemento. Elas alimentam divisores de 1px (`divide-*`, `border-b`, `hr`, `Separator`), barras de rolagem, o trilho do slider e o grid do calendário. A separação entre blocos vem do contraste de superfície, então `background`, `surface`, `surface-raised` e `surface-hover` precisam ser visivelmente distintas entre si nos dois modos — um tema com superfícies iguais deixa os blocos sem contorno visível.

O símbolo do app (titlebar, boas-vindas, splash, avatar do assistente e Sobre) acompanha a marca do tema: o corpo usa `accent`, os recortes do focinho/orelhas/pata usam `background` e o olho usa `foreground`. O tema embutido Zylara mantém a arte oficial, e o tile, o favicon e os ícones do sistema nunca são recoloridos.

Opcionais:

- Cores: `accent-ring`, `context-system`, `context-tools`, `context-messages`, `assistant-bubble`, `terminal-ansi-{black,red,green,yellow,blue,magenta,cyan,white}` e `terminal-ansi-bright-{black,red,green,yellow,blue,magenta,cyan,white}`.
- Raios (comprimentos `px`, `rem` ou `em`): `radius-xs`, `radius-sm`, `radius-md`, `radius-lg`, `radius-xl`, `radius-2xl`, `radius-3xl`. O app os consome via `--theme-radius-*`, o que permite trocar o arredondamento sem rebuildar o CSS.

Formatos de cor aceitos: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `transparent` e funções `rgb()`, `rgba()`, `hsl()`, `hsla()`, `oklch()`, `oklab()`, `lab()`, `lch()`, `color(...)`.

Tokens ausentes e opcionais preservam o valor embutido correspondente ao modo ativo.

### Fontes

`fonts.sans` e `fonts.mono` são opcionais e apontam para arquivos `woff2`, `woff`, `ttf` ou `otf` (até 4 MB cada). A fonte é registrada com um nome interno do tema e usada pela interface; se o arquivo falhar, o tema mantém a fonte padrão. O terminal integrado mantém o **JetBrains Mono** embutido como padrão e só troca de família quando o usuário escolhe outra em Configurações → Terminal.

### Papel de parede

`wallpaper.light` e `wallpaper.dark` são opcionais e aceitam `png`, `jpg`/`jpeg`, `webp` ou `gif` (até 8 MB e 8192 px por lado). A imagem é aplicada ao `body` como fundo fixo. As superfícies do app são opacas por padrão: para o papel de parede aparecer, use cores de superfície com alfa (`background`, `surface`, `surface-raised`, …, por exemplo `#0b1624cc`).

## Desenvolvendo um tema

### Estrutura inicial

```
meu-tema/
  theme.json
  fonts/        (opcional)
  images/       (opcional)
```

O `theme.json` pode ficar na raiz do ZIP ou dentro de uma única pasta de primeiro nível. O nome da pasta em `<app-data>/themes/` **precisa ser exatamente o `id`** do manifesto.

### Ponto de partida

Copie o manifesto completo do exemplo acima. O mínimo necessário é:

- `schemaVersion: 1`
- `id` estável (minúsculo, `[a-z0-9._-]`, diferente de `zylara`, `aurora`, `ember`, `grove`, `nebula` e `nocturne`)
- `name`
- `tokens.light` e `tokens.dark` com **todos os 23 tokens obrigatórios**

`version` assume `1.0.0` quando omitido; `author`, `description`, `fonts` e `wallpaper` são opcionais. Mantenha o mesmo `id` entre versões: reinstalar substitui o tema atomicamente.

### Ordem de trabalho recomendada

1. Monte primeiro a paleta **claro** com todos os tokens obrigatórios.
2. Derive a paleta **escura** e confira contraste de `foreground*` sobre `background`/`surface*`, de `accent-foreground` sobre `accent` e dos estados.
3. Ajuste opcionais de contexto e do terminal (`terminal-ansi-*`) se quiser que o terminal combine com o tema.
4. Ajuste os raios (`radius-xs`…`radius-3xl`) com valores `px`, `rem` ou `em`.
5. Adicione fontes em `fonts.sans`/`fonts.mono`; prefira WOFF2 (variável para todos os pesos) e no máximo 4 MB por arquivo.
6. Adicione wallpaper claro/escuro (até 8 MB, 8192 px por lado). Para ele aparecer, use `background`/`surface*` com alfa (`#rrggbbaa`).

### Iteração local

1. Abra **Configurações → Temas → Abrir pasta de temas**.
2. Crie `<app-data>/themes/<id>/theme.json` e os assets referenciados.
3. Clique em **Recarregar temas**. Se o tema não aparecer, o manifesto é inválido, o `id` não bate com a pasta ou um asset/arquivo tem problema.
4. Para ver a mensagem de validação exata, instale o ZIP pelo botão **Instalar tema…**: os erros do backend aparecem no toast.
5. Alterou arquivos? **Recarregar temas** reaplica o tema ativo.

### Empacotamento

Windows (PowerShell):

```powershell
Compress-Archive -Path .\meu-tema\* -DestinationPath .\meu-tema.zip -Force
```

macOS/Linux:

```bash
cd meu-tema
zip -r ../meu-tema.zip .
```

O ZIP precisa ter `theme.json` na raiz **ou** uma única pasta contendo `theme.json` na raiz do ZIP. Evite incluir uma pasta pai com arquivos soltos.

### Checklist antes de publicar

- [ ] O ZIP instala sem erro e o card aparece em Temas.
- [ ] **Usar** altera superfícies, texto, accent, raios e a cor do símbolo do app.
- [ ] Claro, Escuro e Sistema mostram as duas paletas corretamente.
- [ ] Fontes e wallpaper aparecem quando configurados; sem eles, o tema continua legível.
- [ ] Reiniciar o app mantém o tema ativo.
- [ ] Reinstalar o mesmo `id` atualiza o tema.
- [ ] Remover o tema ativo volta para o Zylara.
- [ ] Um ZIP inválido é rejeitado com mensagem.
- [ ] O terminal (se personalizado) continua legível.

### Limitações de projeto

Não há CSS, JavaScript ou HTML no pacote. Tudo que o tema consegue alterar está na lista de tokens, nas fontes e no wallpaper. Para um efeito que não existe na lista, é preciso primeiro adicionar o token ao app.

## Limites e segurança

- ZIP: 24 MB, 256 entradas, manifesto de 256 KB.
- Só arquivos referenciados são extraídos; extensões e assinaturas (magic bytes) são validadas. Imagens também têm dimensões verificadas.
- Links simbólicos, caminhos com `..`, caminhos absolutos, separadores `\` e nomes duplicados são rejeitados.
- Nenhum CSS, JavaScript, HTML ou expressão é executado. O renderer aplica somente tokens validados e data URLs de assets validados.
- Reinstalar o mesmo `id` substitui o tema (atualização). Remover o tema ativo volta para o Zylara. Os ids `zylara`, `aurora`, `ember`, `grove`, `nebula` e `nocturne` são reservados para os temas embutidos e não podem ser instalados nem removidos.

## Instalando e testando

1. Gere o ZIP com `theme.json` na raiz (ou em uma pasta única).
2. **Configurações → Temas → Instalar tema…** e selecione o arquivo.
3. Clique em **Usar** no card do tema.
4. Alterne Claro/Escuro/Sistema para conferir as duas paletas.
5. Reinicie o app e confirme que o tema continua ativo.
6. Remova o tema ativo para validar o retorno ao Zylara.

O tema ativo é persistido em `settings.json` como `themeId`.
