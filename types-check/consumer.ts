import {
  maskJSON3,
  compileRules,
  explainRules,
  migrateLegacyConfig,
  MaskRuleSet,
  MaskReport,
  CompiledPlan,
  MaskRuleError,
  MaskKind,
} from 'maskdata';

const ruleSet: MaskRuleSet = {
  version: 1,
  defaults: { maskWith: '#' },
  rules: [
    { id: 'phone', kind: 'phone', fields: ['user.phone'], options: { unmaskedStartDigits: 3 } },
    { id: 'card', kind: 'card', fields: ['cards[*].number'], order: 5 },
    { id: 'any', kind: 'generic', fields: ['*contact'], description: 'recursive' },
  ],
};

const plan: CompiledPlan = compileRules(ruleSet, { onConflict: 'warn' });
const out = maskJSON3({ user: { phone: '13812345678' } }, plan);
const report: MaskReport<{ user: { phone: string } }> = maskJSON3(
  { user: { phone: '13812345678' } },
  ruleSet,
  { report: true }
);
const kinds: ReadonlyArray<MaskKind> = ['card', 'phone'];
// unknown legacy keys are not part of the typed surface; cast when migrating a
// config that came from an older/untyped source
const migrated = migrateLegacyConfig({ phoneFields: ['p'], ipFields: ['x'] } as never);

// @ts-expect-error unknown kind must not type-check
const bad: MaskRuleSet = { rules: [{ kind: 'ip', fields: ['a'] }] };

const err = new MaskRuleError('boom', { code: 'X' });
console.log(out.user.phone, report.explain.length, kinds.length, migrated.droppedKeys, plan.warnings.length, err.pointer, explainRules(plan).length);
