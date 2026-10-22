declare module 'maskdata' {
  export interface CardMaskOptions {
    maskWith?: string;
    unmaskedStartDigits?: number;
    unmaskedEndDigits?: number;
  }

  export interface EmailMask2Options {
    maskWith?: string;
    unmaskedStartCharactersBeforeAt?: number;
    unmaskedEndCharactersAfterAt?: number;
    maskAtTheRate?: boolean;
  }

  export interface JsonMaskOptions {
    maskWith?: string;
    fields?: string[];
    maxMaskedCharactersStr?: number;
  }

  export interface PasswordMaskOptions {
    maskWith?: string;
    maxMaskedCharacters?: number;
    fixedOutputLength?: undefined | number;
    unmaskedStartCharacters?: number;
    unmaskedEndCharacters?: number;
  }

  export interface StringMaskV2Options {
    maskWith?: string;
    maxMaskedCharacters?: number;
    fixedOutputLength?: undefined | number;
    unmaskedStartCharacters?: number;
    unmaskedEndCharacters?: number;
  }

  export interface GenericStringMaskOptions {
    config?: StringMaskV2Options;
    fields: string[];
  }

  export interface PhoneMaskOptions {
    maskWith?: string;
    unmaskedStartDigits?: number;
    unmaskedEndDigits?: number;
  }

  export interface StringMaskOptions {
    maskWith?: string;
    maskOnlyFirstOccurance?: boolean;
    values?: string[];
    maskAll?: boolean;
    maskSpace?: boolean;
    maxMaskedCharacters?: number;
  }

  export interface UuidMaskOptions {
    maskWith?: string;
    unmaskedStartCharacters?: number;
    unmaskedEndCharacters?: number;
  }

  export interface JwtMaskOptions {
    maskWith?: string;
    maxMaskedCharacters?: number;
    maskDot?: boolean;
    maskHeader?: boolean;
    maskPayload?: boolean;
    maskSignature?: boolean;
  }

  export interface JsonMask2Configs {
    cardMaskOptions?: CardMaskOptions;
    cardFields?: string[];
    emailMaskOptions?: EmailMask2Options;
    emailFields?: string[];
    passwordMaskOptions?: PasswordMaskOptions;
    passwordFields?: string[];
    phoneMaskOptions?: PhoneMaskOptions;
    phoneFields?: string[];
    stringMaskOptions?: StringMaskOptions;
    stringFields?: string[];
    uuidMaskOptions?: UuidMaskOptions;
    uuidFields?: string[];
    jwtMaskOptions?: JwtMaskOptions;
    jwtFields?: string[];
    genericStrings?: GenericStringMaskOptions[];
  }

  export function maskPassword(password?: string, options?: PasswordMaskOptions): string;
  export function maskJSON2<T extends object>(json?: T, options?: JsonMask2Configs): T;
  export function maskPhone(phone?: string, options?: PhoneMaskOptions): string;
  export function maskEmail2(email?: string, options?: EmailMask2Options): string;
  export function maskCard(cardNumber?: string, options?: CardMaskOptions): string;
  /**
   * @deprecated since version 1.3.3
   * This function will be removed in future versions.
   * Use `maskStringV2` instead.
   */
  export function maskString(str?: string, options?: StringMaskOptions): string;
  export function maskStringV2(str?: string, options?: StringMaskV2Options): string;
  export function maskUuid(uuid?: string, options?: UuidMaskOptions): string;
  export function maskJwt(jwt?: string, options?: JwtMaskOptions): string;
  export function getInnerProperty(object: object, field: string): any;
  export function replaceValue(object: object, field: string, value: any): object;

  // ---------------------------------------------------------------------------
  // Declarative rule layer (maskJSON3 / compileRules / migrateLegacyConfig)
  // Runtime note: these are static members of the exported MaskData class, e.g.
  //   const MaskData = require('maskdata');
  //   const plan = MaskData.compileRules(ruleSet);
  //   MaskData.maskJSON3(json, plan);
  // `MaskData.RuleError` is the class below; `MaskData.ERROR_CODES` the code map.
  // ---------------------------------------------------------------------------

  export type MaskKind =
    | 'card'
    | 'email'
    | 'password'
    | 'phone'
    | 'string'
    | 'uuid'
    | 'jwt'
    | 'generic';

  export type ConflictPolicy = 'error' | 'warn' | 'allow';

  export type MaskRuleOptions =
    | CardMaskOptions
    | EmailMask2Options
    | PasswordMaskOptions
    | PhoneMaskOptions
    | StringMaskOptions
    | UuidMaskOptions
    | JwtMaskOptions
    | StringMaskV2Options;

  export interface RuleIssue {
    code: string;
    pointer: string;
    message: string;
    maskPath?: string;
    ruleIndex?: number;
    ruleId?: string;
    value?: unknown;
    hint?: string;
  }

  export class MaskRuleError extends Error {
    constructor(
      message: string,
      details?: {
        code?: string;
        pointer?: string;
        maskPath?: string;
        ruleIndex?: number;
        ruleId?: string;
        value?: unknown;
        hint?: string;
        issues?: RuleIssue[];
      }
    );
    name: 'MaskRuleError';
    code: string;
    /** RFC 6901 JSON Pointer into the rule set document, e.g. `/rules/1/options/maskWith`. */
    pointer: string;
    maskPath?: string;
    ruleIndex?: number;
    ruleId?: string;
    value?: unknown;
    hint?: string;
    issues: RuleIssue[];
    toJSON(): object;
  }

  export interface MaskRule {
    id?: string;
    kind: MaskKind;
    /** Lower runs first; ties are broken by declaration index. */
    order?: number;
    /**
     * Supported forms:
     *   "a.b.c"       exact path
     *   "cards[*].id" array index wildcard
     *   "a.*"         all leaves below `a` (final segment only)
     *   "*name"       recursive name match (no dots)
     *   "[*].id"      document root is the array
     */
    fields: string[];
    options?: MaskRuleOptions;
    description?: string;
  }

  export interface MaskRuleSet {
    version?: 1;
    /** Applied to every rule that accepts the option; rule-level `options` win. */
    defaults?: MaskRuleOptions;
    rules: MaskRule[];
    onConflict?: ConflictPolicy;
  }

  export interface ParsedField {
    raw: string;
    pointer: string;
    parsed: {
      type: 'path' | 'recursive';
      name?: string;
      segments?: Array<{ kind: 'key' | 'index' | 'leaves'; name?: string }>;
    };
  }

  export interface CompiledRule {
    readonly index: number;
    readonly id: string;
    readonly kind: MaskKind;
    readonly order: number;
    readonly description?: string;
    readonly fields: ReadonlyArray<ParsedField>;
    readonly options: Readonly<Record<string, unknown>>;
    readonly pointer: string;
  }

  export interface PlanWarning {
    code: string;
    message: string;
    pointer?: string;
    ruleIndex?: number;
    ruleId?: string;
  }

  export interface ExplainedRule {
    position: number;
    id: string;
    kind: MaskKind;
    order: number;
    fields: string[];
    options: Record<string, unknown>;
    description?: string;
  }

  export interface CompiledPlan {
    readonly version: 1;
    readonly onConflict: ConflictPolicy;
    readonly warnings: ReadonlyArray<PlanWarning>;
    readonly rules: ReadonlyArray<CompiledRule>;
    /** The authoritative execution order: whatever this prints is what runs. */
    explain(): ExplainedRule[];
    isEmpty(): boolean;
  }

  export interface TraceRule {
    position: number;
    id: string;
    kind: MaskKind;
    order: number;
    fields: string[];
    matchedCount: number;
    changedCount: number;
    matched: string[];
    truncated: boolean;
    warning?: boolean;
    message?: string;
  }

  export interface MaskTrace {
    onConflict: ConflictPolicy;
    warnings: ReadonlyArray<PlanWarning>;
    conflicts: Array<{ path: string; order: number; ruleIds: string[] }>;
    rules: TraceRule[];
  }

  export interface MaskReport<T> {
    result: T;
    plan: CompiledPlan;
    trace: MaskTrace;
    explain: ExplainedRule[];
  }

  export interface CompileOptions {
    onConflict?: ConflictPolicy;
  }

  export interface MaskJSON3Options extends CompileOptions {
    /** Reuse an already compiled plan instead of passing a rule set. */
    plan?: CompiledPlan;
    /** Return { result, plan, trace, explain } instead of just the masked clone. */
    report?: boolean;
    trace?: boolean;
    maxTraceEntries?: number;
  }

  export interface MigrationNote {
    ruleId?: string;
    message: string;
  }

  export interface MigrationResult {
    ruleSet: MaskRuleSet;
    notes: MigrationNote[];
    droppedKeys: string[];
  }

  export interface FieldPatternResult {
    ok: boolean;
    parsed?: ParsedField['parsed'];
    error?: { reason: string; detail: string };
  }

  export function compileRules(ruleSet: MaskRuleSet, options?: CompileOptions): CompiledPlan;
  export function explainRules(plan: CompiledPlan): ExplainedRule[];
  export function maskJSON3<T extends object>(
    json: T,
    ruleSet: MaskRuleSet | CompiledPlan,
    options: MaskJSON3Options & { report: true }
  ): MaskReport<T>;
  export function maskJSON3<T extends object>(
    json: T,
    ruleSet: MaskRuleSet | CompiledPlan,
    options?: MaskJSON3Options
  ): T;
  export function migrateLegacyConfig(legacyConfig: JsonMask2Configs): MigrationResult;
  export function parseFieldPattern(raw: string): FieldPatternResult;

  export const KIND_NAMES: ReadonlyArray<MaskKind>;
  export const ERROR_CODES: Readonly<Record<string, string>>;
}
