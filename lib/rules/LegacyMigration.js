'use strict';

/**
 * Legacy config -> declarative rule set migration.
 *
 * Upstream `maskJSON2` accepts a flat config object where every mask kind owns a
 * `<kind>Fields` array and a `<kind>MaskOptions` object. That shape cannot express
 * three things this layer needs:
 *
 *   1. explicit ordering   - the upstream order is baked into `typeToFunctionMap`
 *   2. per-rule options    - two phone rules cannot use different `maskWith`
 *   3. validation          - unknown keys and malformed patterns are ignored silently
 *
 * This converter produces a semantically equivalent rule set and reports every
 * place where the upstream behaviour was implicit. Implicit numeric clamping is
 * materialised into explicit values, so the migrated config keeps producing the
 * same output instead of failing the stricter validator.
 */

const { KINDS, KIND_NAMES } = require('./RuleSchema');

const LEGACY_KIND_KEYS = KIND_NAMES.filter((k) => k !== 'generic');

/**
 * Reproduce the clamping that `MaskHelper.validate*Options` applies at runtime,
 * so migration turns implicit behaviour into explicit configuration.
 */
function clampLegacyOptions(kindName, options, notes, ruleId) {
  const out = Object.assign({}, options);
  const note = (msg) => notes.push({ ruleId, message: msg });

  const clampMin0 = (key, fallback) => {
    if (out[key] === undefined) return;
    const n = parseInt(out[key], 10);
    if (Number.isNaN(n)) {
      note(`option "${key}" was not an integer (${JSON.stringify(out[key])}); upstream coerced it and the migrated value may differ — please review.`);
      return;
    }
    if (n !== out[key]) {
      note(`option "${key}" was coerced from ${JSON.stringify(out[key])} to integer ${n} (upstream parseInt behaviour).`);
      out[key] = n;
    }
    if (out[key] < 0) {
      const replacement = fallback === undefined ? 0 : fallback;
      note(`option "${key}" was ${out[key]}; upstream silently clamped it to ${replacement}. Written explicitly here.`);
      out[key] = replacement;
    }
  };

  switch (kindName) {
    case 'card':
    case 'phone':
      clampMin0('unmaskedStartDigits');
      clampMin0('unmaskedEndDigits');
      if (kindName === 'card') {
        note(
          'card masks also clamp unmaskedStartDigits/unmaskedEndDigits to the card length at runtime; that bound depends on the data and is not materialised here.'
        );
      }
      break;
    case 'password':
      clampMin0('maxMaskedCharacters', 16);
      clampMin0('unmaskedStartCharacters');
      clampMin0('unmaskedEndCharacters');
      if (out.fixedOutputLength !== undefined) {
        const n = parseInt(out.fixedOutputLength, 10);
        if (Number.isNaN(n) || n < 0) {
          note('option "fixedOutputLength" was invalid; upstream ignored it (undefined). Written explicitly as omitted.');
          delete out.fixedOutputLength;
        } else {
          if (n !== out.fixedOutputLength) {
            note(`option "fixedOutputLength" was coerced to integer ${n}.`);
          }
          out.fixedOutputLength = n;
          if (out.maxMaskedCharacters !== n) {
            note(`option "maxMaskedCharacters" is overridden by fixedOutputLength=${n} upstream; written explicitly.`);
          }
          out.maxMaskedCharacters = n;
        }
      }
      break;
    case 'string':
      clampMin0('maxMaskedCharacters', 2048);
      break;
    case 'email':
      clampMin0('unmaskedStartCharactersBeforeAt');
      clampMin0('unmaskedEndCharactersAfterAt');
      break;
    case 'uuid':
      clampMin0('unmaskedStartCharacters');
      clampMin0('unmaskedEndCharacters');
      if (out.unmaskedStartCharacters > 32 || out.unmaskedEndCharacters > 32) {
        note(
          `uuid options exceeded 32 (start=${out.unmaskedStartCharacters}, end=${out.unmaskedEndCharacters}); upstream forced start=32,end=0. Written explicitly.`
        );
        out.unmaskedStartCharacters = 32;
        out.unmaskedEndCharacters = 0;
      }
      break;
    case 'generic':
      clampMin0('maxMaskedCharacters', 256);
      clampMin0('unmaskedStartCharacters');
      clampMin0('unmaskedEndCharacters');
      if (out.fixedOutputLength !== undefined) {
        const n = parseInt(out.fixedOutputLength, 10);
        if (Number.isNaN(n) || n < 0) {
          delete out.fixedOutputLength;
          note('option "fixedOutputLength" was invalid; upstream ignored it. Written explicitly as omitted.');
        } else {
          out.fixedOutputLength = n;
          out.maxMaskedCharacters = n;
        }
      }
      break;
    case 'jwt':
      clampMin0('maxMaskedCharacters');
      break;
    default:
      break;
  }

  if (out.maskWith !== undefined && (out.maskWith === '' || out.maskWith === null)) {
    note('option "maskWith" was empty; upstream fell back to "*". Written explicitly.');
    out.maskWith = '*';
  }
  return out;
}

/**
 * Convert a legacy `maskJSON2` config into a `{ version, rules }` rule set.
 *
 * @param {object} legacyConfig
 * @returns {{ruleSet:object, notes:Array<{ruleId?:string,message:string}>, droppedKeys:string[]}}
 */
function fromLegacyConfig(legacyConfig) {
  if (legacyConfig === null || typeof legacyConfig !== 'object' || Array.isArray(legacyConfig)) {
    throw new TypeError('fromLegacyConfig expects a plain config object');
  }

  const notes = [];
  const droppedKeys = [];
  const rules = [];

  const known = new Set();
  for (const kindName of LEGACY_KIND_KEYS) {
    const kind = KINDS[kindName];
    known.add(kind.fieldsKey);
    known.add(kind.optionsKey);
  }
  known.add('genericStrings');

  for (const key of Object.keys(legacyConfig)) {
    if (!known.has(key)) {
      droppedKeys.push(key);
      notes.push({
        message:
          `legacy key "${key}" is not recognised by maskJSON2 and was silently ignored there; ` +
          `it is dropped from the migration (if it was meant as a mask kind, use { kind, fields } explicitly).`,
      });
    }
  }

  for (const kindName of LEGACY_KIND_KEYS) {
    const kind = KINDS[kindName];
    const fields = legacyConfig[kind.fieldsKey];
    const options = legacyConfig[kind.optionsKey];
    if (fields === undefined) continue;
    if (!Array.isArray(fields)) {
      notes.push({
        ruleId: kindName,
        message: `legacy "${kind.fieldsKey}" was not an array (${typeof fields}); skipped.`,
      });
      continue;
    }
    if (fields.length === 0) continue;

    const ruleId = kindName;
    const migratedOptions = options && typeof options === 'object'
      ? clampLegacyOptions(kindName, options, notes, ruleId)
      : {};

    rules.push({
      id: ruleId,
      kind: kindName,
      order: kind.defaultOrder,
      fields: fields.slice(),
      options: migratedOptions,
      description: `migrated from legacy ${kind.fieldsKey}`,
    });
  }

  if (Array.isArray(legacyConfig.genericStrings)) {
    legacyConfig.genericStrings.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') {
        notes.push({ message: `genericStrings[${i}] was not an object; skipped.` });
        return;
      }
      const fields = entry.fields;
      if (!Array.isArray(fields) || fields.length === 0) return;
      const ruleId = `genericStrings[${i}]`;
      const migratedOptions = entry.config && typeof entry.config === 'object'
        ? clampLegacyOptions('generic', entry.config, notes, ruleId)
        : {};
      rules.push({
        id: ruleId,
        kind: 'generic',
        order: KINDS.generic.defaultOrder + i,
        fields: fields.slice(),
        options: migratedOptions,
        description: `migrated from legacy genericStrings[${i}] (config -> options)`,
      });
    });
    notes.push({
      message:
        'legacy genericStrings[].config is renamed to options; each entry becomes its own rule so per-entry options are preserved.',
    });
  }

  if (rules.length === 0) {
    notes.push({
      message:
        'the legacy config listed no fields, so the migrated rule set is empty. maskJSON2 with an empty config masks nothing — the validator rejects empty rule sets intentionally.',
    });
  }

  notes.push({
    message:
      'maskJSON2 mutated the caller\'s config object in place (it injected default option objects). The declarative engine never mutates its inputs.',
  });

  return {
    ruleSet: { version: 1, onConflict: 'allow', rules },
    notes,
    droppedKeys,
  };
}

module.exports = { fromLegacyConfig, clampLegacyOptions };
