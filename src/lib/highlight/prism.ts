/**
 * Single shared Prism instance with the extra grammars used by Zylara.
 *
 * `prism-react-renderer` embeds a Prism build (markup, css, clike, javascript,
 * jsx, typescript, tsx, json, yaml, markdown, python, rust, go, sql, c, cpp,
 * swift, kotlin, objectivec, …) and exports it. The language scripts below are
 * loaded on top of that instance; grammars that are already bundled are not
 * re-registered (see the list in the comment block).
 *
 * Import order matters: `prism-global` must run before any grammar file, and a
 * language definition must come before the languages that extend it.
 */
import './prism-global';

/* php extends markup-templating; vbnet extends basic; scala extends java. */
import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-basic';
import 'prismjs/components/prism-java';

/* Shells and terminals */
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-batch';

/* Stylesheets (css is bundled by prism-react-renderer; these extend it) */
import 'prismjs/components/prism-scss';
import 'prismjs/components/prism-sass';
import 'prismjs/components/prism-less';

/* Config, build and infra files */
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-makefile';
import 'prismjs/components/prism-cmake';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-git';
import 'prismjs/components/prism-diff';
import 'prismjs/components/prism-hcl';
import 'prismjs/components/prism-nginx';
import 'prismjs/components/prism-http';

/* Languages */
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-vbnet';
import 'prismjs/components/prism-scala';
import 'prismjs/components/prism-dart';
import 'prismjs/components/prism-lua';
import 'prismjs/components/prism-perl';
import 'prismjs/components/prism-r';
import 'prismjs/components/prism-elixir';
import 'prismjs/components/prism-haskell';
import 'prismjs/components/prism-clojure';
import 'prismjs/components/prism-elm';
import 'prismjs/components/prism-protobuf';
import 'prismjs/components/prism-wasm';

/* Shaders and GPU languages (all extend the bundled c grammar) */
import 'prismjs/components/prism-hlsl';
import 'prismjs/components/prism-glsl';
import 'prismjs/components/prism-wgsl';
import 'prismjs/components/prism-opencl';

/* Systems and low-level languages */
import 'prismjs/components/prism-zig';
import 'prismjs/components/prism-nim';
import 'prismjs/components/prism-crystal'; // extends ruby, imported above
import 'prismjs/components/prism-d';
import 'prismjs/components/prism-fortran';
import 'prismjs/components/prism-nasm';
import 'prismjs/components/prism-armasm';

/* Functional, academic and scientific languages */
import 'prismjs/components/prism-julia';
import 'prismjs/components/prism-matlab';
import 'prismjs/components/prism-erlang';
import 'prismjs/components/prism-fsharp';
import 'prismjs/components/prism-lisp';
import 'prismjs/components/prism-scheme';
import 'prismjs/components/prism-racket'; // extends scheme, imported above
import 'prismjs/components/prism-prolog';

/* Templates (markup-templating is imported at the top) */
import 'prismjs/components/prism-pug';
import 'prismjs/components/prism-haml';
import 'prismjs/components/prism-twig';
import 'prismjs/components/prism-liquid';
import 'prismjs/components/prism-ejs';
import 'prismjs/components/prism-handlebars';

/* Query and configuration */
import 'prismjs/components/prism-cypher';
import 'prismjs/components/prism-csv';
import 'prismjs/components/prism-bicep';
import 'prismjs/components/prism-nix';
import 'prismjs/components/prism-apacheconf';

/* Documentation */
import 'prismjs/components/prism-latex';
import 'prismjs/components/prism-asciidoc';

/* Miscellaneous */
import 'prismjs/components/prism-solidity';
import 'prismjs/components/prism-groovy';
import 'prismjs/components/prism-smalltalk';

/* Diagrams (Mermaid fallback code cards) */
import 'prismjs/components/prism-mermaid';

import { Prism } from './prism-global';

/** Shared Prism instance used by every code block in the app. */
export const prism = Prism;

export { Prism };
