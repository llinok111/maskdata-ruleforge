# Implementation notes

Factual record of what was verified, what was built, what was tested, and what is
known to be missing. No performance numbers are claimed because no benchmark was
run.

---

## 1. Upstream verification

| Item | Verified value |
|---|---|
| Repository | `https://github.com/Sumukha1496/maskdata` |
| Commit used | `ccfab5b88d2a6da2153c41a45dacce30d80f5392` (`fix: package.json & package-lock.json to reduce vulnerabilities (#57)`, 2026-03-11) |
| Branches cloned | full history, 80 commits |
| Stars / forks at time of review | 107 / 10 |
| License file | `LICENSE`, MIT, `Copyright (c) 2019 SUMUKHA H S` — reproduced verbatim |
| `package.json` license field | `"MIT"` — consistent with the LICENSE file |
| Published version reviewed | `1.3.4` |
| Language / runtime | CommonJS, Node.js, single runtime dependency: `lodash` |
| Test framework | mocha + chai, `tests/test*.js` |
| Baseline before any change | **186 passing**, 0 failing (`npx mocha "tests/test*.js"`) |

Verification was done by cloning the repository and reading the source, not from
search summaries. Files read in full: `LICENSE`, `package.json`, `index.js`,
`index.d.ts`, `lib/helpers/Constants.js`, `lib/helpers/MaskHelper.js`,
`lib/helpers/jsonGetSet.js`, `lib/maskService/{JsonMask,CardMask,EmailMask,PasswordMask,PhoneMask,StringMask,UuidMask,JwtMask}.js`,
`lib/ExceptionsHandler/BadOption.js`, plus the `Mask JSON` sections of `README.md`.

### 1.1 Marketing vs implementation

The README's claims hold for what it advertises — masking eight data types in one
call, `. *` / `[*].` / recursive `*field` patterns, configurable per-kind options.
The gap is in what "configurable" means, established by running probes rather
than by reading prose:

| Observed behaviour | Evidence |
|---|---|
| Kind set is closed and hard-coded in `typeToFunctionMap` | `lib/maskService/JsonMask.js:15-24` |
| Execution order is fixed by that object's literal order; a caller cannot ask for `string` before `phone` | probe: two semantically identical configs written in different key order produce the same result, because config key order is ignored and the internal order wins |
| Unknown config keys are silently ignored | `maskJSON2(doc, { ipFields: ['user.contact'] })` returns the document unchanged, no error, no warning |
| Malformed field patterns are silently discarded | `JsonMask.mask()` lines 88-93 `return` on `a.*.b` and `*a.b`; `a[*]` falls through to `_.get` and yields `undefined` |
| Errors are thrown as bare strings | `BadOption.throwBadOptionException()` does `throw \`Bad config value : ...\`` → `catch (e) { e.message }` is `undefined`, `e instanceof Error` is `false` |
| The caller's config object is mutated | `getValidatedJsonMask2Configs` assigns 12 keys into the object passed in |
| The default config masks nothing | `defaultjsonMask2Configs` has all `<kind>Fields: []`, so `maskJSON2(obj)` returns `obj` unchanged |

That last row matters most for a second-party build: a pipeline that "runs the
masker" and logs success can be shipping unmasked PII.

### 1.2 Licence position

MIT permits commercial use, modification, redistribution and sublicensing,
provided the copyright notice and permission notice are retained. This build
therefore:

- keeps `LICENSE` byte-identical;
- adds `NOTICE` with the upstream attribution and an explicit list of changes;
- preserves the upstream git history (the derivative commits sit on top of
  `ccfab5b`);
- marks the package `"private": true` and uses a pre-release version
  (`1.3.4-ruleforge.1`) so it cannot be confused with, or accidentally published
  over, the upstream npm package.

No copyleft obligation is triggered; nothing here needs to be released under a
different licence.

---

## 2. What was built

### 2.1 New files

| File | Purpose |
|---|---|
| `lib/rules/MaskRuleError.js` | `MaskRuleError extends Error`; `code`, `pointer` (RFC 6901), `maskPath`, `ruleIndex`, `ruleId`, `issues[]`, `toJSON()` |
| `lib/rules/RuleSchema.js` | Closed kind enum, per-kind option specs (type/min/max/minLength/optional), baseline orders, forbidden keys |
| `lib/rules/FieldPattern.js` | Pattern parser (5 accepted forms, 8 named rejection reasons) and target collector returning `{parent, key, path}` references |
| `lib/rules/RuleCompiler.js` | Shape/option/safety validation with aggregated issues, three-layer default resolution, stable sort, static overlap warnings, frozen plan + `explain()` |
| `lib/rules/RuleEngine.js` | Plan execution on a structural clone, per-rule target de-duplication, trace collection, runtime same-order conflict detection, upstream string-throw normalisation |
| `lib/rules/LegacyMigration.js` | `maskJSON2` config → rule set, materialising upstream clamping and reporting dropped keys |
| `tests/testRules.js` | 62 tests |
| `tests/testMigration.js` | 21 tests |
| `examples/rules-basic.json` | Explicit ordering, three kinds |
| `examples/rules-pii-strict.json` | PCI-DSS-style posture, six rules |
| `examples/rules-nested-api.json` | `[*]`, `.*` and `*name` patterns |
| `examples/run-examples.js` | Runnable demo: output, order, trace, error shape, migration |
| `types-check/consumer.ts` + `tsconfig.json` | Compile-time consumption test for `index.d.ts` |
| `docs/RULES.md` | Rule reference |
| `docs/MIGRATION.md` | Migration guide |
| `NOTICE` | Attribution and change list |

### 2.2 Modified upstream files

| File | Change |
|---|---|
| `index.js` | Added `compileRules`, `maskJSON3`, `explainRules`, `migrateLegacyConfig`, and the `RuleError` / `ERROR_CODES` / `KIND_NAMES` / `parseFieldPattern` statics. **No existing method was touched; `maskJSON2` is byte-identical.** |
| `index.d.ts` | Appended rule-layer types and function declarations. Existing declarations untouched. |
| `package.json` | `version`, `description`, `private`, and three scripts (`test:rules`, `examples`, `typecheck`). |
| `README.md` | Fork notice + a `Declarative rules (maskJSON3)` section + one TOC entry. |

`lib/maskService/*` and `lib/helpers/*` are **unmodified** — that is what makes
output parity structural rather than coincidental.

### 2.3 How each requirement is met

| Requirement | Implementation | Test coverage |
|---|---|---|
| Rule validation | `RuleCompiler` collects every issue instead of failing fast; unknown keys/kinds/options, wrong types, out-of-range values, duplicate ids, empty rule sets | tests A1–A17 |
| Default values | `resolveOptions`: kind defaults → `ruleSet.defaults` → `rule.options`; resolved options readable on the plan | tests C1–C7 |
| Error location | `MaskRuleError.pointer` = `/rules/<i>/options/<name>`, `/rules/<i>/fields/<j>`; `ruleIndex`/`ruleId` stamped on every issue | tests A5, A11–A14 |
| Predictable execution order | Integer `order` ascending, ties by declaration index; `explain()` before, `trace.rules` after | tests D1–D5 |
| No script execution | Closed 8-kind enum; functions / `Symbol` / `RegExp` / `__proto__` / `constructor` / `prototype` rejected; targets written via object references, never `_.set(userPath)` | tests B1–B5 |
| Regression tests for old behaviour | The upstream 186 tests run unmodified, plus 6 migration fixtures asserting `maskJSON3` deep-equals `maskJSON2` | 186 + F1–F10, migration suite |

---

## 3. Test environment and results

| Item | Value |
|---|---|
| OS | Windows (win32) |
| Node.js | v22.22.2 |
| npm | 10.9.7 |
| Registry used | `https://registry.npmmirror.com` |
| mocha / chai | as pinned by upstream `package.json` (`^10.2.0` / `^4.3.10`) |
| TypeScript | `^5.9.3` (upstream devDependency) |

Commands and observed results:

| Command | Result |
|---|---|
| `npm test` (all `tests/test*.js`) | **269 passing, 0 failing** (~60 ms) |
| `npx mocha "tests/test*.js"` before any change | 186 passing, 0 failing |
| `npm run typecheck` | exit 0 (strict mode, `consumer.ts` compiled against `index.d.ts`) |
| `node examples/run-examples.js` | exits 0; three scenarios plus error/migration demos printed |

Per-file counts (sum 269):

```
testCard 12 · testEmail 19 · testJsonFields 15 · testJsonGetSet 7 · testJwt 22
testMaskHelper 4 · testPassword 25 · testPhone 13 · testString 33 · testStringV2 25
testUuid 11 · testRules 62 · testMigration 21
```

The upstream 186 are unchanged from the baseline — no upstream assertion was
relaxed, skipped or edited.

---

## 4. Known limitations

These are real and not worked around:

1. **Option semantics are not validated against data.** Static ranges are checked
   (`unmaskedStartCharacters ≤ 32` for uuid); whether `unmaskedStartDigits: 6`
   makes sense for your 4-digit field is not, and cannot be without seeing the data.
2. **`card` runtime clamping is not materialised by the migration.** `CardMask`
   clamps digit indices to each card's digit count at runtime. The migration notes
   this instead of guessing a value.
3. **Static overlap detection is textual.** Two rules are flagged as overlapping
   only when their pattern strings are identical after canonicalisation
   (`a.b` vs `*.b` overlap is detected at execution time, not compile time).
4. **Upstream `BadOption` still throws bare strings on the `maskJSON2` path.** This
   is intentional: converting them to `Error` would change `catch` behaviour for
   existing callers. Only `maskJSON3` normalises them to `MaskRuleError`
   (`MASK_RUNTIME`).
5. **`BigInt` and circular references are rejected** (`MASK_INPUT`) rather than
   passed through. `maskJSON2` returned the original object unchanged in that case,
   silently skipping every mask — that is treated as a bug, not behaviour to keep.
6. **`Date` / `Map` / `Set` values are flattened by the clone.** `maskJSON3` clones
   via `JSON.parse(JSON.stringify(...))`, exactly like `maskJSON2`, so a `Date`
   becomes an ISO string before masking. Consistent with upstream, but worth knowing.
7. **Trace paths for keys containing `.` are ambiguous.** Targets are written
   through `{parent, key}` references so masking is always correct; only the
   human-readable `path` string in the trace can be misread.
8. **No browser/bundler validation.** The layer is pure CommonJS with one `lodash`
   import inherited from upstream; no ESM build or bundler test was performed.
9. **No performance benchmark.** Complexity is `O(rules × targets)` per document
   with target de-duplication per rule; no throughput numbers are claimed.
10. **`string` vs `generic` option split is upstream legacy.** `generic` has no
    `maskAll`; use `kind: "string"` with `maskAll: true` to replace every
    character. Documented in `docs/RULES.md` §2 and the README.

## 5. Publication status

- **Published**: <https://github.com/llinok111/maskdata-ruleforge> — public, MIT,
  default branch `master`, the 80 upstream commits plus the derivative commits on
  top (run `git log --oneline` for the exact count; it is deliberately not
  hard-coded here because updating this document would change it). Pushed over SSH
  (`ssh.github.com:443`) because plain `github.com:443` git-over-HTTPS times out
  from this network.
- **Caveat on the figures**: they are committed in the repository and their byte
  sizes were verified through the API, but `raw.githubusercontent.com` is
  unreachable from the build machine, so the rendered `<img>` was not fetched back
  over HTTP. Display depends on the visitor's network reaching GitHub's image
  proxy.
- **Not** published to npm. The package is `private` and versioned
  `1.3.4-ruleforge.1`; the `maskdata` name on npm belongs to upstream.
- No CI workflow added.
- No benchmark suite.
- No Node version matrix (single runtime: v22.22.2).

---

## 6. Figures

The three README figures are **generated from live output**, not drawn by hand:

```bash
node docs/img/_build/build-images.cjs
```

The script calls `maskJSON3` for real, then bakes the resulting masked strings,
`plan.explain()` rows, trace counters and the actual `MaskRuleError` text into the
HTML templates before rendering with headless Microsoft Edge at 2× device scale.
Consequence: if the code output changes, the figures change with it — they cannot
drift silently.

| File | Content | Source of the numbers |
|---|---|---|
| `docs/img/architecture.png` | `maskJSON2` vs `maskJSON3` pipeline, and the three silent failure points | static structure of `JsonMask.js` + `lib/rules/` |
| `docs/img/run-through.png` | input document → resolved order → masked output → trace | live run against `examples/rules-basic.json` |
| `docs/img/error-location.png` | a real aggregated `MaskRuleError` and an upstream `throw` comparison | live `compileRules` failure + live `maskPhone` throw |

Verification performed on the rendered PNGs:

- **Geometry probe** (automated, part of the build): a synchronous script walks
  every element and reports any node escaping the canvas or clipped by an
  `overflow:hidden` container. All three figures report `LAYOUT_OK`.
- **Pixel check**: 3040 px wide @2×; zero non-background pixels within 4 px of any
  border; ink coverage 51–66 %; 5 300–7 400 distinct colours (i.e. real text
  rendering, not a blank or flat-fill image).

Not verified automatically: legibility and aesthetic judgement. Those still need
a human looking at the image.

