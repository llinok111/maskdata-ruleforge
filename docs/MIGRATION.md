# Migrating from `maskJSON2` to declarative rules

`maskJSON2` keeps working exactly as before. This document is for moving a config
onto `maskJSON3`, either to gain per-rule options and explicit ordering, or to
make an existing config *verifiable*.

Nothing forces the migration. Both APIs share the same mask services, so the
masking arithmetic is identical by construction.

---

## 1. What the legacy shape cannot express

| Capability | `maskJSON2` | `maskJSON3` |
|---|---|---|
| Kind set | fixed by `typeToFunctionMap` | same eight, but unknown kinds are an error instead of being ignored |
| Options per kind | one object per kind | one object per **rule** — two phone rules can use different `maskWith` |
| Execution order | fixed by object literal order inside the source | explicit `order` on every rule |
| Validation | per-kind, throws a bare string | aggregated, JSON-Pointer located, real `Error` |
| Conflict visibility | silent stacking | `error` / `warn` / `allow` |
| Caller's config object | mutated in place | never mutated |

Concretely: upstream `typeToFunctionMap` fixes the sequence to
`card, email, password, phone, string, uuid, jwt, generic`. If you need a
`string` rule to run **before** a `phone` rule on the same field, `maskJSON2`
cannot express it at all.

---

## 2. Automatic conversion

```js
const MaskData = require('maskdata');

const legacy = {
  phoneFields: ['user.phone'],
  phoneMaskOptions: { maskWith: '#', unmaskedStartDigits: 3 },
  emailFields: ['user.email'],
};

const { ruleSet, notes, droppedKeys } = MaskData.migrateLegacyConfig(legacy);

const plan = MaskData.compileRules(ruleSet);   // validates the result
const masked = MaskData.maskJSON3(document, plan);
```

The converter:

1. emits one rule per non-empty `<kind>Fields` array;
2. converts each `genericStrings[i]` entry into its own `generic` rule with
   `order = 70 + i`, preserving per-entry options (upstream applied them in array
   order — the same order is reproduced);
3. **materialises upstream's implicit numeric clamping** into explicit values
   (§3), so the stricter validator accepts the migrated rule set and output stays
   identical;
4. reports every legacy key it did not recognise in `droppedKeys`;
5. sets `onConflict: "allow"` on the result, because legacy configs have no way
   to declare precedence and refusing to compile them would break the migration.

`notes` is an array of `{ ruleId?, message }` describing everything the
conversion did implicitly. Read it — it is the audit trail.

---

## 3. Clamping is made explicit

Upstream silently repaired invalid numbers at runtime. Because the new validator
rejects out-of-range values, the migration rewrites them to the value upstream
would have used:

| Kind | Legacy input | Upstream runtime behaviour | Migrated value |
|---|---|---|---|
| `password` | `maxMaskedCharacters: -5` | `16` | `16` |
| `password` | `fixedOutputLength: 8, maxMaskedCharacters: 4` | `maxMaskedCharacters` becomes `8` | both `8` |
| `password` | `fixedOutputLength: -1` | treated as unset | key omitted |
| `phone` / `card` | `unmaskedStartDigits: -3` | `0` | `0` |
| `email` | `unmaskedStartCharactersBeforeAt: -1` | `0` | `0` |
| `uuid` | `unmaskedStartCharacters: 40` | start `32`, end `0` | `32` / `0` |
| `string` | `maxMaskedCharacters: -1` | `2048` | `2048` |
| `generic` | `maxMaskedCharacters: -1` | `256` | `256` |
| any | `maskWith: ""` | `"*"` | `"*"` |

One clamp is **not** materialised because it depends on the data: `card` also
clamps `unmaskedStartDigits` / `unmaskedEndDigits` to the digit count of each
individual card. The migration records a note instead. Behaviour is unchanged —
the runtime clamp still happens inside `CardMask`.

---

## 4. Differences you will notice

### 4.1 Invalid values now fail instead of being repaired

```js
// maskJSON2: silently clamps to 0 and masks anyway
// maskJSON3: RULE_OPTION_RANGE at /rules/0/options/unmaskedStartDigits
{ kind: 'phone', fields: ['p'], options: { unmaskedStartDigits: -3 } }
```

This is the point of the layer: a redaction rule that quietly behaves differently
from what its config says is a compliance bug, not a convenience. Use
`migrateLegacyConfig` if you want the clamped value written out for you.

### 4.2 Unknown keys and dead patterns are errors

`maskJSON2` ignored `ipFields: [...]` entirely, and silently skipped patterns
like `a.*.b` or `a[*]`. Both are now `RULE_UNKNOWN_KEY` /
`RULE_FIELD_PATTERN`. If your legacy config contained such keys, `droppedKeys`
lists them.

### 4.3 The caller's config is not mutated

`maskJSON2` injected default option objects into the object you passed in:

```js
const cfg = { phoneFields: ['p'] };
MaskData.maskJSON2(doc, cfg);
Object.keys(cfg);
// upstream: [ 'phoneFields', 'cardMaskOptions', 'cardFields', 'emailFields', ... ]
// maskJSON3: [ 'phoneFields' ]
```

If any code relied on that side effect (for example, reusing the mutated object
to discover defaults), read `plan.rules[i].options` instead.

### 4.4 Empty configurations are rejected

`maskJSON2(doc)` with no config masks nothing and returns the document unchanged,
which looks like success. `maskJSON3` refuses an empty `rules` array
(`RULE_FIELDS_EMPTY`). If you genuinely want a pass-through, do not call the
masker.

### 4.5 Non-serialisable documents

`maskJSON2` returned the **original object** when `JSON.parse(JSON.stringify(obj))`
failed (circular references), skipping every mask silently. `maskJSON3` throws
`MASK_INPUT`.

---

## 5. Field-by-field mapping

| Legacy key | New location |
|---|---|
| `cardFields` | `rules[i].fields` with `kind: "card"` |
| `cardMaskOptions` | `rules[i].options` (same rule) |
| `emailFields` | `rules[i].fields` with `kind: "email"` |
| `emailMaskOptions` | `rules[i].options` |
| `passwordFields` / `passwordMaskOptions` | `kind: "password"` |
| `phoneFields` / `phoneMaskOptions` | `kind: "phone"` |
| `stringFields` / `stringMaskOptions` | `kind: "string"` |
| `uuidFields` / `uuidMaskOptions` | `kind: "uuid"` |
| `jwtFields` / `jwtMaskOptions` | `kind: "jwt"` |
| `genericStrings[i].fields` | `rules[j].fields` with `kind: "generic"` |
| `genericStrings[i].config` | `rules[j].options` (**renamed** from `config`) |
| *(no equivalent)* | `ruleSet.defaults`, `order`, `id`, `description`, `onConflict` |

---

## 6. Migration checklist

1. `const { ruleSet, notes, droppedKeys } = MaskData.migrateLegacyConfig(legacy)`
2. Read `droppedKeys`. Every entry was silently ignored before — decide whether
   it was a typo or a feature you thought you had.
3. Read `notes`. Each entry is a behaviour that used to be implicit.
4. `MaskData.compileRules(ruleSet)` — fix anything the strict validator rejects.
5. Run your existing fixtures through both `maskJSON2(legacy)` and
   `maskJSON3(doc, ruleSet)` and assert deep equality. The upstream test suite and
   `tests/testMigration.js` in this repository do exactly this for six fixtures;
   copy the pattern.
6. Only then remove the legacy code path.
7. Commit the migrated `ruleSet` as reviewed JSON, not as generated output, so
   future diffs show intent.

---

## 7. When not to migrate

- You only ever mask one field with one kind: `maskJSON2` is shorter.
- You depend on `maskJSON2` mutating your config object (legacy code often does
  this implicitly to reuse resolved defaults).
- You need the exact upstream error strings. `maskJSON3` raises structured
  `MaskRuleError`s instead; `maskJSON2` still throws its original bare strings.
