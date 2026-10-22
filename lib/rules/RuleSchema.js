'use strict';

/**
 * Declarative rule schema.
 *
 * This module is the single source of truth for:
 *   - which mask `kind`s exist (the closed enum the engine can dispatch to)
 *   - which options each kind accepts, with type / range / default metadata
 *   - the default execution order per kind
 *
 * Design constraint (security):
 *   A rule set is *pure data*. `kind` must be one of the strings below, and option
 *   values must be JSON scalars / arrays of scalars. Functions, RegExp objects,
 *   class instances and prototype-pollution keys are rejected by the validator.
 *   There is deliberately no `eval`, no `new Function`, no plugin loader, and no
 *   way to express arbitrary code inside a rule set. Extending behaviour means
 *   picking a different built-in kind, not shipping code in a config file.
 */

const Constants = require('../helpers/Constants');
const CardMask = require('../maskService/CardMask');
const EmailMask = require('../maskService/EmailMask');
const PasswordMask = require('../maskService/PasswordMask');
const PhoneMask = require('../maskService/PhoneMask');
const StringMask = require('../maskService/StringMask');
const UuidMask = require('../maskService/UuidMask');
const JwtMask = require('../maskService/JwtMask');

/**
 * Option descriptor fields:
 *   type        'string' | 'integer' | 'boolean' | 'string[]'
 *   min         inclusive lower bound (integer)
 *   max         inclusive upper bound (integer)
 *   minLength   minimum string length
 *   optional    true when `undefined` is allowed even after defaults
 *   describe    short human description, surfaced in error hints and docs
 */
const OPTION_SPECS = {
  card: {
    maskWith: { type: 'string', minLength: 1, describe: 'character used to replace digits' },
    unmaskedStartDigits: { type: 'integer', min: 0, describe: 'leading digits left visible' },
    unmaskedEndDigits: { type: 'integer', min: 0, describe: 'trailing digits left visible' },
  },
  email: {
    maskWith: { type: 'string', minLength: 1 },
    unmaskedStartCharactersBeforeAt: { type: 'integer', min: 0 },
    unmaskedEndCharactersAfterAt: { type: 'integer', min: 0 },
    maskAtTheRate: { type: 'boolean' },
  },
  password: {
    maskWith: { type: 'string', minLength: 1 },
    maxMaskedCharacters: { type: 'integer', min: 0 },
    fixedOutputLength: { type: 'integer', min: 0, optional: true },
    unmaskedStartCharacters: { type: 'integer', min: 0 },
    unmaskedEndCharacters: { type: 'integer', min: 0 },
  },
  phone: {
    maskWith: { type: 'string', minLength: 1 },
    unmaskedStartDigits: { type: 'integer', min: 0 },
    unmaskedEndDigits: { type: 'integer', min: 0 },
  },
  string: {
    maskWith: { type: 'string', minLength: 1 },
    maskOnlyFirstOccurance: { type: 'boolean' },
    values: { type: 'string[]' },
    maskAll: { type: 'boolean' },
    maskSpace: { type: 'boolean' },
    maxMaskedCharacters: { type: 'integer', min: 0 },
  },
  uuid: {
    maskWith: { type: 'string', minLength: 1 },
    unmaskedStartCharacters: { type: 'integer', min: 0, max: 32 },
    unmaskedEndCharacters: { type: 'integer', min: 0, max: 32 },
  },
  jwt: {
    maskWith: { type: 'string', minLength: 1 },
    maxMaskedCharacters: { type: 'integer', min: 0 },
    maskDot: { type: 'boolean' },
    maskHeader: { type: 'boolean' },
    maskPayload: { type: 'boolean' },
    maskSignature: { type: 'boolean' },
  },
  generic: {
    maskWith: { type: 'string', minLength: 1 },
    maxMaskedCharacters: { type: 'integer', min: 0 },
    fixedOutputLength: { type: 'integer', min: 0, optional: true },
    unmaskedStartCharacters: { type: 'integer', min: 0 },
    unmaskedEndCharacters: { type: 'integer', min: 0 },
  },
};

/**
 * Closed dispatch table. `defaultOrder` mirrors the upstream hard-coded
 * `typeToFunctionMap` iteration order so that a mechanically migrated legacy
 * config keeps producing byte-identical output.
 */
const KINDS = Object.freeze({
  card: {
    masker: CardMask.maskCard,
    optionsKey: 'cardMaskOptions',
    fieldsKey: 'cardFields',
    defaultOrder: 0,
    defaults: Constants.defaultCardMaskOptions,
    spec: OPTION_SPECS.card,
  },
  email: {
    masker: EmailMask.maskEmail2,
    optionsKey: 'emailMaskOptions',
    fieldsKey: 'emailFields',
    defaultOrder: 10,
    defaults: Constants.defaultEmailMask2Options,
    spec: OPTION_SPECS.email,
  },
  password: {
    masker: PasswordMask.maskPassword,
    optionsKey: 'passwordMaskOptions',
    fieldsKey: 'passwordFields',
    defaultOrder: 20,
    defaults: Constants.defaultPasswordMaskOptions,
    spec: OPTION_SPECS.password,
  },
  phone: {
    masker: PhoneMask.maskPhone,
    optionsKey: 'phoneMaskOptions',
    fieldsKey: 'phoneFields',
    defaultOrder: 30,
    defaults: Constants.defaultPhoneMaskOptions,
    spec: OPTION_SPECS.phone,
  },
  string: {
    masker: StringMask.maskString,
    optionsKey: 'stringMaskOptions',
    fieldsKey: 'stringFields',
    defaultOrder: 40,
    defaults: Constants.defaultStringMaskOptions,
    spec: OPTION_SPECS.string,
  },
  uuid: {
    masker: UuidMask.maskUuid,
    optionsKey: 'uuidMaskOptions',
    fieldsKey: 'uuidFields',
    defaultOrder: 50,
    defaults: Constants.defaultUuidMaskOptions,
    spec: OPTION_SPECS.uuid,
  },
  jwt: {
    masker: JwtMask.maskJwt,
    optionsKey: 'jwtMaskOptions',
    fieldsKey: 'jwtFields',
    defaultOrder: 60,
    defaults: Constants.defaultJwtMaskOptions,
    spec: OPTION_SPECS.jwt,
  },
  generic: {
    masker: StringMask.maskStringV2,
    optionsKey: 'config',
    fieldsKey: 'fields',
    defaultOrder: 70,
    defaults: Constants.defaultStringMaskV2Options,
    spec: OPTION_SPECS.generic,
  },
});

const KIND_NAMES = Object.freeze(Object.keys(KINDS));

/** Keys allowed on a rule object. Anything else is rejected (typos are hard failures). */
const RULE_KEYS = Object.freeze(['id', 'kind', 'order', 'fields', 'options', 'description']);

/** Keys allowed at the rule-set root. */
const RULE_SET_KEYS = Object.freeze(['version', 'defaults', 'rules', 'onConflict']);

/** Keys that must never be written through user-supplied config (prototype pollution guard). */
const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

const SUPPORTED_VERSION = 1;

module.exports = {
  KINDS,
  KIND_NAMES,
  OPTION_SPECS,
  RULE_KEYS,
  RULE_SET_KEYS,
  FORBIDDEN_KEYS,
  SUPPORTED_VERSION,
};
