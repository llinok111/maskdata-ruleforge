'use strict';

/**
 * Rule compiler: turns a declarative rule set into an immutable, fully validated
 * execution plan.
 *
 * Responsibilities, in order:
 *   1. Shape validation      - unknown keys are hard errors (upstream silently ignored them)
 *   2. Option validation     - type / range / enum, with a JSON Pointer per failure
 *   3. Safe value validation - no functions, no RegExp, no prototype-pollution keys
 *   4. Default resolution    - kind defaults < ruleSet.defaults < rule.options
 *   5. Deterministic order   - explicit `order`, tie-broken by declaration index
 *   6. Conflict detection    - two rules at the same order hitting the same field is an error
 *
 * Validation deliberately does NOT fail fast: every issue is collected and thrown
 * together, so one compile run tells the operator everything that needs fixing.
 */

const { KINDS, KIND_NAMES, RULE_KEYS, RULE_SET_KEYS, FORBIDDEN_KEYS, SUPPORTED_VERSION } =
  require('./RuleSchema');
const { MaskRuleError, ERROR_CODES, toPointer } = require('./MaskRuleError');
const { parseFieldPattern, describePattern } = require('./FieldPattern');

const CONFLICT_POLICIES = ['error', 'warn', 'allow'];

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof RegExp) return 'regexp';
  return typeof value;
}

function makeIssue(code, pointerSegments, message, extra) {
  return Object.assign(
    {
      code,
      pointer: toPointer(pointerSegments),
      message,
    },
    extra || {}
  );
}

/**
 * Detect values that a config file must never carry.
 * This is the guardrail that keeps "declarative rules" declarative: a rule set is
 * data, never code, so there is no `eval`/`new Function` surface to exploit.
 */
function scanUnsafeValue(value, pointerSegments, issues, label) {
  if (typeof value === 'function') {
    issues.push(
      makeIssue(
        ERROR_CODES.RULE_UNSAFE_VALUE,
        pointerSegments,
        `${label} is a function; rule sets are data only (no executable callbacks allowed)`,
        { hint: 'Use a built-in kind plus declarative options instead of a callback.' }
      )
    );
    return;
  }
  if (typeof value === 'symbol') {
    issues.push(
      makeIssue(ERROR_CODES.RULE_UNSAFE_VALUE, pointerSegments, `${label} is a Symbol, which is not serialisable`)
    );
    return;
  }
  if (value instanceof RegExp || Object.prototype.toString.call(value) === '[object RegExp]') {
    issues.push(
      makeIssue(
        ERROR_CODES.RULE_UNSAFE_VALUE,
        pointerSegments,
        `${label} is a RegExp instance; rule sets must be JSON-serialisable`,
        { hint: 'RegExp objects are rejected so the same rule set behaves identically after JSON round-trip.' }
      )
    );
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanUnsafeValue(value[i], pointerSegments.concat(i), issues, `${label}[${i}]`);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.includes(key)) {
        issues.push(
          makeIssue(
            ERROR_CODES.RULE_UNSAFE_VALUE,
            pointerSegments.concat(key),
            `reserved key "${key}" is not allowed in a rule set (prototype pollution guard)`
          )
        );
        continue;
      }
      scanUnsafeValue(value[key], pointerSegments.concat(key), issues, `${label}.${key}`);
    }
  }
}

function validateOptionValue(optionName, descriptor, value, pointerSegments, sink, context) {
  // Stamp the owning rule onto every issue so a failure always says *which* rule
  // produced it. Using a local helper (instead of a trailing backfill loop) keeps
  // the early `return` statements below from silently dropping the context.
  const push = (code, ptr, message, extra) => {
    sink.push(makeIssue(code, ptr, message, Object.assign({}, extra, context)));
  };

  if (value === undefined) {
    if (descriptor.optional) return;
    push(ERROR_CODES.RULE_OPTION_TYPE, pointerSegments, `option "${optionName}" must not be undefined`, {
      hint: descriptor.describe,
    });
    return;
  }
  if (value === null) {
    push(
      ERROR_CODES.RULE_OPTION_TYPE,
      pointerSegments,
      `option "${optionName}" must not be null; omit the key to use the default value`
    );
    return;
  }

  const expected = descriptor.type;

  if (expected === 'string') {
    if (typeof value !== 'string') {
      push(
        ERROR_CODES.RULE_OPTION_TYPE,
        pointerSegments,
        `option "${optionName}" must be a string, received ${typeOf(value)}`
      );
      return;
    }
    if (descriptor.minLength !== undefined && value.length < descriptor.minLength) {
      push(
        ERROR_CODES.RULE_OPTION_RANGE,
        pointerSegments,
        `option "${optionName}" must be at least ${descriptor.minLength} character(s) long, received ${JSON.stringify(value)}`,
        { value }
      );
    }
    return;
  }

  if (expected === 'string[]') {
    if (!Array.isArray(value)) {
      push(
        ERROR_CODES.RULE_OPTION_TYPE,
        pointerSegments,
        `option "${optionName}" must be an array of strings, received ${typeOf(value)}`
      );
      return;
    }
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] !== 'string') {
        push(
          ERROR_CODES.RULE_OPTION_TYPE,
          pointerSegments.concat(i),
          `option "${optionName}[${i}]" must be a string, received ${typeOf(value[i])}`
        );
      }
    }
    return;
  }

  if (expected === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      push(
        ERROR_CODES.RULE_OPTION_TYPE,
        pointerSegments,
        `option "${optionName}" must be an integer, received ${
          typeof value === 'number' ? String(value) : typeOf(value)
        }`,
        { value, hint: descriptor.describe }
      );
      return;
    }
    if (descriptor.min !== undefined && value < descriptor.min) {
      push(
        ERROR_CODES.RULE_OPTION_RANGE,
        pointerSegments,
        `option "${optionName}" must be >= ${descriptor.min}, received ${value}`,
        { value }
      );
    }
    if (descriptor.max !== undefined && value > descriptor.max) {
      push(
        ERROR_CODES.RULE_OPTION_RANGE,
        pointerSegments,
        `option "${optionName}" must be <= ${descriptor.max}, received ${value}`,
        { value }
      );
    }
    return;
  }

  if (expected === 'boolean') {
    if (typeof value !== 'boolean') {
      push(
        ERROR_CODES.RULE_OPTION_TYPE,
        pointerSegments,
        `option "${optionName}" must be a boolean, received ${typeOf(value)}`
      );
    }
    return;
  }

  push(
    ERROR_CODES.RULE_SET_SHAPE,
    pointerSegments,
    `internal: unknown descriptor type "${expected}" for option "${optionName}"`
  );
}

/**
 * Merge defaults without mutating any input object.
 */
function resolveOptions(kindName, globalDefaults, ruleOptions) {
  const kind = KINDS[kindName];
  const resolved = {};
  const layers = [kind.defaults, globalDefaults || {}, ruleOptions || {}];
  for (const layer of layers) {
    for (const key of Object.keys(layer)) {
      if (!Object.prototype.hasOwnProperty.call(kind.spec, key)) continue;
      const value = layer[key];
      if (value === undefined) continue;
      resolved[key] = Array.isArray(value) ? value.slice() : value;
    }
  }
  // Fill anything still missing from kind defaults (e.g. `values: []`).
  for (const key of Object.keys(kind.spec)) {
    if (resolved[key] === undefined && kind.defaults[key] !== undefined) {
      const d = kind.defaults[key];
      resolved[key] = Array.isArray(d) ? d.slice() : d;
    }
  }
  return resolved;
}

/**
 * Compile a rule set.
 * @param {object} ruleSet
 * @param {{onConflict?:'error'|'warn'|'allow'}} [options]
 * @returns {object} frozen plan
 */
function compile(ruleSet, options) {
  const issues = [];
  const warnings = [];

  if (!isPlainObject(ruleSet)) {
    throw MaskRuleError.fromIssues(
      [
        makeIssue(
          ERROR_CODES.RULE_SET_SHAPE,
          [],
          `rule set must be a plain object, received ${typeOf(ruleSet)}`,
          { hint: 'Expected { version: 1, rules: [ ... ] }' }
        ),
      ],
      'Invalid rule set'
    );
  }

  // --- root keys ---
  for (const key of Object.keys(ruleSet)) {
    if (!RULE_SET_KEYS.includes(key)) {
      issues.push(
        makeIssue(
          ERROR_CODES.RULE_UNKNOWN_KEY,
          [key],
          `unknown rule-set key "${key}"`,
          { hint: `allowed keys: ${RULE_SET_KEYS.join(', ')}` }
        )
      );
    }
  }

  if (ruleSet.version !== undefined && ruleSet.version !== SUPPORTED_VERSION) {
    issues.push(
      makeIssue(
        ERROR_CODES.RULE_SET_VERSION,
        ['version'],
        `unsupported rule-set version ${JSON.stringify(ruleSet.version)}; this build supports ${SUPPORTED_VERSION}`
      )
    );
  }

  let onConflict = (options && options.onConflict) || ruleSet.onConflict || 'error';
  if (!CONFLICT_POLICIES.includes(onConflict)) {
    issues.push(
      makeIssue(
        ERROR_CODES.RULE_SET_SHAPE,
        ['onConflict'],
        `onConflict must be one of ${CONFLICT_POLICIES.join('|')}, received ${JSON.stringify(onConflict)}`
      )
    );
    onConflict = 'error';
  }

  // --- defaults ---
  let globalDefaults = {};
  if (ruleSet.defaults !== undefined) {
    if (!isPlainObject(ruleSet.defaults)) {
      issues.push(
        makeIssue(
          ERROR_CODES.RULE_SET_SHAPE,
          ['defaults'],
          `defaults must be a plain object, received ${typeOf(ruleSet.defaults)}`
        )
      );
    } else {
      scanUnsafeValue(ruleSet.defaults, ['defaults'], issues, 'defaults');
      const knownOptionNames = new Set();
      for (const kindName of KIND_NAMES) {
        for (const optName of Object.keys(KINDS[kindName].spec)) knownOptionNames.add(optName);
      }
      for (const key of Object.keys(ruleSet.defaults)) {
        if (!knownOptionNames.has(key)) {
          issues.push(
            makeIssue(
              ERROR_CODES.RULE_OPTION_UNKNOWN,
              ['defaults', key],
              `unknown default option "${key}"; no mask kind accepts it`,
              { hint: `known options: ${Array.from(knownOptionNames).sort().join(', ')}` }
            )
          );
        }
      }
      globalDefaults = ruleSet.defaults;
      // Validate each default exactly once, against every kind that accepts it,
      // so a single bad default does not produce one error per rule.
      for (const optName of Object.keys(globalDefaults)) {
        const reported = new Set();
        for (const kindName of KIND_NAMES) {
          const spec = KINDS[kindName].spec;
          if (!Object.prototype.hasOwnProperty.call(spec, optName)) continue;
          const signature = `${spec[optName].type}|${spec[optName].min}|${spec[optName].max}|${spec[optName].minLength}|${spec[optName].optional}`;
          if (reported.has(signature)) continue;
          reported.add(signature);
          validateOptionValue(optName, spec[optName], globalDefaults[optName], ['defaults', optName], issues);
        }
      }
    }
  }

  // --- rules ---
  if (!Array.isArray(ruleSet.rules)) {
    issues.push(
      makeIssue(
        ERROR_CODES.RULE_SET_SHAPE,
        ['rules'],
        `rules must be an array, received ${typeOf(ruleSet.rules)}`
      )
    );
    throw MaskRuleError.fromIssues(issues, 'Invalid rule set');
  }
  if (ruleSet.rules.length === 0) {
    issues.push(
      makeIssue(
        ERROR_CODES.RULE_FIELDS_EMPTY,
        ['rules'],
        'rules must contain at least one rule; an empty rule set would leave every field unmasked'
      )
    );
  }

  const seenIds = new Map();
  const compiledRules = [];

  ruleSet.rules.forEach((rule, ruleIndex) => {
    const base = ['rules', ruleIndex];

    if (!isPlainObject(rule)) {
      issues.push(
        makeIssue(
          ERROR_CODES.RULE_SHAPE,
          base,
          `rule must be a plain object, received ${typeOf(rule)}`,
          { ruleIndex }
        )
      );
      return;
    }

    for (const key of Object.keys(rule)) {
      if (!RULE_KEYS.includes(key)) {
        issues.push(
          makeIssue(
            ERROR_CODES.RULE_UNKNOWN_KEY,
            base.concat(key),
            `unknown rule key "${key}"`,
            {
              ruleIndex,
              hint: `allowed keys: ${RULE_KEYS.join(', ')}. Upstream-style keys such as "<kind>Fields" are not valid here; use { kind, fields }.`,
            }
          )
        );
      }
    }

    // kind
    const kindName = rule.kind;
    if (typeof kindName !== 'string' || !KIND_NAMES.includes(kindName)) {
      issues.push(
        makeIssue(
          ERROR_CODES.RULE_KIND_UNKNOWN,
          base.concat('kind'),
          `unknown mask kind ${JSON.stringify(kindName)}`,
          {
            ruleIndex,
            hint: `supported kinds: ${KIND_NAMES.join(', ')}. Unknown kinds used to be silently ignored upstream.`,
          }
        )
      );
      return;
    }
    const kind = KINDS[kindName];

    // id
    let ruleId;
    if (rule.id !== undefined) {
      if (typeof rule.id !== 'string' || rule.id.trim().length === 0) {
        issues.push(
          makeIssue(ERROR_CODES.RULE_SHAPE, base.concat('id'), 'rule id must be a non-empty string', {
            ruleIndex,
          })
        );
      } else {
        ruleId = rule.id;
        if (seenIds.has(ruleId)) {
          issues.push(
            makeIssue(
              ERROR_CODES.RULE_SHAPE,
              base.concat('id'),
              `duplicate rule id "${ruleId}" (first declared at /rules/${seenIds.get(ruleId)})`,
              { ruleIndex, ruleId }
            )
          );
        } else {
          seenIds.set(ruleId, ruleIndex);
        }
      }
    }
    const effectiveId = ruleId || `rule${ruleIndex}`;

    // order
    let order = kind.defaultOrder;
    if (rule.order !== undefined) {
      if (typeof rule.order !== 'number' || !Number.isFinite(rule.order) || !Number.isInteger(rule.order)) {
        issues.push(
          makeIssue(
            ERROR_CODES.RULE_SHAPE,
            base.concat('order'),
            `order must be an integer, received ${
              typeof rule.order === 'number' ? String(rule.order) : typeOf(rule.order)
            }`,
            { ruleIndex, ruleId: effectiveId, hint: 'Lower numbers execute first; ties are broken by declaration index.' }
          )
        );
      } else {
        order = rule.order;
      }
    }

    // description
    if (rule.description !== undefined && typeof rule.description !== 'string') {
      issues.push(
        makeIssue(
          ERROR_CODES.RULE_SHAPE,
          base.concat('description'),
          'description must be a string',
          { ruleIndex, ruleId: effectiveId }
        )
      );
    }

    // fields
    const fields = [];
    if (!Array.isArray(rule.fields)) {
      issues.push(
        makeIssue(
          ERROR_CODES.RULE_SHAPE,
          base.concat('fields'),
          `fields must be an array of field patterns, received ${typeOf(rule.fields)}`,
          { ruleIndex, ruleId: effectiveId }
        )
      );
    } else if (rule.fields.length === 0) {
      issues.push(
        makeIssue(
          ERROR_CODES.RULE_FIELDS_EMPTY,
          base.concat('fields'),
          'fields must contain at least one pattern',
          { ruleIndex, ruleId: effectiveId }
        )
      );
    } else {
      rule.fields.forEach((pattern, fieldIndex) => {
        const result = parseFieldPattern(pattern);
        if (!result.ok) {
          issues.push(
            makeIssue(
              ERROR_CODES.RULE_FIELD_PATTERN,
              base.concat(['fields', fieldIndex]),
              `invalid field pattern ${JSON.stringify(pattern)}: ${result.error.detail}`,
              {
                ruleIndex,
                ruleId: effectiveId,
                value: pattern,
                hint:
                  'Supported forms: "a.b.c", "a[*].b" (array index wildcard), "a.*" (all leaves, final segment only), "*name" (recursive name match, no dots).',
              }
            )
          );
          return;
        }
        fields.push({ raw: pattern, parsed: result.parsed, pointer: toPointer(base.concat(['fields', fieldIndex])) });
      });
    }

    // options
    let ruleOptions = {};
    if (rule.options !== undefined) {
      if (!isPlainObject(rule.options)) {
        issues.push(
          makeIssue(
            ERROR_CODES.RULE_SHAPE,
            base.concat('options'),
            `options must be a plain object, received ${typeOf(rule.options)}`,
            { ruleIndex, ruleId: effectiveId }
          )
        );
      } else {
        scanUnsafeValue(rule.options, base.concat('options'), issues, 'options');
        for (const optName of Object.keys(rule.options)) {
          if (FORBIDDEN_KEYS.includes(optName)) continue; // already reported by scanUnsafeValue
          if (!Object.prototype.hasOwnProperty.call(kind.spec, optName)) {
            issues.push(
              makeIssue(
                ERROR_CODES.RULE_OPTION_UNKNOWN,
                base.concat(['options', optName]),
                `unknown option "${optName}" for mask kind "${kindName}"`,
                {
                  ruleIndex,
                  ruleId: effectiveId,
                  hint: `allowed options for "${kindName}": ${Object.keys(kind.spec).join(', ')}`,
                }
              )
            );
            continue;
          }
          validateOptionValue(
            optName,
            kind.spec[optName],
            rule.options[optName],
            base.concat(['options', optName]),
            issues,
            { ruleIndex, ruleId: effectiveId }
          );
        }
        ruleOptions = rule.options;
      }
    }

    const resolvedOptions = resolveOptions(kindName, globalDefaults, ruleOptions);

    // "no effect" hint: a string rule that neither masks all characters nor lists values
    // will leave every matched field untouched. Upstream allowed this silently.
    if (kindName === 'string') {
      const values = resolvedOptions.values || [];
      if (resolvedOptions.maskAll !== true && values.length === 0) {
        warnings.push({
          code: ERROR_CODES.RULE_NO_EFFECT,
          pointer: toPointer(base.concat('options')),
          ruleIndex,
          ruleId: effectiveId,
          message:
            'string rule has neither maskAll:true nor any values; matched fields will not be modified',
        });
      }
    }

    if (fields.length > 0) {
      compiledRules.push({
        index: ruleIndex,
        id: effectiveId,
        kind: kindName,
        order,
        description: rule.description,
        fields,
        options: resolvedOptions,
        masker: kind.masker,
        pointer: toPointer(base),
      });
    }
  });

  // --- deterministic ordering: order asc, then declaration index asc ---
  compiledRules.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.index - b.index;
  });

  // --- static overlap hints (patterns that are literally identical) ---
  const byPattern = new Map();
  for (const rule of compiledRules) {
    for (const field of rule.fields) {
      const key = describePattern(field.parsed);
      if (!byPattern.has(key)) byPattern.set(key, []);
      byPattern.get(key).push(rule);
    }
  }
  for (const [pattern, hits] of byPattern.entries()) {
    if (hits.length < 2) continue;
    const orders = new Set(hits.map((r) => r.order));
    const ids = hits.map((r) => r.id).join(', ');
    if (orders.size === 1) {
      warnings.push({
        code: ERROR_CODES.RULE_ORDER_CONFLICT,
        message:
          `pattern "${pattern}" is claimed by rules [${ids}] at the same order ${hits[0].order}; ` +
          `they will run in declaration order and later rules see already-masked values`,
      });
    } else {
      warnings.push({
        code: ERROR_CODES.RULE_ORDER_CONFLICT,
        message:
          `pattern "${pattern}" is claimed by rules [${ids}] at different orders ` +
          `(${Array.from(orders).sort((a, b) => a - b).join(' -> ')}); the later rule sees the earlier rule's output`,
      });
    }
  }

  if (issues.length > 0) {
    throw MaskRuleError.fromIssues(issues, 'Rule set validation failed');
  }

  const plan = {
    version: SUPPORTED_VERSION,
    onConflict,
    warnings,
    rules: compiledRules,
  };
  Object.defineProperty(plan, 'explain', {
    value: () => explainPlan(plan),
    enumerable: false,
  });
  Object.defineProperty(plan, 'isEmpty', {
    value: () => compiledRules.length === 0,
    enumerable: false,
  });
  return Object.freeze(plan);
}

/**
 * Human- and machine-readable description of what the plan will do, in order.
 * This is the "predictable execution order" contract: whatever `explain()` prints
 * is exactly the order the engine executes.
 */
function explainPlan(plan) {
  return plan.rules.map((rule, position) => ({
    position,
    id: rule.id,
    kind: rule.kind,
    order: rule.order,
    fields: rule.fields.map((f) => f.raw),
    options: Object.assign({}, rule.options),
    description: rule.description,
  }));
}

/**
 * Duck-type a compiled plan so `maskJSON3(json, plan)` works without the caller
 * having to remember the `{ plan }` option. A rule set can never look like a plan
 * because only the engine attaches `masker` functions.
 */
function isCompiledPlan(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.rules)) return false;
  if (value.rules.length === 0) return false;
  return value.rules.every(
    (rule) => rule && typeof rule.masker === 'function' && Array.isArray(rule.fields)
  );
}

module.exports = {
  compile,
  explainPlan,
  resolveOptions,
  isCompiledPlan,
  CONFLICT_POLICIES,
};
