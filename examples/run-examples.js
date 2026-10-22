'use strict';

/**
 * Runs every example rule set, prints the masked output, the resolved execution
 * order and a compact trace, then demonstrates error location and legacy
 * migration.
 *
 *   node examples/run-examples.js
 *
 * No assertions live here on purpose — `npm test` is the place for those. This
 * script is for reading output and eyeballing behaviour.
 */

const fs = require('fs');
const path = require('path');
const MaskData = require('../index');

const HARD_RULE = '─'.repeat(72);

function loadRules(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
}

function show(value) {
  return JSON.stringify(value, null, 2);
}

function runScenario(title, file, doc) {
  console.log('\n' + HARD_RULE);
  console.log(title + '  (' + file + ')');
  console.log(HARD_RULE);

  const ruleSet = loadRules(file);
  const plan = MaskData.compileRules(ruleSet);
  const report = MaskData.maskJSON3(doc, plan, { report: true });

  console.log('\n-- execution order --');
  report.explain.forEach(function (entry) {
    console.log(
      '  ' +
        String(entry.position) +
        '. order=' +
        String(entry.order).padStart(3) +
        '  ' +
        entry.kind.padEnd(9) +
        ' ' +
        entry.id
    );
  });

  console.log('\n-- input --');
  console.log(show(doc));
  console.log('\n-- masked --');
  console.log(show(report.result));

  console.log('\n-- trace --');
  report.trace.rules.forEach(function (r) {
    console.log(
      '  ' + r.id + ': matched ' + r.matchedCount + ', changed ' + r.changedCount + '  ' + show(r.matched)
    );
  });
  if (report.plan.warnings.length > 0) {
    console.log('\n-- compile warnings --');
    report.plan.warnings.forEach(function (w) {
      console.log('  [' + w.code + '] ' + w.message);
    });
  }
}

// ---------------------------------------------------------------------------

runScenario('Example 1: basic three-kind rules', 'rules-basic.json', {
  payment: { cardNumber: '4539 1488 0343 6467' },
  customer: { email: 'alice.wong@example.com', phone: '+86 138 1234 5678' },
  orderId: 'ORD-90210',
});

runScenario('Example 2: strict PII posture (PCI-DSS style)', 'rules-pii-strict.json', {
  paymentMethods: [
    { brand: 'visa', pan: '4539148803436467' },
    { brand: 'mc', pan: '5412751234123456' },
  ],
  profile: {
    contact: { email: 'bob@corp.example', mobile: '+1 415 555 0132' },
    password: 'hunter2-but-longer',
  },
  identity: { passportNo: 'E12345678', nationalId: '110101199003077777' },
  meta: { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJib2IifQ.c2ln', cardNumber: '4111111111111111' },
});

runScenario('Example 3: nested API response patterns', 'rules-nested-api.json', {
  users: [
    { name: 'chen', phone: '13812345678' },
    { name: 'liu', phone: '13900001111' },
  ],
  meta: { tags: ['internal', 'beta', 'do-not-share'] },
  audit: { actor: { email: 'auditor@example.com' }, note: 'unchanged' },
});

// ---------------------------------------------------------------------------

console.log('\n' + HARD_RULE);
console.log('Error location: what a bad rule set reports');
console.log(HARD_RULE);

try {
  MaskData.compileRules({
    version: 1,
    rules: [
      { id: 'ok', kind: 'phone', fields: ['user.phone'], options: { unmaskedStartDigits: 3 } },
      { id: 'dead', kind: 'phone', fields: ['a.*.b', 'a[*]'], options: { unmaskedStartDigits: -1 } },
      { id: 'typo', kind: 'phone', fields: ['p'], ipFields: ['p'] },
    ],
  });
} catch (err) {
  console.log('\nname    :', err.name);
  console.log('code    :', err.code, '(first issue; err.issues holds all of them)');
  console.log('message :\n' + err.message);
  console.log('\nissues as data:');
  console.log(show(err.issues));
  console.log('\nJSON-safe for structured logs:');
  console.log(show(err.toJSON()));
}

// ---------------------------------------------------------------------------

console.log('\n' + HARD_RULE);
console.log('Legacy migration: maskJSON2 config -> declarative rule set');
console.log(HARD_RULE);

const legacy = {
  phoneFields: ['user.phone'],
  phoneMaskOptions: { maskWith: '#', unmaskedStartDigits: -3 },
  passwordFields: ['user.password'],
  passwordMaskOptions: { maxMaskedCharacters: -5 },
  ipFields: ['user.ip'],
};

const migration = MaskData.migrateLegacyConfig(legacy);

console.log('\n-- migrated rule set --');
console.log(show(migration.ruleSet));
console.log('\n-- dropped legacy keys (silently ignored upstream) --');
console.log(show(migration.droppedKeys));
console.log('\n-- notes --');
migration.notes.forEach(function (n) {
  console.log('  ' + (n.ruleId ? '[' + n.ruleId + '] ' : '') + n.message);
});

console.log('\nDone.');
