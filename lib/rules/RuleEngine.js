'use strict';

/**
 * Rule engine: executes a compiled plan against a JSON document.
 *
 * Contract:
 *   - the input document is never mutated (a structural clone is produced first)
 *   - rules run in exactly the order reported by `plan.explain()`
 *   - each rule dispatches to the *unchanged upstream* mask service, so masking
 *     results are identical to `maskJSON2` for equivalent configurations
 *   - every failure surfaces as a `MaskRuleError`; the upstream habit of
 *     `throw "string"` (no message, no stack, not an Error) is normalised here
 */

const { collectTargets } = require('./FieldPattern');
const { MaskRuleError, ERROR_CODES } = require('./MaskRuleError');

const DEFAULT_MAX_TRACE_ENTRIES = 1000;

function cloneDocument(input) {
  if (input === null || typeof input !== 'object') {
    throw new MaskRuleError(
      `mask input must be an object or array, received ${input === null ? 'null' : typeof input}`,
      {
        code: ERROR_CODES.MASK_INPUT,
        hint: 'maskJSON3 masks fields inside a JSON document; use the single-value helpers for scalars.',
      }
    );
  }
  try {
    return JSON.parse(JSON.stringify(input));
  } catch (err) {
    throw new MaskRuleError(
      `mask input is not JSON-serialisable: ${err && err.message ? err.message : String(err)}`,
      {
        code: ERROR_CODES.MASK_INPUT,
        hint: 'Circular references and BigInt values cannot be cloned; maskJSON2 returned the original object unchanged in this situation, which silently skipped all redaction.',
      }
    );
  }
}

function cloneOptions(options) {
  const copy = Object.assign({}, options);
  if (Array.isArray(copy.values)) copy.values = copy.values.slice();
  return copy;
}

function normaliseUpstreamError(err, rule, maskPath) {
  // Upstream throws a plain string from BadOption.throwBadOptionException().
  const raw = typeof err === 'string' ? err : err && err.message ? err.message : String(err);
  return new MaskRuleError(
    `mask "${rule.kind}" failed on field "${maskPath}": ${raw}`,
    {
      code: ERROR_CODES.MASK_RUNTIME,
      pointer: rule.pointer,
      maskPath,
      ruleIndex: rule.index,
      ruleId: rule.id,
      hint: 'The upstream mask service rejected one of the resolved options for this rule.',
    }
  );
}

/**
 * Execute a compiled plan.
 * @param {object} document
 * @param {object} plan result of compile()
 * @param {{trace?:boolean, maxTraceEntries?:number}} [options]
 * @returns {{result:any, trace:object}}
 */
function runPlan(document, plan, options) {
  const opts = options || {};
  const wantTrace = opts.trace !== false; // trace is cheap and makes ordering auditable
  const maxEntries =
    typeof opts.maxTraceEntries === 'number' && opts.maxTraceEntries > 0
      ? opts.maxTraceEntries
      : DEFAULT_MAX_TRACE_ENTRIES;

  const result = cloneDocument(document);

  const hitByPath = new Map(); // path -> [{ruleId, order, position}]
  const conflicts = [];
  const traceRules = [];

  plan.rules.forEach((rule, position) => {
    const targets = [];
    // A single rule may list several overlapping patterns (e.g.
    // "profile.contact.email" plus "*email"). Masking the same field twice with
    // the same options is not idempotent in general (the second pass sees the
    // already-masked text), so each target is applied exactly once per rule.
    const claimed = new Map(); // parent object -> Set of keys already queued
    for (const field of rule.fields) {
      const found = collectTargets(result, field.parsed);
      for (const t of found) {
        let keys = claimed.get(t.parent);
        if (!keys) {
          keys = new Set();
          claimed.set(t.parent, keys);
        }
        if (keys.has(t.key)) continue;
        keys.add(t.key);
        targets.push(Object.assign({ fieldPointer: field.pointer, pattern: field.raw }, t));
      }
    }

    const ruleTrace = {
      position,
      id: rule.id,
      kind: rule.kind,
      order: rule.order,
      fields: rule.fields.map((f) => f.raw),
      matchedCount: 0,
      changedCount: 0,
      matched: [],
      truncated: false,
    };

    const optionsForRule = cloneOptions(rule.options);

    for (const target of targets) {
      const value = target.parent[target.key];
      if (value === null || value === undefined) continue;

      ruleTrace.matchedCount += 1;
      if (wantTrace) {
        if (ruleTrace.matched.length < maxEntries) {
          ruleTrace.matched.push(target.path);
        } else {
          ruleTrace.truncated = true;
        }
      }

      // runtime overlap detection: two rules at the same order touching the same field
      const previous = hitByPath.get(target.path);
      if (previous) {
        for (const p of previous) {
          if (p.order === rule.order && p.position !== position) {
            conflicts.push({
              path: target.path,
              order: rule.order,
              ruleIds: [p.ruleId, rule.id],
            });
          }
        }
        previous.push({ ruleId: rule.id, order: rule.order, position });
      } else {
        hitByPath.set(target.path, [{ ruleId: rule.id, order: rule.order, position }]);
      }

      let masked;
      try {
        masked = rule.masker(value, optionsForRule);
      } catch (err) {
        throw normaliseUpstreamError(err, rule, target.path);
      }

      if (masked !== value) {
        target.parent[target.key] = masked;
        ruleTrace.changedCount += 1;
      }
    }

    traceRules.push(ruleTrace);
  });

  if (conflicts.length > 0) {
    const unique = [];
    const seen = new Set();
    for (const c of conflicts) {
      const key = `${c.order}|${c.path}|${c.ruleIds.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(c);
    }
    const message =
      `execution order conflict: ${unique.length} field(s) matched by more than one rule at the same order. ` +
      unique
        .slice(0, 5)
        .map((c) => `"${c.path}" <- rules [${c.ruleIds.join(', ')}] (order ${c.order})`)
        .join('; ') +
      (unique.length > 5 ? `; and ${unique.length - 5} more` : '');

    if (plan.onConflict === 'error') {
      throw new MaskRuleError(message, {
        code: ERROR_CODES.RULE_ORDER_CONFLICT,
        hint:
          'Give the rules different `order` values to make precedence explicit, merge them into one rule, ' +
          'or set onConflict to "warn"/"allow".',
        issues: unique.map((c) => ({
          code: ERROR_CODES.RULE_ORDER_CONFLICT,
          pointer: '',
          maskPath: c.path,
          message: `matched by rules [${c.ruleIds.join(', ')}] at order ${c.order}`,
        })),
      });
    }
    if (plan.onConflict === 'warn') {
      traceRules.push({
        warning: true,
        code: ERROR_CODES.RULE_ORDER_CONFLICT,
        message,
        conflicts: unique,
      });
    }
  }

  return {
    result,
    trace: {
      onConflict: plan.onConflict,
      warnings: plan.warnings,
      conflicts,
      rules: traceRules,
    },
  };
}

module.exports = {
  runPlan,
  cloneDocument,
};
