# Declarative rule reference

`maskJSON2` decides *what* to mask from a flat config object whose behaviour is
partly hard-coded. This layer turns the same capability into an explicit,
validated, ordered rule set.

```js
const MaskData = require('maskdata');

const plan = MaskData.compileRules(ruleSet);   // validate once
const masked = MaskData.maskJSON3(document, plan);  // execute many times
```

Nothing here changes `maskJSON2`. Both APIs coexist.

---

## 1. Rule set shape

```json
{
  "version": 1,
  "onConflict": "error",
  "defaults": { "maskWith": "#" },
  "rules": [
    {
      "id": "customer-phone",
      "kind": "phone",
      "order": 10,
      "fields": ["customer.phone", "contacts[*].phone"],
      "options": { "unmaskedStartDigits": 3, "unmaskedEndDigits": 2 },
      "description": "Keep country prefix + last two digits"
    }
  ]
}
```

| Key | Required | Meaning |
|---|---|---|
| `version` | no | Must be `1` when present. Reserved for future breaking changes. |
| `onConflict` | no | `"error"` (default) \| `"warn"` \| `"allow"`. See §5. |
| `defaults` | no | Options injected into every rule that accepts them. Lowest precedence. |
| `rules` | **yes** | Non-empty array. |

Rule object:

| Key | Required | Meaning |
|---|---|---|
| `kind` | **yes** | One of the eight kinds in §2. Unknown kinds are rejected. |
| `fields` | **yes** | Non-empty array of field patterns (§3). |
| `options` | no | Kind-specific masking options (§2). |
| `order` | no | Integer. Lower runs first. Defaults to the kind's baseline order. |
| `id` | no | Unique string. Defaults to `rule<N>` by declaration index. Shown in errors and traces. |
| `description` | no | Free text, echoed by `explain()`. |

Any key not listed above is a hard error. This is deliberate: upstream silently
ignored misspelled keys such as `ipFields`, which is how a "configured"
redaction pipeline ends up masking nothing.

---

## 2. Kinds and options

Eight closed kinds. There is no plugin mechanism and no way to register a
callback — a rule set is data.

### `card`
| Option | Type | Default | Range |
|---|---|---|---|
| `maskWith` | string | `"*"` | length ≥ 1 |
| `unmaskedStartDigits` | integer | `4` | ≥ 0 |
| `unmaskedEndDigits` | integer | `1` | ≥ 0 |

Only digits are replaced; `-` and spaces are preserved.

### `email`
| Option | Type | Default | Range |
|---|---|---|---|
| `maskWith` | string | `"*"` | length ≥ 1 |
| `unmaskedStartCharactersBeforeAt` | integer | `3` | ≥ 0 |
| `unmaskedEndCharactersAfterAt` | integer | `2` | ≥ 0 |
| `maskAtTheRate` | boolean | `false` | — |

Values without `@` raise `MASK_RUNTIME` at execution time, located to the field.

### `password`
| Option | Type | Default | Range |
|---|---|---|---|
| `maskWith` | string | `"*"` | length ≥ 1 |
| `maxMaskedCharacters` | integer | `16` | ≥ 0 |
| `fixedOutputLength` | integer | *(unset)* | ≥ 0 |
| `unmaskedStartCharacters` | integer | `0` | ≥ 0 |
| `unmaskedEndCharacters` | integer | `0` | ≥ 0 |

`fixedOutputLength` overrides `maxMaskedCharacters` (upstream behaviour kept).

### `phone`
| Option | Type | Default | Range |
|---|---|---|---|
| `maskWith` | string | `"*"` | length ≥ 1 |
| `unmaskedStartDigits` | integer | `4` | ≥ 0 |
| `unmaskedEndDigits` | integer | `1` | ≥ 0 |

### `string`
Masks *specific substrings* inside a value (v1 semantics).

| Option | Type | Default | Range |
|---|---|---|---|
| `maskWith` | string | `"*"` | length ≥ 1 |
| `maskAll` | boolean | `false` | — |
| `maskSpace` | boolean | `true` | — |
| `maskOnlyFirstOccurance` | boolean | `false` | — |
| `values` | string[] | `[]` | — |
| `maxMaskedCharacters` | integer | `2048` | ≥ 0 |

If `maskAll` is `false` and `values` is empty the rule cannot change anything.
The compiler emits a `RULE_NO_EFFECT` warning rather than letting you ship a
no-op redaction rule.

### `uuid`
| Option | Type | Default | Range |
|---|---|---|---|
| `maskWith` | string | `"*"` | length ≥ 1 |
| `unmaskedStartCharacters` | integer | `0` | 0–32 |
| `unmaskedEndCharacters` | integer | `0` | 0–32 |

Non-UUID values pass through untouched.

### `jwt`
| Option | Type | Default | Range |
|---|---|---|---|
| `maskWith` | string | `"*"` | length ≥ 1 |
| `maxMaskedCharacters` | integer | `512` | ≥ 0 |
| `maskDot` | boolean | `true` | — |
| `maskHeader` | boolean | `true` | — |
| `maskPayload` | boolean | `true` | — |
| `maskSignature` | boolean | `true` | — |

Values that are not three-part tokens pass through untouched.

### `generic`
Masks a value with fixed-length / prefix-suffix semantics (StringMask v2).

| Option | Type | Default | Range |
|---|---|---|---|
| `maskWith` | string | `"*"` | length ≥ 1 |
| `maxMaskedCharacters` | integer | `256` | ≥ 0 |
| `fixedOutputLength` | integer | *(unset)* | ≥ 0 |
| `unmaskedStartCharacters` | integer | `0` | ≥ 0 |
| `unmaskedEndCharacters` | integer | `0` | ≥ 0 |

> `generic` has **no** `maskAll` / `values`. To replace every character use
> `kind: "string"` with `maskAll: true`. This mirrors the upstream split between
> `maskString` and `maskStringV2` and is the most common source of confusion.

---

## 3. Field pattern syntax

| Form | Meaning | Example |
|---|---|---|
| `a.b.c` | exact path | `user.profile.phone` |
| `a[*].b` | every element of array `a` | `cards[*].number` |
| `a.*` | every leaf below `a`, recursively | `emails.*` |
| `*name` | every key called `name`, at any depth | `*phone` |
| `[*].b` | root document is the array | `[*].id` |

`.*` is only valid as the **final** segment. `*name` must be a bare name with no
`.`, `[` or second `*`.

### Rejected patterns

These are silently discarded by upstream `maskJSON2` — a mask rule that never
fires is the most dangerous failure mode in a redaction pipeline, so every one of
them raises `RULE_FIELD_PATTERN` with the exact `/rules/<i>/fields/<j>` pointer:

| Pattern | Why it is rejected |
|---|---|
| `a..b` | empty path segment |
| `.a` / `a.` | leading / trailing dot |
| `a.*.b` | `.*` is not the final segment |
| `*a.b` | recursive form cannot contain a dot |
| `a[*]` | trailing `[*]` has no field to mask |
| `a[*][*].b` | one array level per pattern |
| `a[0].b` | literal index unsupported; use `[*]` or a concrete path |
| `a.**` | `*` inside a segment name |
| `""` | empty pattern |

---

## 4. Deterministic execution order

Rules execute by ascending `order`. Ties are broken by **declaration index**, so
the order is a pure function of the rule set — no object key iteration, no
`Map` insertion subtleties, no dependency on how you happened to write the JSON.

Baseline orders (identical to upstream's hard-coded `typeToFunctionMap` order, so
a migrated config keeps its output):

| kind | card | email | password | phone | string | uuid | jwt | generic |
|---|---|---|---|---|---|---|---|---|
| order | 0 | 10 | 20 | 30 | 40 | 50 | 60 | 70 |

Order matters whenever two rules touch the same field, because the second rule
sees the first rule's output:

```js
// string first: 'abcdef' -> '######' -> phone keeps 2+2 chars -> '##**##'
{ rules: [
  { id: 's', kind: 'string', order: 1, fields: ['v'], options: { maskAll: true, maskWith: '#' } },
  { id: 'p', kind: 'phone',  order: 2, fields: ['v'], options: { unmaskedStartDigits: 2, unmaskedEndDigits: 2 } }
]}

// phone first: 'abcdef' -> 'ab**ef' -> string masks everything -> '######'
```

`explain()` is the contract. Whatever it prints is what runs:

```js
plan.explain();
// [ { position: 0, id: 's', kind: 'string', order: 1, fields: ['v'], options: {...} }, ... ]
```

`maskJSON3(doc, plan, { report: true }).trace.rules` returns the same sequence,
so you can assert order in a test rather than trusting the docs.

---

## 5. Conflicts

Two rules matching the **same concrete field** with the **same `order`** is
ambiguous: their relative sequence is decided only by declaration position.

| `onConflict` | Behaviour |
|---|---|
| `"error"` *(default)* | Throws `RULE_ORDER_CONFLICT` naming the field and both rule ids. |
| `"warn"` | Masks anyway, records the conflict in `trace.conflicts`, appends a warning entry. |
| `"allow"` | Masks anyway, records the conflict in `trace.conflicts`, no warning. |

Different `order` values never conflict — that is an intentional stacking, and
`explain()` already tells you the sequence.

The compiler also emits non-fatal warnings:

- `RULE_ORDER_CONFLICT` — the same pattern text claimed by two rules.
- `RULE_NO_EFFECT` — a `string` rule with neither `maskAll` nor `values`.

---

## 6. Default resolution

Three layers, lowest precedence first:

1. the kind's built-in defaults (the table in §2)
2. `ruleSet.defaults`
3. `rule.options`

A key in `defaults` that the kind does not accept is ignored for that rule (so one
global `maskWith` can serve every kind). A key that **no** kind accepts is a
`RULE_OPTION_UNKNOWN` error.

The resolved options are visible on the compiled plan, so you can assert them:

```js
MaskData.compileRules({ defaults: { maskWith: '#' }, rules: [{ kind: 'phone', fields: ['v'] }] })
  .rules[0].options;
// { maskWith: '#', unmaskedStartDigits: 4, unmaskedEndDigits: 1 }
```

---

## 7. Errors

Every failure is a `MaskRuleError` — a real `Error` with a stack. Upstream
`BadOption` throws a bare string, which is why `catch (e) { e.message }` was
always `undefined` there.

```js
try {
  MaskData.compileRules(ruleSet);
} catch (err) {
  err.name;      // 'MaskRuleError'
  err.code;      // e.g. 'RULE_FIELD_PATTERN'
  err.pointer;   // '/rules/1/fields/0'
  err.ruleIndex; // 1
  err.ruleId;    // 'customer-phone'
  err.issues;    // ALL issues, not just the first
  err.toJSON();  // log-safe
}
```

Validation does **not** fail fast. One compile run reports every problem, so you
fix the config in one pass.

| Code | Raised when |
|---|---|
| `RULE_SET_SHAPE` | rule set / rule / defaults is not a plain object; `rules` missing or not an array; bad `onConflict` |
| `RULE_SET_VERSION` | `version` present and not `1` |
| `RULE_SHAPE` | rule-level shape errors: bad `id`, non-integer `order`, non-array `fields`, non-object `options` |
| `RULE_UNKNOWN_KEY` | unknown key at the rule-set or rule level |
| `RULE_KIND_UNKNOWN` | `kind` not one of the eight |
| `RULE_OPTION_UNKNOWN` | option (or default) not accepted by the kind |
| `RULE_OPTION_TYPE` | wrong type |
| `RULE_OPTION_RANGE` | out of range / too short |
| `RULE_FIELDS_EMPTY` | empty `rules` or empty `fields` |
| `RULE_FIELD_PATTERN` | malformed field pattern |
| `RULE_ORDER_CONFLICT` | same-order collision (error or warning, see §5) |
| `RULE_UNSAFE_VALUE` | function, Symbol, RegExp, or prototype-pollution key inside a rule set |
| `RULE_NO_EFFECT` | warning only: a rule that cannot change anything |
| `MASK_INPUT` | document is not an object/array, or is not JSON-serialisable |
| `MASK_RUNTIME` | the upstream mask service rejected a value at execution time |

---

## 8. Security boundary

A rule set is **pure data**:

- `kind` is a closed enum of eight strings; there is no loader, no `eval`, no
  `new Function`, no `require` of user-supplied paths.
- Option values must be JSON scalars or arrays of scalars. Functions, `Symbol`s
  and `RegExp` instances are rejected at compile time (`RULE_UNSAFE_VALUE`), so
  the same rule set behaves identically after a JSON round-trip.
- `__proto__`, `constructor` and `prototype` keys are rejected in `defaults`,
  rule objects, options and field patterns.
- Targets are collected as `{parent, key}` references and written directly. The
  engine never calls `lodash.set` with a user-derived path, so a rule cannot
  create keys that did not exist in the input.
- The input document is cloned before masking; the caller's object is never
  mutated.

What this explicitly does **not** do: it cannot validate that your chosen
`options` are *semantically* correct for your data (for example
`unmaskedStartDigits: 6` on a 4-digit field). Static option ranges are checked;
data-dependent bounds are not.

---

## 9. Report mode

```js
const { result, plan, trace, explain } = MaskData.maskJSON3(doc, ruleSet, { report: true });
```

`trace` shape:

```js
{
  onConflict: 'error',
  warnings: [ /* compile-time warnings */ ],
  conflicts: [ { path: 'p', order: 10, ruleIds: ['A', 'B'] } ],
  rules: [
    {
      position: 0, id: 'A', kind: 'phone', order: 10,
      matchedCount: 1, changedCount: 1,
      matched: ['p'], truncated: false
    }
  ]
}
```

`matched` holds field paths only — never values — so a trace is safe to log.
It is capped by `maxTraceEntries` (default `1000`); `truncated: true` signals the
cap was hit while `matchedCount` stays exact.

Pass `{ trace: false }` to skip path collection entirely on hot paths.

---

## 10. Worked example

```js
const MaskData = require('maskdata');

const ruleSet = {
  version: 1,
  defaults: { maskWith: '#' },
  rules: [
    { id: 'card', kind: 'card', order: 10, fields: ['payment.cards[*].number'],
      options: { unmaskedStartDigits: 0, unmaskedEndDigits: 4 } },
    { id: 'email', kind: 'email', order: 20, fields: ['customer.email', '*email'] },
    { id: 'phone', kind: 'phone', order: 30, fields: ['*phone'],
      options: { unmaskedStartDigits: 3, unmaskedEndDigits: 2 } },
  ],
};

const order = MaskData.maskJSON3({}, ruleSet, { report: true }).explain.map((r) => r.id);
// ['card', 'email', 'phone']
```

More runnable examples live in `examples/`:

| File | Scenario |
|---|---|
| `rules-basic.json` | three kinds, explicit order |
| `rules-pii-strict.json` | PCI/GDPR-style: card + email + phone, maximal masking |
| `rules-nested-api.json` | array wildcards and recursive name matching |
| `run-examples.js` | runs all three and prints output + explain + trace |
