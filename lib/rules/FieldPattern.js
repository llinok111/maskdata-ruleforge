'use strict';

/**
 * Field pattern parsing and target collection.
 *
 * Upstream `JsonMask.mask()` recognises four field syntaxes but silently
 * `return`s when a pattern is malformed. Examples that pass without any error
 * upstream and simply never mask anything:
 *
 *   'a.*.b'   -> `field.includes('.*') && !field.endsWith('.*')` -> silent return
 *   '*a.b'    -> `startsWith('*') && includes('.')`              -> silent return
 *   'a[*]'    -> no `[*].` match, falls through to lodash get    -> undefined
 *   'a..b'    -> lodash get on a malformed path                  -> undefined
 *
 * A rule that never fires is the worst kind of bug in a redaction pipeline: the
 * config looks correct, the output looks plausible, and the PII ships anyway.
 * This parser rejects those patterns at compile time with a precise pointer.
 *
 * The parser also returns *target references* (`{parent, key, path}`) instead of
 * path strings, so the engine never depends on lodash `set()` semantics and can
 * never accidentally create a key that did not exist in the input.
 */

const { FORBIDDEN_KEYS } = require('./RuleSchema');

const PATTERN_ERRORS = Object.freeze({
  NOT_STRING: 'NOT_STRING',
  EMPTY: 'EMPTY',
  FORBIDDEN_KEY: 'FORBIDDEN_KEY',
  BARE_STAR: 'BARE_STAR',
  RECURSIVE_WITH_SEPARATOR: 'RECURSIVE_WITH_SEPARATOR',
  RECURSIVE_BAD_NAME: 'RECURSIVE_BAD_NAME',
  EMPTY_SEGMENT: 'EMPTY_SEGMENT',
  WILDCARD_NOT_LAST: 'WILDCARD_NOT_LAST',
  WILDCARD_IN_MIDDLE_OF_NAME: 'WILDCARD_IN_MIDDLE_OF_NAME',
  INDEX_AFTER_INDEX: 'INDEX_AFTER_INDEX',
  INDEX_SYNTAX: 'INDEX_SYNTAX',
  BAD_CHARACTER: 'BAD_CHARACTER',
});

function fail(reason, detail) {
  return { ok: false, error: { reason, detail } };
}

/**
 * Parse a field pattern into a structured descriptor.
 * @param {string} raw
 * @returns {{ok:true, parsed:object} | {ok:false, error:{reason:string, detail:string}}}
 */
function parseFieldPattern(raw) {
  if (typeof raw !== 'string') {
    return fail(PATTERN_ERRORS.NOT_STRING, `expected a string, received ${typeOf(raw)}`);
  }
  const s = raw.trim();
  if (s.length === 0) {
    return fail(PATTERN_ERRORS.EMPTY, 'field pattern must not be empty or whitespace');
  }
  for (const forbidden of FORBIDDEN_KEYS) {
    if (s.includes(forbidden)) {
      return fail(
        PATTERN_ERRORS.FORBIDDEN_KEY,
        `pattern must not contain the reserved key "${forbidden}" (prototype pollution guard)`
      );
    }
  }
  if (s.includes('*') && s.indexOf('*') !== 0 && !s.includes('[*]') && !s.includes('.*')) {
    return fail(
      PATTERN_ERRORS.WILDCARD_IN_MIDDLE_OF_NAME,
      `'*' may only appear as the leading character ('*name') or as a trailing '.*' segment`
    );
  }

  // ---- recursive form: *fieldName (no dots, no brackets, no second star) ----
  if (s[0] === '*') {
    if (s === '*') {
      return fail(
        PATTERN_ERRORS.BARE_STAR,
        `bare '*' is ambiguous; use '.*' for a single level or '*name' for recursive name matching`
      );
    }
    const name = s.slice(1);
    if (name.includes('.') || name.includes('[') || name.includes('*')) {
      return fail(
        PATTERN_ERRORS.RECURSIVE_WITH_SEPARATOR,
        `recursive pattern '*${name}' must be a bare field name with no '.', '[' or second '*'. ` +
          `For nested paths declare a separate path rule (e.g. "a.b.name") instead.`
      );
    }
    if (!/^[A-Za-z_$\u00a1-\uffff][\w$\-\u00a1-\uffff]*$/.test(name)) {
      return fail(
        PATTERN_ERRORS.RECURSIVE_BAD_NAME,
        `'${name}' is not a valid field name for a recursive pattern`
      );
    }
    return { ok: true, parsed: { type: 'recursive', name, raw: s } };
  }

  // ---- path form: a.b, a[*].b, a.* ----
  if (/\[\*(?!\])/.test(s) || (s.includes('[') && !/\[\*\]/.test(s))) {
    return fail(
      PATTERN_ERRORS.INDEX_SYNTAX,
      `array wildcards must be written exactly as '[*]' (received '${s}')`
    );
  }
  if (s.includes('[*][*]')) {
    return fail(
      PATTERN_ERRORS.INDEX_AFTER_INDEX,
      'consecutive [*] segments are not supported; one array level per pattern'
    );
  }

  const chunks = s.split('[*]');
  const segments = [];

  for (let ci = 0; ci < chunks.length; ci++) {
    let body = chunks[ci];
    const isFirst = ci === 0;
    const isBeforeIndex = ci < chunks.length - 1;

    if (!isFirst) {
      if (body.length === 0) {
        return fail(
          PATTERN_ERRORS.EMPTY_SEGMENT,
          `pattern '${s}' ends with '[*]'; append a field name (e.g. '${s}.id') or drop the '[*]'`
        );
      }
      if (body[0] !== '.') {
        return fail(
          PATTERN_ERRORS.EMPTY_SEGMENT,
          `segment after '[*]' must start with '.' (received '${body}')`
        );
      }
      body = body.slice(1);
    }

    if (isBeforeIndex) {
      if (body.length === 0) {
        if (isFirst) {
          // '[*].x' means "the document root is the array". Upstream could not
          // express this at all; here it is explicit rather than silently dead.
          segments.push({ kind: 'index' });
          continue;
        }
        return fail(
          PATTERN_ERRORS.EMPTY_SEGMENT,
          `pattern '${s}' contains an empty segment before '[*]'`
        );
      }
      if (body.endsWith('.')) {
        return fail(PATTERN_ERRORS.EMPTY_SEGMENT, `empty segment before '[*]' in '${s}'`);
      }
    }

    if (body.length === 0 && !isBeforeIndex) {
      return fail(PATTERN_ERRORS.EMPTY_SEGMENT, `trailing '.' in pattern '${s}'`);
    }

    const parts = body.split('.');
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      if (part.length === 0) {
        return fail(
          PATTERN_ERRORS.EMPTY_SEGMENT,
          `pattern '${s}' contains an empty path segment ('..' or a leading/trailing '.')`
        );
      }
      if (part === '*') {
        const isVeryLast = isBeforeIndex === false && ci === chunks.length - 1 && pi === parts.length - 1;
        if (!isVeryLast) {
          return fail(
            PATTERN_ERRORS.WILDCARD_NOT_LAST,
            `'.*' must be the final segment of a pattern (received '${s}')`
          );
        }
        segments.push({ kind: 'leaves', name: '*' });
        continue;
      }
      if (part.includes('*')) {
        return fail(
          PATTERN_ERRORS.WILDCARD_IN_MIDDLE_OF_NAME,
          `'*' inside a path segment is not supported (received '${part}' in '${s}')`
        );
      }
      if (/[[\]]/.test(part)) {
        return fail(
          PATTERN_ERRORS.BAD_CHARACTER,
          `unexpected bracket in segment '${part}' of pattern '${s}'`
        );
      }
      segments.push({ kind: 'key', name: part });
    }

    if (isBeforeIndex) {
      segments.push({ kind: 'index' });
    }
  }

  if (segments.length === 0) {
    return fail(PATTERN_ERRORS.EMPTY, 'field pattern produced no segments');
  }

  return { ok: true, parsed: { type: 'path', segments, raw: s } };
}

/**
 * Render a parsed pattern back to its canonical form (used by `explain()`).
 */
function describePattern(parsed) {
  if (!parsed) return '';
  if (parsed.type === 'recursive') return `*${parsed.name}`;
  return parsed.segments
    .map((seg) => {
      if (seg.kind === 'index') return '[*]';
      if (seg.kind === 'leaves') return '.*';
      return seg.name;
    })
    .reduce((acc, piece) => {
      if (piece === '[*]') return acc + '[*]';
      if (piece === '.*') return acc + '.*';
      return acc ? acc + '.' + piece : piece;
    }, '');
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Collect every concrete target matched by a parsed pattern.
 *
 * Returns `{parent, key, path}` references so callers can read and write the
 * value without re-parsing a path string. Non-existent paths yield an empty
 * array (never an implicit key creation).
 */
function collectTargets(root, parsed) {
  const out = [];
  if (!parsed) return out;

  if (parsed.type === 'recursive') {
    collectByName(root, parsed.name, '', out);
    return out;
  }

  walk(root, null, null, '', 0, parsed.segments, out);
  return out;
}

function walk(value, parent, key, path, index, segments, out) {
  const seg = segments[index];
  if (!seg) return;
  const isLast = index === segments.length - 1;

  if (seg.kind === 'leaves') {
    collectLeaves(value, parent, key, path, out);
    return;
  }

  if (seg.kind === 'index') {
    if (!Array.isArray(value)) return;
    for (let i = 0; i < value.length; i++) {
      const childPath = `${path}[${i}]`;
      if (isLast) {
        out.push({ parent: value, key: i, path: childPath });
      } else {
        walk(value[i], value, i, childPath, index + 1, segments, out);
      }
    }
    return;
  }

  if (value === null || typeof value !== 'object') return;
  if (!Object.prototype.hasOwnProperty.call(value, seg.name)) return;
  const childPath = path ? `${path}.${seg.name}` : seg.name;
  if (isLast) {
    out.push({ parent: value, key: seg.name, path: childPath });
  } else {
    walk(value[seg.name], value, seg.name, childPath, index + 1, segments, out);
  }
}

/**
 * Mirror of upstream `getNestedKeys`: expand a container into all of its leaves.
 * A primitive container is itself a leaf (upstream short-circuits on strings the
 * same way).
 */
function collectLeaves(node, parent, key, path, out) {
  if (node === null || node === undefined) return;
  if (typeof node !== 'object') {
    if (parent !== null && parent !== undefined) {
      out.push({ parent, key, path });
    }
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      collectLeaves(node[i], node, i, `${path}[${i}]`, out);
    }
    return;
  }
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const childPath = path ? `${path}.${k}` : k;
    collectLeaves(node[k], node, k, childPath, out);
  }
}

function collectByName(node, name, path, out) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      collectByName(node[i], name, `${path}[${i}]`, out);
    }
    return;
  }
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = node[k];
    if (v === null || v === undefined) continue;
    const childPath = path ? `${path}.${k}` : k;
    if (k === name && typeof v !== 'object') {
      out.push({ parent: node, key: k, path: childPath });
    } else if (typeof v === 'object') {
      collectByName(v, name, childPath, out);
    }
  }
}

module.exports = {
  parseFieldPattern,
  describePattern,
  collectTargets,
  PATTERN_ERRORS,
};
