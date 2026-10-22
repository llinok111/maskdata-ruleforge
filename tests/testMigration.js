'use strict';

/**
 * Tests for `migrateLegacyConfig`.
 *
 * The migration must be *behaviour preserving*: a config written for `maskJSON2`
 * has to produce byte-identical masking output after conversion. Where upstream
 * applied implicit clamping, the migration materialises the clamped value so the
 * stricter validator accepts the migrated rule set.
 */

const maskData = require('../index');
const expect = require('chai').expect;

const clone = (v) => JSON.parse(JSON.stringify(v));

describe('Legacy config migration', function () {
  describe('behaviour preservation', function () {
    const fixtures = [
      {
        name: 'single phone rule',
        doc: { p: '13812345678', other: 'untouched' },
        legacy: { phoneFields: ['p'], phoneMaskOptions: { maskWith: '#', unmaskedStartDigits: 2, unmaskedEndDigits: 3 } },
      },
      {
        name: 'nested email + password',
        doc: { user: { email: 'a.b@example.com', password: 'secret123' } },
        legacy: {
          emailFields: ['user.email'],
          emailMaskOptions: { unmaskedStartCharactersBeforeAt: 1, unmaskedEndCharactersAfterAt: 3, maskAtTheRate: true },
          passwordFields: ['user.password'],
          passwordMaskOptions: { maxMaskedCharacters: 6 },
        },
      },
      {
        name: 'array wildcard + recursive name',
        doc: {
          cards: [{ number: '1234-5678-0123-0000' }, { number: '1111-2222-3333-4444' }],
          deep: { a: { card: '0000-1111-2222-3333' } },
        },
        legacy: {
          cardFields: ['cards[*].number'],
          cardMaskOptions: { maskWith: 'X', unmaskedStartDigits: 0, unmaskedEndDigits: 0 },
          genericStrings: [{ config: { maskWith: '#', maxMaskedCharacters: 8 }, fields: ['*card'] }],
        },
      },
      {
        name: 'multiple genericStrings entries keep their own options',
        doc: { a: 'abcdefghij', b: 'abcdefghij' },
        legacy: {
          genericStrings: [
            { config: { maskWith: '*', maxMaskedCharacters: 4 }, fields: ['a'] },
            { config: { maskWith: '#', maxMaskedCharacters: 7 }, fields: ['b'] },
          ],
        },
      },
      {
        name: 'uuid and jwt with partial masking',
        doc: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsb2wifQ.c2lnbmF0dXJl',
        },
        legacy: {
          uuidFields: ['id'],
          uuidMaskOptions: { unmaskedStartCharacters: 8, unmaskedEndCharacters: 4 },
          jwtFields: ['token'],
          jwtMaskOptions: { maxMaskedCharacters: 20, maskPayload: false },
        },
      },
      {
        name: 'string maskAll with maskSpace',
        doc: { s: 'hello world' },
        legacy: {
          stringFields: ['s'],
          stringMaskOptions: { maskAll: true, maskWith: '?', maskSpace: false },
        },
      },
    ];

    fixtures.forEach(function (f) {
      it('produces identical output for: ' + f.name, function () {
        const upstream = maskData.maskJSON2(clone(f.doc), clone(f.legacy));
        const migrated = maskData.migrateLegacyConfig(clone(f.legacy)).ruleSet;
        const declarative = maskData.maskJSON3(clone(f.doc), migrated);
        expect(declarative).to.deep.equal(upstream);
      });
    });

    it('preserves the upstream kind execution order', function () {
      const legacy = {
        cardFields: ['c'],
        emailFields: ['e'],
        passwordFields: ['p'],
        phoneFields: ['h'],
        stringFields: ['s'],
        uuidFields: ['u'],
        jwtFields: ['j'],
        stringMaskOptions: { maskAll: true },
        genericStrings: [{ config: { maskWith: '*' }, fields: ['g'] }],
      };
      const plan = maskData.compileRules(maskData.migrateLegacyConfig(legacy).ruleSet);
      expect(plan.explain().map((r) => r.kind)).to.deep.equal([
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

  describe('implicit clamping is materialised', function () {
    it('turns a negative password maxMaskedCharacters into the upstream fallback', function () {
      const { ruleSet, notes } = maskData.migrateLegacyConfig({
        passwordFields: ['p'],
        passwordMaskOptions: { maxMaskedCharacters: -5 },
      });
      expect(ruleSet.rules[0].options.maxMaskedCharacters).to.equal(16);
      expect(notes.some((n) => n.message.includes('clamped'))).to.equal(true);
    });

    it('turns a negative phone digit count into 0', function () {
      const { ruleSet } = maskData.migrateLegacyConfig({
        phoneFields: ['p'],
        phoneMaskOptions: { unmaskedStartDigits: -3 },
      });
      expect(ruleSet.rules[0].options.unmaskedStartDigits).to.equal(0);
    });

    it('materialises the fixedOutputLength override on passwords', function () {
      const { ruleSet } = maskData.migrateLegacyConfig({
        passwordFields: ['p'],
        passwordMaskOptions: { fixedOutputLength: 8, maxMaskedCharacters: 4 },
      });
      expect(ruleSet.rules[0].options.fixedOutputLength).to.equal(8);
      expect(ruleSet.rules[0].options.maxMaskedCharacters).to.equal(8);
    });

    it('drops an invalid fixedOutputLength the way upstream did', function () {
      const { ruleSet } = maskData.migrateLegacyConfig({
        passwordFields: ['p'],
        passwordMaskOptions: { fixedOutputLength: -1 },
      });
      expect(ruleSet.rules[0].options).to.not.have.property('fixedOutputLength');
    });

    it('materialises the uuid >32 clamp', function () {
      const { ruleSet } = maskData.migrateLegacyConfig({
        uuidFields: ['u'],
        uuidMaskOptions: { unmaskedStartCharacters: 40, unmaskedEndCharacters: 10 },
      });
      expect(ruleSet.rules[0].options.unmaskedStartCharacters).to.equal(32);
      expect(ruleSet.rules[0].options.unmaskedEndCharacters).to.equal(0);
    });

    it('falls back to "*" when maskWith was empty', function () {
      const { ruleSet } = maskData.migrateLegacyConfig({
        phoneFields: ['p'],
        phoneMaskOptions: { maskWith: '' },
      });
      expect(ruleSet.rules[0].options.maskWith).to.equal('*');
    });

    it('produces a rule set the strict validator accepts', function () {
      const { ruleSet } = maskData.migrateLegacyConfig({
        passwordFields: ['p'],
        passwordMaskOptions: { maxMaskedCharacters: -5, unmaskedStartCharacters: -2, maskWith: '' },
        uuidFields: ['u'],
        uuidMaskOptions: { unmaskedStartCharacters: 99 },
        genericStrings: [{ config: { fixedOutputLength: -3 }, fields: ['g'] }],
      });
      expect(() => maskData.compileRules(ruleSet)).to.not.throw();
    });
  });

  describe('reported notes', function () {
    it('records legacy keys that maskJSON2 silently ignored', function () {
      const result = maskData.migrateLegacyConfig({
        phoneFields: ['p'],
        ipFields: ['p'],
        bogusMaskOptions: { x: 1 },
      });
      expect(result.droppedKeys).to.deep.equal(['ipFields', 'bogusMaskOptions']);
      expect(result.notes.some((n) => n.message.includes('silently ignored'))).to.equal(true);
      expect(result.ruleSet.rules).to.have.lengthOf(1);
    });

    it('notes the input-mutation behaviour difference', function () {
      const { notes } = maskData.migrateLegacyConfig({ phoneFields: ['p'] });
      expect(notes.some((n) => n.message.includes('mutated the caller'))).to.equal(true);
    });

    it('warns when the legacy config masks nothing', function () {
      const { ruleSet, notes } = maskData.migrateLegacyConfig({});
      expect(ruleSet.rules).to.have.lengthOf(0);
      expect(notes.some((n) => n.message.includes('masks nothing'))).to.equal(true);
    });

    it('skips a non-array fields value instead of throwing', function () {
      const { ruleSet, notes } = maskData.migrateLegacyConfig({ phoneFields: 'p' });
      expect(ruleSet.rules).to.have.lengthOf(0);
      expect(notes.some((n) => n.message.includes('was not an array'))).to.equal(true);
    });
  });

  describe('purity', function () {
    it('does not mutate the legacy config it was given', function () {
      const legacy = { phoneFields: ['p'], phoneMaskOptions: { maskWith: '#' } };
      const snapshot = JSON.stringify(legacy);
      maskData.migrateLegacyConfig(legacy);
      expect(JSON.stringify(legacy)).to.equal(snapshot);
    });

    it('returns a JSON-serialisable rule set', function () {
      const { ruleSet } = maskData.migrateLegacyConfig({
        phoneFields: ['p'],
        genericStrings: [{ config: { maskWith: '#' }, fields: ['g'] }],
      });
      expect(() => JSON.stringify(ruleSet)).to.not.throw();
      const roundTripped = JSON.parse(JSON.stringify(ruleSet));
      expect(roundTripped.rules).to.have.lengthOf(2);
    });

    it('rejects a non-object argument', function () {
      expect(() => maskData.migrateLegacyConfig(null)).to.throw(TypeError);
      expect(() => maskData.migrateLegacyConfig([])).to.throw(TypeError);
    });
  });
});
