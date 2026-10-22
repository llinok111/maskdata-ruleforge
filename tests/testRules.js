'use strict';

/**
 * Tests for the declarative rule layer (maskJSON3 / compileRules).
 *
 * Grouping mirrors the guarantees the layer claims:
 *   A. validation      - every malformed rule is rejected with a located error
 *   B. safety          - rule sets are data, never code
 *   C. defaults        - three-layer resolution is observable
 *   D. ordering        - execution order is explicit and stable
 *   E. conflicts       - same-order collisions are surfaced, not silenced
 *   F. masking parity  - output matches the untouched upstream implementation
 *   G. robustness      - input immutability, truncation, frozen plans
 */

const maskData = require('../index');
const expect = require('chai').expect;

const MaskRuleError = maskData.RuleError;

/** Run fn and return the thrown MaskRuleError (fails the test if nothing throws). */
function captureError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a MaskRuleError but nothing was thrown');
}

function pointers(err) {
  return err.issues.map((i) => i.pointer);
}

function codes(err) {
  return err.issues.map((i) => i.code);
}

describe('Declarative rule layer', function () {
  // =========================================================================
  describe('A. Rule validation and error location', function () {
    it('rejects a non-object rule set', function () {
      const err = captureError(() => maskData.compileRules([]));
      expect(err).to.be.instanceOf(MaskRuleError);
      expect(err).to.be.instanceOf(Error);
      expect(err.code).to.equal(maskData.ERROR_CODES.RULE_SET_SHAPE);
      expect(err.message).to.contain('plain object');
    });

    it('rejects unknown rule-set keys with a root pointer', function () {
      const err = captureError(() => maskData.compileRules({ rules: [{ kind: 'phone', fields: ['a'] }], ipFields: [] }));
      expect(err.code).to.equal(maskData.ERROR_CODES.RULE_UNKNOWN_KEY);
      expect(pointers(err)).to.deep.equal(['/ipFields']);
    });

    it('rejects an unsupported rule-set version', function () {
      const err = captureError(() => maskData.compileRules({ version: 2, rules: [{ kind: 'phone', fields: ['a'] }] }));
      expect(err.code).to.equal(maskData.ERROR_CODES.RULE_SET_VERSION);
      expect(pointers(err)).to.deep.equal(['/version']);
    });

    it('rejects a rule set without rules', function () {
      const err = captureError(() => maskData.compileRules({ rules: [] }));
      expect(err.code).to.equal(maskData.ERROR_CODES.RULE_FIELDS_EMPTY);
      expect(pointers(err)).to.deep.equal(['/rules']);
    });

    it('rejects an unknown key on a rule, pointing at the exact location', function () {
      const err = captureError(() =>
        maskData.compileRules({ rules: [{ kind: 'phone', fields: ['a'], ipFields: ['a'] }] })
      );
      expect(err.code).to.equal(maskData.ERROR_CODES.RULE_UNKNOWN_KEY);
      expect(pointers(err)).to.deep.equal(['/rules/0/ipFields']);
      expect(err.issues[0].message).to.contain('ipFields');
    });

    it('rejects an unknown mask kind instead of silently ignoring it', function () {
      const err = captureError(() => maskData.compileRules({ rules: [{ kind: 'ip', fields: ['a'] }] }));
      expect(err.code).to.equal(maskData.ERROR_CODES.RULE_KIND_UNKNOWN);
      expect(pointers(err)).to.deep.equal(['/rules/0/kind']);
      expect(err.code).to.equal(maskData.ERROR_CODES.RULE_KIND_UNKNOWN);
    });

    it('rejects fields that is not an array', function () {
      const err = captureError(() => maskData.compileRules({ rules: [{ kind: 'phone', fields: 'a' }] }));
      expect(err.code).to.equal(maskData.ERROR_CODES.RULE_SHAPE);
      expect(pointers(err)).to.deep.equal(['/rules/0/fields']);
    });

    it('rejects an empty fields array', function () {
      const err = captureError(() => maskData.compileRules({ rules: [{ kind: 'phone', fields: [] }] }));
      expect(err.code).to.equal(maskData.ERROR_CODES.RULE_FIELDS_EMPTY);
      expect(pointers(err)).to.deep.equal(['/rules/0/fields']);
    });

    it('rejects every malformed field pattern upstream discarded silently', function () {
      const bad = ['a..b', 'a.*.c', '*x.y', 'a[*]', 'a.**', '', '  ', 'a[0].b'];
      const err = captureError(() =>
        maskData.compileRules({ rules: [{ kind: 'phone', fields: bad }] })
      );
      expect(err.code).to.equal(maskData.ERROR_CODES.RULE_FIELD_PATTERN);
      expect(err.issues).to.have.lengthOf(bad.length);
      expect(pointers(err)).to.deep.equal(bad.map((_, i) => `/rules/0/fields/${i}`));
    });

    it('accepts all documented pattern forms', function () {
      const plan = maskData.compileRules({
        rules: [{ kind: 'phone', fields: ['a', 'a.b.c', 'cards[*].number', 'emails.*', '*contact'] }],
      });
      expect(plan.rules).to.have.lengthOf(1);
      expect(plan.rules[0].fields).to.have.lengthOf(5);
    });

    it('rejects an unknown option for the chosen kind', function () {
      const err = captureError(() =>
        maskData.compileRules({ rules: [{ kind: 'phone', fields: ['a'], options: { unmaskedStartCharacters: 2 } }] })
      );
      expect(err.code).to.equal(maskData.ERROR_CODES.RULE_OPTION_UNKNOWN);
      expect(pointers(err)).to.deep.equal(['/rules/0/options/unmaskedStartCharacters']);
      expect(err.issues[0].hint).to.contain('phone');
    });

    it('rejects wrong option types with the offending path', function () {
      const err = captureError(() =>
        maskData.compileRules({
          rules: [{ kind: 'phone', fields: ['a'], options: { unmaskedStartDigits: '3' } }],
        })
      );
      expect(err.code).to.equal(maskData.ERROR_CODES.RULE_OPTION_TYPE);
      expect(pointers(err)).to.deep.equal(['/rules/0/options/unmaskedStartDigits']);
      expect(err.issues[0].message).to.contain('integer');
    });

    it('rejects out-of-range options', function () {
      const err = captureError(() =>
        maskData.compileRules({
          rules: [
            { kind: 'phone', fields: ['a'], options: { unmaskedEndDigits: -2 } },
            { kind: 'uuid', fields: ['b'], options: { unmaskedStartCharacters: 40 } },
            { kind: 'phone', fields: ['c'], options: { maskWith: '' } },
          ],
        })
      );
      expect(codes(err)).to.deep.equal([
        maskData.ERROR_CODES.RULE_OPTION_RANGE,
        maskData.ERROR_CODES.RULE_OPTION_RANGE,
        maskData.ERROR_CODES.RULE_OPTION_RANGE,
      ]);
      expect(pointers(err)).to.deep.equal([
        '/rules/0/options/unmaskedEndDigits',
        '/rules/1/options/unmaskedStartCharacters',
        '/rules/2/options/maskWith',
      ]);
    });

    it('attaches ruleIndex and ruleId to each option issue', function () {
      const err = captureError(() =>
        maskData.compileRules({
          rules: [
            { kind: 'phone', fields: ['a'] },
            { id: 'second', kind: 'phone', fields: ['b'], options: { unmaskedStartDigits: -1 } },
          ],
        })
      );
      expect(err.issues[0].ruleIndex).to.equal(1);
      expect(err.issues[0].ruleId).to.equal('second');
    });

    it('aggregates every issue in one throw instead of failing fast', function () {
      const err = captureError(() =>
        maskData.compileRules({
          rules: [
            { kind: 'nope', fields: ['a'] },
            { kind: 'phone', fields: ['a..b'] },
            { kind: 'phone', fields: ['c'], options: { maskWith: 5 } },
          ],
        })
      );
      expect(err.issues.length).to.be.at.least(3);
      expect(err.message).to.contain('issue');
    });

    it('reports duplicate rule ids', function () {
      const err = captureError(() =>
        maskData.compileRules({
          rules: [
            { id: 'dup', kind: 'phone', fields: ['a'] },
            { id: 'dup', kind: 'phone', fields: ['b'] },
          ],
        })
      );
      expect(err.issues[0].message).to.contain('duplicate rule id');
      expect(pointers(err)).to.deep.equal(['/rules/1/id']);
    });

    it('is a real Error with a usable stack (unlike the upstream string throw)', function () {
      const upstreamErr = captureError(() => maskData.maskPhone('123', { unmaskedStartDigits: 'x' }));
      expect(typeof upstreamErr).to.equal('string');

      const err = captureError(() => maskData.compileRules({ rules: [] }));
      expect(err instanceof Error).to.equal(true);
      expect(typeof err.stack).to.equal('string');
      expect(err.message.length).to.be.greaterThan(0);
    });
  });

  // =========================================================================
  describe('B. Rule sets are data, never code', function () {
    it('rejects a function used as an option value', function () {
      const err = captureError(() =>
        maskData.compileRules({
          rules: [{ kind: 'phone', fields: ['a'], options: { maskWith: function () {} } }],
        })
      );
      const c = codes(err);
      expect(c).to.include(maskData.ERROR_CODES.RULE_UNSAFE_VALUE);
      expect(err.issues[0].message).to.contain('data only');
    });

    it('rejects an arrow function hidden in an array', function () {
      const err = captureError(() =>
        maskData.compileRules({
          rules: [{ kind: 'string', fields: ['a'], options: { values: ['ok', () => 'x'] } }],
        })
      );
      expect(codes(err)).to.include(maskData.ERROR_CODES.RULE_UNSAFE_VALUE);
    });

    it('rejects a RegExp option value', function () {
      const err = captureError(() =>
        maskData.compileRules({
          rules: [{ kind: 'string', fields: ['a'], options: { values: [/secret/] } }],
        })
      );
      expect(codes(err)).to.include(maskData.ERROR_CODES.RULE_UNSAFE_VALUE);
      expect(err.pointer).to.equal('/rules/0/options/values/0');
    });

    it('rejects prototype-pollution keys and leaves Object.prototype clean', function () {
      const hostile = JSON.parse(
        '{"rules":[{"kind":"phone","fields":["a"],"options":{"__proto__":{"polluted":"yes"}}}]}'
      );
      const err = captureError(() => maskData.compileRules(hostile));
      expect(err.code).to.equal(maskData.ERROR_CODES.RULE_UNSAFE_VALUE);
      expect(pointers(err)).to.deep.equal(['/rules/0/options/__proto__']);
      expect({}.polluted).to.be.undefined;
    });

    it('rejects forbidden keys inside defaults too', function () {
      const hostile = JSON.parse('{"defaults":{"constructor":{"x":1}},"rules":[{"kind":"phone","fields":["a"]}]}');
      const err = captureError(() => maskData.compileRules(hostile));
      expect(err.code).to.equal(maskData.ERROR_CODES.RULE_UNSAFE_VALUE);
    });

    it('accepts a rule set that survived a JSON round-trip unchanged', function () {
      const ruleSet = {
        version: 1,
        defaults: { maskWith: '#' },
        rules: [{ id: 'p', kind: 'phone', fields: ['v'], options: { unmaskedStartDigits: 2, unmaskedEndDigits: 2 } }],
      };
      const roundTripped = JSON.parse(JSON.stringify(ruleSet));
      expect(maskData.maskJSON3({ v: '12345678' }, roundTripped)).to.deep.equal(
        maskData.maskJSON3({ v: '12345678' }, ruleSet)
      );
    });
  });

  // =========================================================================
  describe('C. Default resolution', function () {
    const kindDefaultRule = { rules: [{ kind: 'phone', fields: ['v'] }] };

    it('falls back to the kind defaults when no options are given', function () {
      const plan = maskData.compileRules(kindDefaultRule);
      expect(plan.rules[0].options).to.deep.equal({
        maskWith: '*',
        unmaskedStartDigits: 4,
        unmaskedEndDigits: 1,
      });
    });

    it('applies ruleSet.defaults over the kind defaults', function () {
      const plan = maskData.compileRules({ defaults: { maskWith: '#' }, rules: [{ kind: 'phone', fields: ['v'] }] });
      expect(plan.rules[0].options.maskWith).to.equal('#');
      expect(plan.rules[0].options.unmaskedStartDigits).to.equal(4);
    });

    it('applies rule options over ruleSet.defaults', function () {
      const plan = maskData.compileRules({
        defaults: { maskWith: '#' },
        rules: [{ kind: 'phone', fields: ['v'], options: { maskWith: '%', unmaskedStartDigits: 1 } }],
      });
      expect(plan.rules[0].options).to.deep.equal({
        maskWith: '%',
        unmaskedStartDigits: 1,
        unmaskedEndDigits: 1,
      });
    });

    it('ignores a default that the kind does not accept', function () {
      const plan = maskData.compileRules({
        defaults: { unmaskedStartCharactersBeforeAt: 5 },
        rules: [{ kind: 'phone', fields: ['v'] }],
      });
      expect(plan.rules[0].options).to.not.have.property('unmaskedStartCharactersBeforeAt');
    });

    it('rejects a default that no kind accepts', function () {
      const err = captureError(() =>
        maskData.compileRules({ defaults: { nonsenseOption: 1 }, rules: [{ kind: 'phone', fields: ['v'] }] })
      );
      expect(err.code).to.equal(maskData.ERROR_CODES.RULE_OPTION_UNKNOWN);
      expect(pointers(err)).to.deep.equal(['/defaults/nonsenseOption']);
    });

    it('does not let one rule mutate the options of another', function () {
      const plan = maskData.compileRules({
        rules: [
          { kind: 'phone', fields: ['a'], options: { maskWith: '#' } },
          { kind: 'phone', fields: ['b'], options: { maskWith: '%' } },
        ],
      });
      expect(plan.rules[0].options.maskWith).to.equal('#');
      expect(plan.rules[1].options.maskWith).to.equal('%');
      const out = maskData.maskJSON3({ a: '12345678', b: '12345678' }, plan);
      expect(out.a).to.equal('1234###8');
      expect(out.b).to.equal('1234%%%8');
    });
  });

  // =========================================================================
  describe('D. Deterministic execution order', function () {
    it('defaults to the upstream kind order when no order is given', function () {
      const plan = maskData.compileRules({
        rules: [
          { kind: 'generic', fields: ['g'], options: { maxMaskedCharacters: 8 } },
          { kind: 'jwt', fields: ['j'] },
          { kind: 'card', fields: ['c'] },
          { kind: 'phone', fields: ['p'] },
          { kind: 'email', fields: ['e'] },
        ],
      });
      expect(plan.explain().map((r) => r.kind)).to.deep.equal(['card', 'email', 'phone', 'jwt', 'generic']);
    });

    it('honours explicit order values', function () {
      const plan = maskData.compileRules({
        rules: [
          { id: 'last', kind: 'phone', order: 100, fields: ['p'] },
          { id: 'first', kind: 'phone', order: -5, fields: ['q'] },
        ],
      });
      expect(plan.explain().map((r) => r.id)).to.deep.equal(['first', 'last']);
    });

    it('breaks order ties by declaration index, deterministically', function () {
      const ruleSet = {
        rules: [
          { id: 'a', kind: 'phone', order: 10, fields: ['x'] },
          { id: 'b', kind: 'phone', order: 10, fields: ['y'] },
          { id: 'c', kind: 'phone', order: 10, fields: ['z'] },
        ],
      };
      const first = maskData.compileRules(ruleSet, { onConflict: 'allow' }).explain().map((r) => r.id);
      const second = maskData.compileRules(ruleSet, { onConflict: 'allow' }).explain().map((r) => r.id);
      expect(first).to.deep.equal(['a', 'b', 'c']);
      expect(second).to.deep.equal(first);
    });

    it('exposes an order that actually changes the masking result', function () {
      const doc = () => ({ v: 'abcdef' });
      const stringThenPhone = {
        rules: [
          { id: 's', kind: 'string', order: 1, fields: ['v'], options: { maskAll: true, maskWith: '#' } },
          { id: 'p', kind: 'phone', order: 2, fields: ['v'], options: { maskWith: '*', unmaskedStartDigits: 2, unmaskedEndDigits: 2 } },
        ],
      };
      const phoneThenString = {
        rules: [
          { id: 'p', kind: 'phone', order: 1, fields: ['v'], options: { maskWith: '*', unmaskedStartDigits: 2, unmaskedEndDigits: 2 } },
          { id: 's', kind: 'string', order: 2, fields: ['v'], options: { maskAll: true, maskWith: '#' } },
        ],
      };
      const a = maskData.maskJSON3(doc(), stringThenPhone);
      const b = maskData.maskJSON3(doc(), phoneThenString);
      expect(a.v).to.equal('##**##');
      expect(b.v).to.equal('######');
      expect(a.v).to.not.equal(b.v);
    });

    it('reports an order that matches what the engine actually executed', function () {
      const report = maskData.maskJSON3(
        { a: 'v1', b: 'v2', c: 'v3' },
        {
          rules: [
            { id: 'c-rule', kind: 'phone', order: 30, fields: ['c'] },
            { id: 'a-rule', kind: 'phone', order: 10, fields: ['a'] },
            { id: 'b-rule', kind: 'phone', order: 20, fields: ['b'] },
          ],
        },
        { report: true }
      );
      expect(report.explain.map((r) => r.id)).to.deep.equal(['a-rule', 'b-rule', 'c-rule']);
      expect(report.trace.rules.map((r) => r.id)).to.deep.equal(['a-rule', 'b-rule', 'c-rule']);
    });
  });

  // =========================================================================
  describe('E. Conflict detection', function () {
    const colliding = {
      rules: [
        { id: 'A', kind: 'phone', order: 10, fields: ['p'] },
        { id: 'B', kind: 'phone', order: 10, fields: ['p'], options: { maskWith: '#' } },
      ],
    };

    it('throws by default when two rules hit the same field at the same order', function () {
      const err = captureError(() => maskData.maskJSON3({ p: '13812345678' }, colliding));
      expect(err.code).to.equal(maskData.ERROR_CODES.RULE_ORDER_CONFLICT);
      expect(err.message).to.contain('"p"');
      expect(err.message).to.contain('A');
      expect(err.message).to.contain('B');
    });

    it('records the conflict and continues under onConflict: warn', function () {
      const report = maskData.maskJSON3({ p: '13812345678' }, { onConflict: 'warn', rules: colliding.rules }, { report: true });
      expect(report.trace.conflicts).to.have.lengthOf(1);
      expect(report.trace.conflicts[0].path).to.equal('p');
      expect(report.trace.conflicts[0].ruleIds).to.deep.equal(['A', 'B']);
      expect(report.result.p).to.be.a('string');
    });

    it('does not escalate the conflict under onConflict: allow', function () {
      const report = maskData.maskJSON3(
        { p: '13812345678' },
        { onConflict: 'allow', rules: colliding.rules },
        { report: true }
      );
      expect(report.trace.onConflict).to.equal('allow');
      expect(report.trace.rules.some((r) => r.warning)).to.equal(false);
      // the collision is still observable on the trace, it just is not escalated
      expect(report.trace.conflicts).to.have.lengthOf(1);
      expect(report.result.p).to.be.a('string');
    });

    it('does not treat different orders as a conflict', function () {
      const report = maskData.maskJSON3(
        { p: '13812345678' },
        {
          rules: [
            { id: 'A', kind: 'phone', order: 10, fields: ['p'] },
            { id: 'B', kind: 'phone', order: 20, fields: ['p'], options: { maskWith: '#' } },
          ],
        },
        { report: true }
      );
      expect(report.trace.conflicts).to.have.lengthOf(0);
    });

    it('warns about a literally identical pattern claimed twice', function () {
      const plan = maskData.compileRules({
        rules: [
          { id: 'A', kind: 'phone', order: 10, fields: ['user.phone'] },
          { id: 'B', kind: 'phone', order: 20, fields: ['user.phone'] },
        ],
      });
      expect(plan.warnings.some((w) => w.code === maskData.ERROR_CODES.RULE_ORDER_CONFLICT)).to.equal(true);
    });

    it('warns about a string rule that cannot change anything', function () {
      const plan = maskData.compileRules({ rules: [{ kind: 'string', fields: ['a'] }] });
      expect(plan.warnings.some((w) => w.code === maskData.ERROR_CODES.RULE_NO_EFFECT)).to.equal(true);
    });
  });

  // =========================================================================
  describe('F. Masking parity with the untouched upstream implementation', function () {
    const doc = () => ({
      credit: '1234-5678-8765-1234',
      primaryEmail: 'primary@Email.com',
      password: 'dummyPassword',
      homePhone: '+1 1234567890',
      uuid1: '123e4567-e89b-12d3-a456-426614174000',
      jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJsb2wiLCJuYW1lIjoiVGVzdCIsImlhdCI6ImxvbCJ9.XNDxZcBWWEKYkCiu6XFGmAeuPF7iFnI7Sdv91gVZJMU',
      nested: { deep: { phone: '9876543210' } },
      cards: [{ number: '1234-5678-0123-0000' }, { number: '1111-2222-3333-4444' }],
      list: ['alpha', 'beta'],
    });

    const cases = [
      {
        name: 'card',
        legacy: { cardFields: ['credit'], cardMaskOptions: { maskWith: 'X', unmaskedStartDigits: 2, unmaskedEndDigits: 2 } },
        rule: { kind: 'card', fields: ['credit'], options: { maskWith: 'X', unmaskedStartDigits: 2, unmaskedEndDigits: 2 } },
      },
      {
        name: 'email',
        legacy: { emailFields: ['primaryEmail'] },
        rule: { kind: 'email', fields: ['primaryEmail'] },
      },
      {
        name: 'password',
        legacy: { passwordFields: ['password'], passwordMaskOptions: { maxMaskedCharacters: 5, unmaskedStartCharacters: 1 } },
        rule: { kind: 'password', fields: ['password'], options: { maxMaskedCharacters: 5, unmaskedStartCharacters: 1 } },
      },
      {
        name: 'phone',
        legacy: { phoneFields: ['homePhone'], phoneMaskOptions: { unmaskedStartDigits: 2, unmaskedEndDigits: 3 } },
        rule: { kind: 'phone', fields: ['homePhone'], options: { unmaskedStartDigits: 2, unmaskedEndDigits: 3 } },
      },
      {
        name: 'uuid',
        legacy: { uuidFields: ['uuid1'], uuidMaskOptions: { unmaskedStartCharacters: 4, unmaskedEndCharacters: 4 } },
        rule: { kind: 'uuid', fields: ['uuid1'], options: { unmaskedStartCharacters: 4, unmaskedEndCharacters: 4 } },
      },
      {
        name: 'jwt',
        legacy: { jwtFields: ['jwt'], jwtMaskOptions: { maxMaskedCharacters: 24, maskDot: false } },
        rule: { kind: 'jwt', fields: ['jwt'], options: { maxMaskedCharacters: 24, maskDot: false } },
      },
      {
        name: 'string with maskAll',
        legacy: { stringFields: ['list.*'], stringMaskOptions: { maskAll: true, maskWith: '?' } },
        rule: { kind: 'string', fields: ['list.*'], options: { maskAll: true, maskWith: '?' } },
      },
      {
        name: 'array index wildcard',
        legacy: { cardFields: ['cards[*].number'] },
        rule: { kind: 'card', fields: ['cards[*].number'] },
      },
      {
        name: 'recursive name match',
        legacy: { genericStrings: [{ config: { maskWith: '#', maxMaskedCharacters: 6 }, fields: ['*phone'] }] },
        rule: { kind: 'generic', fields: ['*phone'], options: { maskWith: '#', maxMaskedCharacters: 6 } },
      },
    ];

    cases.forEach(function (c) {
      it('matches maskJSON2 output for: ' + c.name, function () {
        const upstream = maskData.maskJSON2(doc(), JSON.parse(JSON.stringify(c.legacy)));
        const declarative = maskData.maskJSON3(doc(), { rules: [c.rule] });
        expect(declarative).to.deep.equal(upstream);
      });
    });

    it('matches maskJSON2 output for a combined multi-kind config', function () {
      const legacy = {
        cardFields: ['cards[*].number'],
        cardMaskOptions: { maskWith: 'X', unmaskedStartDigits: 0, unmaskedEndDigits: 0 },
        emailFields: ['primaryEmail'],
        emailMaskOptions: { maskWith: '*', unmaskedStartCharactersBeforeAt: 0, unmaskedEndCharactersAfterAt: 3, maskAtTheRate: false },
        passwordFields: ['password'],
        phoneFields: ['nested.deep.phone'],
        phoneMaskOptions: { maskWith: '#', unmaskedStartDigits: 3, unmaskedEndDigits: 2 },
        stringFields: ['list.*'],
        stringMaskOptions: { maskWith: '?', maskAll: true, maskSpace: false },
        uuidFields: ['uuid1'],
        jwtFields: ['jwt'],
        genericStrings: [{ config: { maskWith: '*', maxMaskedCharacters: 4 }, fields: ['*phone'] }],
      };
      const ruleSet = maskData.migrateLegacyConfig(JSON.parse(JSON.stringify(legacy))).ruleSet;
      const upstream = maskData.maskJSON2(doc(), JSON.parse(JSON.stringify(legacy)));
      const declarative = maskData.maskJSON3(doc(), ruleSet);
      expect(declarative).to.deep.equal(upstream);
    });

    it('applies a field only once when two patterns inside one rule overlap', function () {
      const report = maskData.maskJSON3(
        { profile: { contact: { email: 'bob@corp.example' } } },
        { rules: [{ id: 'mail', kind: 'email', fields: ['profile.contact.email', '*email'] }] },
        { report: true }
      );
      expect(report.trace.rules[0].matchedCount).to.equal(1);
      expect(report.trace.rules[0].matched).to.deep.equal(['profile.contact.email']);
      expect(report.result.profile.contact.email).to.equal('bob@**********le');
    });

    it('leaves the input document untouched', function () {
      const input = doc();
      const snapshot = JSON.stringify(input);
      maskData.maskJSON3(input, { rules: [{ kind: 'phone', fields: ['homePhone'] }] });
      expect(JSON.stringify(input)).to.equal(snapshot);
    });

    it('never creates keys for paths that do not exist', function () {
      const out = maskData.maskJSON3({ a: 1 }, { rules: [{ kind: 'phone', fields: ['x.y.z'] }] });
      expect(out).to.deep.equal({ a: 1 });
      expect(out).to.not.have.property('x');
    });

    it('skips null and undefined values without throwing', function () {
      const out = maskData.maskJSON3(
        { a: null, b: undefined, c: '13812345678' },
        { rules: [{ kind: 'phone', fields: ['a', 'b', 'c'] }] }
      );
      expect(out.a).to.equal(null);
      expect(out.b).to.be.undefined;
      expect(out.c).to.equal('1381******8');
    });

    it('handles an array at the document root', function () {
      const out = maskData.maskJSON3(
        [{ p: '13812345678' }, { p: '13900001111' }],
        { rules: [{ kind: 'phone', fields: ['[*].p'], options: { unmaskedStartDigits: 0, unmaskedEndDigits: 0 } }] }
      );
      expect(out).to.deep.equal([{ p: '***********' }, { p: '***********' }]);
    });
  });

  // =========================================================================
  describe('G. Robustness', function () {
    it('rejects a non-object document', function () {
      const err = captureError(() => maskData.maskJSON3('13812345678', { rules: [{ kind: 'phone', fields: ['a'] }] }));
      expect(err.code).to.equal(maskData.ERROR_CODES.MASK_INPUT);
    });

    it('rejects a document with a circular reference', function () {
      const cyclic = { phone: '13812345678' };
      cyclic.self = cyclic;
      const err = captureError(() => maskData.maskJSON3(cyclic, { rules: [{ kind: 'phone', fields: ['phone'] }] }));
      expect(err.code).to.equal(maskData.ERROR_CODES.MASK_INPUT);
      expect(err.message).to.contain('not JSON-serialisable');
    });

    it('normalises an upstream option rejection into a MaskRuleError', function () {
      // card clamps to cardLength at runtime, so force a genuine upstream failure
      // through the email kind, which validates '@' presence at mask time.
      const err = captureError(() =>
        maskData.maskJSON3(
          { e: 'not-an-email' },
          { rules: [{ id: 'mail', kind: 'email', fields: ['e'] }] }
        )
      );
      expect(err).to.be.instanceOf(MaskRuleError);
      expect(err.code).to.equal(maskData.ERROR_CODES.MASK_RUNTIME);
      expect(err.maskPath).to.equal('e');
      expect(err.ruleId).to.equal('mail');
    });

    it('truncates the trace instead of growing without bound', function () {
      const big = {};
      for (let i = 0; i < 50; i++) big['k' + i] = '13812345678';
      const report = maskData.maskJSON3(big, { rules: [{ kind: 'phone', fields: ['*k0', 'k1', 'k2', 'k3', 'k4'] }] }, { report: true, maxTraceEntries: 2 });
      const first = report.trace.rules[0];
      expect(first.matchedCount).to.be.greaterThan(2);
      expect(first.matched).to.have.lengthOf(2);
      expect(first.truncated).to.equal(true);
    });

    it('returns a frozen plan', function () {
      const plan = maskData.compileRules({ rules: [{ kind: 'phone', fields: ['a'] }] });
      expect(Object.isFrozen(plan)).to.equal(true);
      expect(Array.isArray(plan.explain())).to.equal(true);
    });

    it('reuses a pre-compiled plan', function () {
      const plan = maskData.compileRules({ rules: [{ kind: 'phone', fields: ['a'] }] });
      const out = maskData.maskJSON3({ a: '13812345678' }, null, { plan });
      expect(out.a).to.equal('1381******8');
    });

    it('exposes the supported kind names', function () {
      expect(maskData.KIND_NAMES).to.deep.equal([
        'card',
        'email',
        'password',
        'phone',
        'string',
        'uuid',
        'jwt',
        'generic',
      ]);
    });
  });
});
