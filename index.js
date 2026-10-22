'use strict';

const MaskEmail = require('./lib/maskService/EmailMask');
const MaskCard = require('./lib/maskService/CardMask');
const MaskPhone = require('./lib/maskService/PhoneMask');
const MaskString = require('./lib/maskService/StringMask');
const MaskPassword = require('./lib/maskService/PasswordMask');
const MaskUuid = require('./lib/maskService/UuidMask');
const JsonMask = require('./lib/maskService/JsonMask');
const JwtMask = require('./lib/maskService/JwtMask');
const JsonGetSet = require('./lib/helpers/jsonGetSet');
const RuleCompiler = require('./lib/rules/RuleCompiler');
const RuleEngine = require('./lib/rules/RuleEngine');
const LegacyMigration = require('./lib/rules/LegacyMigration');
const { MaskRuleError, ERROR_CODES } = require('./lib/rules/MaskRuleError');
const RuleSchema = require('./lib/rules/RuleSchema');
const FieldPattern = require('./lib/rules/FieldPattern');

class MaskData {
  static maskPassword(password, options) {
    return MaskPassword.maskPassword(password, options);
  }

  static maskJSON2(json, options) {
    return JsonMask.maskJSON2(json, options);
  }

  static maskPhone(phone, options) {
    return MaskPhone.maskPhone(phone, options);
  }

  static maskEmail2(email, options) {
    return MaskEmail.maskEmail2(email, options);
  }

  static maskCard(cardNumber, options) {
    return MaskCard.maskCard(cardNumber, options);
  }

  /**
   * @deprecated since version 1.3.3
   * This function will be removed in future versions.
   * Use `maskStringV2` instead.
   */
  static maskString(str, options) {
    return MaskString.maskString(str, options);
  }

  static maskStringV2(str, options) {
    return MaskString.maskStringV2(str, options);
  }

  static maskUuid(uuid, options) {
    return MaskUuid.maskUuid(uuid, options);
  }

  static maskJwt(jwt, options) {
    return JwtMask.maskJwt(jwt, options);
  }

  static getInnerProperty(object, field) {
    return JsonGetSet.get(object, field);
  }

  static replaceValue(object, field, value) {
    return JsonGetSet.set(object, field, value);
  }

  // ---------------------------------------------------------------------------
  // Declarative rule layer (additive; maskJSON2 above is untouched)
  // ---------------------------------------------------------------------------

  /**
   * Compile a declarative rule set into an immutable, validated execution plan.
   *
   * @param {object} ruleSet  { version: 1, defaults?, rules: [{ id?, kind, order?, fields, options? }] }
   * @param {{onConflict?:'error'|'warn'|'allow'}} [options]
   * @returns {object} frozen plan; call plan.explain() to inspect execution order
   * @throws {MaskRuleError} aggregated validation failure with JSON Pointer locations
   */
  static compileRules(ruleSet, options) {
    return RuleCompiler.compile(ruleSet, options);
  }

  /**
   * Mask a JSON document using declarative rules.
   *
   * Ordering is deterministic: rules run by ascending `order`, ties broken by
   * declaration index. Two rules touching the same field at the same order is a
   * configuration error unless `onConflict` says otherwise.
   *
   * @param {object|Array} json
   * @param {object} ruleSet
   * @param {{report?:boolean, trace?:boolean, maxTraceEntries?:number, onConflict?:string, plan?:object}} [options]
   * @returns {any|{result:any, plan:object, trace:object, explain:Array}} masked clone
   */
  static maskJSON3(json, ruleSet, options) {
    const opts = options || {};
    const plan =
      opts.plan ||
      (RuleCompiler.isCompiledPlan(ruleSet) ? ruleSet : RuleCompiler.compile(ruleSet, opts));
    const outcome = RuleEngine.runPlan(json, plan, opts);
    if (opts.report === true) {
      return {
        result: outcome.result,
        plan: plan,
        trace: outcome.trace,
        explain: plan.explain(),
      };
    }
    return outcome.result;
  }

  /**
   * Convert a legacy maskJSON2 config into a declarative rule set.
   * Implicit upstream clamping is materialised so output stays identical.
   *
   * @param {object} legacyConfig
   * @returns {{ruleSet:object, notes:Array, droppedKeys:string[]}}
   */
  static migrateLegacyConfig(legacyConfig) {
    return LegacyMigration.fromLegacyConfig(legacyConfig);
  }

  /** Inspect the execution order of a compiled plan. */
  static explainRules(plan) {
    return RuleCompiler.explainPlan(plan);
  }
}

MaskData.RuleError = MaskRuleError;
MaskData.ERROR_CODES = ERROR_CODES;
MaskData.KIND_NAMES = RuleSchema.KIND_NAMES;
MaskData.parseFieldPattern = FieldPattern.parseFieldPattern;

module.exports = MaskData;
