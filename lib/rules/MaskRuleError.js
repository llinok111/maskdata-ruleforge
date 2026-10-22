'use strict';

/**
 * Structured error type for the declarative rule layer.
 *
 * Why this exists:
 * The upstream `BadOption` handler throws a *string*
 * (`throw \`Bad config value : ...\``), which means `catch (e)` sees
 * `e.message === undefined`, `e.stack === undefined`, and `e instanceof Error === false`.
 * Callers cannot reliably branch on the failure, and CI logs lose the location.
 *
 * Every error raised by this layer is a real `Error` with:
 *   - `code`      machine-readable category (stable, safe to switch on)
 *   - `pointer`   RFC 6901 JSON Pointer into the *rule set document* (e.g. `/rules/1/options/maskWith`)
 *   - `maskPath`  the data path being masked when the failure happened (e.g. `user.phone`)
 *   - `ruleIndex` / `ruleId`  which rule produced the failure
 *   - `issues`    aggregated list, so validation reports *all* problems at once
 *                 instead of failing on the first one
 */

const ERROR_CODES = Object.freeze({
  RULE_SET_SHAPE: 'RULE_SET_SHAPE',
  RULE_SET_VERSION: 'RULE_SET_VERSION',
  RULE_SHAPE: 'RULE_SHAPE',
  RULE_UNKNOWN_KEY: 'RULE_UNKNOWN_KEY',
  RULE_KIND_UNKNOWN: 'RULE_KIND_UNKNOWN',
  RULE_OPTION_UNKNOWN: 'RULE_OPTION_UNKNOWN',
  RULE_OPTION_TYPE: 'RULE_OPTION_TYPE',
  RULE_OPTION_RANGE: 'RULE_OPTION_RANGE',
  RULE_FIELDS_EMPTY: 'RULE_FIELDS_EMPTY',
  RULE_FIELD_PATTERN: 'RULE_FIELD_PATTERN',
  RULE_ORDER_CONFLICT: 'RULE_ORDER_CONFLICT',
  RULE_UNSAFE_VALUE: 'RULE_UNSAFE_VALUE',
  RULE_NO_EFFECT: 'RULE_NO_EFFECT',
  MASK_INPUT: 'MASK_INPUT',
  MASK_RUNTIME: 'MASK_RUNTIME',
});

/**
 * Escape a single path segment for use inside a JSON Pointer (RFC 6901).
 */
function escapePointerSegment(segment) {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Build a JSON Pointer from path segments.
 */
function toPointer(segments) {
  if (!segments || segments.length === 0) return '';
  return segments.map((s) => '/' + escapePointerSegment(s)).join('');
}

class MaskRuleError extends Error {
  /**
   * @param {string} message human readable summary
   * @param {object} details
   */
  constructor(message, details) {
    super(message);
    this.name = 'MaskRuleError';
    const d = details || {};
    this.code = d.code || 'RULE_SET_SHAPE';
    this.pointer = d.pointer || '';
    this.maskPath = d.maskPath;
    this.ruleIndex = d.ruleIndex;
    this.ruleId = d.ruleId;
    this.value = d.value;
    this.hint = d.hint;
    this.issues = d.issues || [];
    // Keep stack pointing at user call sites rather than this constructor.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MaskRuleError);
    }
  }

  /**
   * Aggregate several issues into one throwable error.
   * Validation never fails fast: all issues are reported together so a single
   * run tells the operator everything that is wrong with the rule set.
   */
  static fromIssues(issues, summary) {
    const list = Array.isArray(issues) ? issues.slice() : [];
    const first = list[0] || {};
    const head = summary || 'Rule set validation failed';
    const lines = list
      .slice(0, 12)
      .map((i) => `  - [${i.code}] ${i.pointer || '(root)'}: ${i.message}`);
    const more = list.length > 12 ? `\n  ... and ${list.length - 12} more issue(s)` : '';
    const message = `${head} (${list.length} issue${list.length === 1 ? '' : 's'})\n` + lines.join('\n') + more;
    const err = new MaskRuleError(message, {
      code: first.code,
      pointer: first.pointer,
      maskPath: first.maskPath,
      ruleIndex: first.ruleIndex,
      ruleId: first.ruleId,
      value: first.value,
      hint: first.hint,
      issues: list,
    });
    return err;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      pointer: this.pointer,
      maskPath: this.maskPath,
      ruleIndex: this.ruleIndex,
      ruleId: this.ruleId,
      hint: this.hint,
      issues: this.issues,
    };
  }
}

module.exports = {
  MaskRuleError,
  ERROR_CODES,
  toPointer,
  escapePointerSegment,
};
