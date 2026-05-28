/**
 * Turtle / TriG language support for Monaco Editor.
 *
 * Registers the "turtle" language with syntax highlighting for:
 *  - @prefix / @base / PREFIX / BASE directives
 *  - IRI references <...>
 *  - Prefixed names ns:local
 *  - Blank nodes _:local and [] syntax
 *  - String literals (single, double, triple-quoted) with lang tags and datatypes
 *  - Numbers, booleans
 *  - Comments
 */

import type * as Monaco from 'monaco-editor';

export const TURTLE_LANGUAGE_ID = 'turtle';

// ─── Tokenizer ────────────────────────────────────────────────────────────────

const TURTLE_LANGUAGE_DEF: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.ttl',

  tokenizer: {
    root: [
      // Whitespace
      [/\s+/, ''],

      // Comments
      [/#.*$/, 'comment'],

      // Directives: @prefix, @base (Turtle-style with @)
      [/@(prefix|base)\b/, 'keyword.directive'],

      // SPARQL-style PREFIX / BASE
      [/\b(PREFIX|BASE)\b/, 'keyword.directive'],

      // Booleans
      [/\b(true|false)\b/, 'keyword.constant'],

      // IRI references: <...>
      [/<[^>]*>/, 'string.iri'],

      // Prefixed names: ns:local  (or bare :local with empty prefix)
      [/([A-Za-z_][\w\-.]*)?:(\w[\w\-.]*)?/, 'type.prefixed'],

      // Blank nodes: _:name
      [/_:[\w\-.]+/, 'variable.predefined'],

      // String literals: triple-double first
      [/"""/, { token: 'string.delim', next: '@tripleDouble' }],
      [/"/, { token: 'string.delim', next: '@double' }],
      // Single-quoted
      [/'''/, { token: 'string.delim', next: '@tripleSingle' }],
      [/'/, { token: 'string.delim', next: '@single' }],

      // Datatype separator ^^
      [/\^\^/, 'operator'],

      // Language tag: @en, @en-US
      [/@[A-Za-z][-A-Za-z0-9]*/, 'tag'],

      // Numbers
      [/[+-]?\d+\.\d*([eE][+-]?\d+)?/, 'number.float'],
      [/[+-]?\d+/, 'number'],

      // Punctuation / delimiters
      [/[()[\]{}]/, 'delimiter'],
      [/[;,.]/, 'delimiter'],
    ],

    tripleDouble: [
      [/[^"\\]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"""/, { token: 'string.delim', next: '@pop' }],
      [/"/, 'string'],
    ],
    double: [
      [/[^"\\]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, { token: 'string.delim', next: '@pop' }],
    ],
    tripleSingle: [
      [/[^'\\]+/, 'string'],
      [/\\./, 'string.escape'],
      [/'''/, { token: 'string.delim', next: '@pop' }],
      [/'/, 'string'],
    ],
    single: [
      [/[^'\\]+/, 'string'],
      [/\\./, 'string.escape'],
      [/'/, { token: 'string.delim', next: '@pop' }],
    ],
  },
};

// ─── Theme tokens (extend shex-dark so both use the same base) ────────────────

export const TURTLE_THEME_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: 'comment.ttl',             foreground: '6a9955' },
  { token: 'keyword.directive.ttl',   foreground: '569cd6', fontStyle: 'bold' },
  { token: 'keyword.constant.ttl',    foreground: '569cd6' },
  { token: 'string.iri.ttl',          foreground: 'ce9178' },
  { token: 'string.ttl',              foreground: 'ce9178' },
  { token: 'string.delim.ttl',        foreground: 'ce9178' },
  { token: 'string.escape.ttl',       foreground: 'd7ba7d' },
  { token: 'type.prefixed.ttl',       foreground: '4ec9b0' },
  { token: 'variable.predefined.ttl', foreground: '9cdcfe' },
  { token: 'tag.ttl',                 foreground: 'd7ba7d' },
  { token: 'number.ttl',              foreground: 'b5cea8' },
  { token: 'number.float.ttl',        foreground: 'b5cea8' },
  { token: 'operator.ttl',            foreground: 'd4d4d4' },
  { token: 'delimiter.ttl',           foreground: 'd4d4d4' },
];

// ─── Registration ─────────────────────────────────────────────────────────────

let registered = false;

export function registerTurtleLanguage(monaco: typeof Monaco) {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: TURTLE_LANGUAGE_ID, extensions: ['.ttl', '.turtle', '.trig', '.n3'] });
  monaco.languages.setMonarchTokensProvider(TURTLE_LANGUAGE_ID, TURTLE_LANGUAGE_DEF);
}
