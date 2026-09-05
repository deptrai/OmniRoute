// Defensive shims for tool calls whose strict-schema fields can be malformed
// by upstream models (e.g. MiMo emitting empty objects/strings instead of
// arrays for Capy's submit_pr_review).
//
// Applied on the assembled OpenAI tool-call arguments after streaming, just
// before they are re-emitted as a single Claude input_json_delta.
//
// To add a new shim: register a (input) => input transformer in TOOL_SHIMS
// keyed by the tool name. The transformer must accept arbitrary input and
// return a JSON-safe value.

type ShimFn = (input: unknown) => unknown;

function coerceToArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  if (typeof v === "string") {
    if (v === "") return [];
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  // Plain object or other non-array → empty
  return [];
}

// Claude Code's Read tool caps `limit` at 2000 lines per call. Non-Anthropic models
// (GPT-5.5, DeepSeek …) occasionally emit absurd values (e.g. `limit: 25999999999999999`)
// that Claude Code rejects, causing a retry loop that wastes tokens. Clamp here.
const READ_MAX_LIMIT = 2000;

// `pages` is only meaningful for PDFs and only as `"N"` or `"N-M"` (1-based).
// Reference: claude-code-tools docs + upstream decolua/9router#1144.
function isValidPdfPagesArg(filePath: unknown, pages: unknown): boolean {
  return (
    typeof filePath === "string" &&
    filePath.toLowerCase().endsWith(".pdf") &&
    typeof pages === "string" &&
    /^\d+(?:-\d+)?$/.test(pages)
  );
}

function sanitizeReadArgs(args: Record<string, unknown>): void {
  // Coerce numeric-string limit/offset (some non-Anthropic models stringify everything).
  if (typeof args.limit === "string" && /^\d+$/.test(args.limit)) {
    args.limit = Number(args.limit);
  }
  if (typeof args.offset === "string" && /^-?\d+$/.test(args.offset)) {
    args.offset = Number(args.offset);
  }

  if (typeof args.limit === "number") {
    // Read into a local: assigning back to `args.limit` (declared `unknown`) resets the
    // `typeof` narrowing, so the second comparison would no longer see a number. The two
    // branches are mutually exclusive (READ_MAX_LIMIT is 2000), so testing the original
    // value keeps the behavior identical.
    const limit = args.limit;
    if (limit > READ_MAX_LIMIT) args.limit = READ_MAX_LIMIT;
    if (limit < 1) delete args.limit;
  }
  if (typeof args.offset === "number" && args.offset < 0) args.offset = 0;

  if ("pages" in args && !isValidPdfPagesArg(args.file_path, args.pages)) {
    delete args.pages;
  }
}

// Claude Code's Skill tool requires `skill` (string) + optional `args`.
// GLM-5.2 and other non-Anthropic models frequently emit `name` instead of `skill`
// (because `name` is a common parameter in other tools), causing InputValidationError
// "The required parameter `skill` is missing" and a wasted retry round-trip.
// Remap `name` → `skill` when `skill` is absent.
function sanitizeSkillArgs(args: Record<string, unknown>): void {
  // Remap name -> skill when skill is missing (GLM-5.2 confuses the two).
  if (!("skill" in args) && typeof args.name === "string") {
    args.skill = args.name;
  }
  // `name` is never a valid Skill parameter — always remove it.
  delete args.name;
}

// Paperclip MCP's TaskUpdate tool requires `taskId` as string, but GLM-5.2 and
// other non-Anthropic models emit it as:
//   - a number (e.g. `taskId: 1`) → coerce to string
//   - `id` instead of `taskId` (e.g. `id: 1`) → remap to taskId
// Either case causes InputValidationError and a retry loop.
function sanitizeTaskUpdateArgs(args: Record<string, unknown>): void {
  // Remap `id` → `taskId` when `taskId` is absent (GLM common mistake)
  if (!("taskId" in args) && "id" in args) {
    args.taskId = args.id;
    delete args.id;
  }
  if (typeof args.taskId === "number") {
    args.taskId = String(args.taskId);
  }
}

// Claude Code's Agent tool requires BOTH `description` (short task summary)
// AND `prompt` (full task instructions). GLM-5.2-max is inconsistent:
//   - Sometimes emits only `description` (omits `prompt`)
//   - Sometimes emits only `prompt` (omits `description`)
//   - Sometimes emits both
// Both missing-field cases cause InputValidationError and a wasted retry.
// Fix: ensure BOTH fields exist by copying whichever is missing from the other.
function sanitizeAgentArgs(args: Record<string, unknown>): void {
  // Remap non-standard fields from models: summary -> description, message -> prompt
  if (!("description" in args) && typeof args.summary === "string") {
    args.description = args.summary;
  }
  if (!("prompt" in args) && typeof args.message === "string") {
    args.prompt = args.message;
  }
  delete args.summary;
  delete args.message;
  delete args.type;

  const hasPrompt = typeof args.prompt === "string" && args.prompt !== "";
  const hasDescription = typeof args.description === "string" && args.description !== "";

  if (!hasPrompt && hasDescription) {
    args.prompt = args.description;
  } else if (!hasDescription && hasPrompt) {
    const promptStr = args.prompt as string;
    args.description = promptStr.length > 80 ? promptStr.slice(0, 77) + "..." : promptStr;
  }
}

function sanitizeAskUserQuestionArgs(args: Record<string, unknown>): void {
  const normalizeOption = (opt: unknown): Record<string, unknown> => {
    if (typeof opt === "string") {
      return { label: opt, description: "" };
    }
    if (typeof opt === "object" && opt !== null && !Array.isArray(opt)) {
      const o = opt as Record<string, unknown>;
      const label =
        typeof o.label === "string"
          ? o.label
          : typeof o.text === "string"
            ? o.text
            : typeof o.value === "string"
              ? o.value
              : typeof o.name === "string"
                ? o.name
                : JSON.stringify(o);
      const description = typeof o.description === "string" ? o.description : "";
      // Emit only schema fields — remapped leftovers like `text`/`value`/`name`
      // would be rejected as extra properties by strict validation.
      return { label, description };
    }
    return { label: String(opt ?? ""), description: "" };
  };

  const normalizeQuestionObj = (q: unknown): Record<string, unknown> => {
    if (Array.isArray(q)) {
      // Some models emit question as a string[] — join rather than relying on
      // String(q) which produces a comma-joined blob.
      q = q.filter((s) => typeof s === "string" && s).join("\n");
    }
    if (typeof q === "string") {
      return {
        header: "Question",
        question: q,
        options: [],
      };
    }
    if (typeof q === "object" && q !== null && !Array.isArray(q)) {
      const rec = { ...(q as Record<string, unknown>) };
      if (!rec.header || typeof rec.header !== "string") {
        rec.header = typeof rec.title === "string" && rec.title ? rec.title : "Question";
      }
      if (!rec.question || typeof rec.question !== "string") {
        rec.question =
          typeof rec.text === "string"
            ? rec.text
            : typeof rec.prompt === "string"
              ? rec.prompt
              : typeof rec.description === "string"
                ? rec.description
                : "";
      }
      if (Array.isArray(rec.options)) {
        rec.options = rec.options.map(normalizeOption);
      } else {
        rec.options = [];
      }
      return rec;
    }
    return { header: "Question", question: String(q ?? ""), options: [] };
  };

  const extractedQuestions: Record<string, unknown>[] = [];

  if (Array.isArray(args.questions)) {
    for (const item of args.questions) {
      extractedQuestions.push(normalizeQuestionObj(item));
    }
  } else if (args.questions && typeof args.questions === "object") {
    extractedQuestions.push(normalizeQuestionObj(args.questions));
  }

  const hasRootQuestion =
    typeof args.question === "string" ||
    (typeof args.question === "object" && args.question !== null) ||
    Array.isArray(args.options);

  if (hasRootQuestion) {
    const rawQuestion = args.question;
    const rawHeader = typeof args.header === "string" ? args.header : "Question";
    const rawOptions = Array.isArray(args.options) ? args.options : [];

    const rootQ =
      typeof rawQuestion === "object" && rawQuestion !== null
        ? normalizeQuestionObj(rawQuestion)
        : normalizeQuestionObj({
            header: rawHeader,
            question: rawQuestion,
            options: rawOptions,
          });

    // Options-only calls (no question text anywhere) would emit question:"" and
    // fail strict validation — a generic prompt is better than a retry loop.
    if (!rootQ.question && Array.isArray(rootQ.options) && rootQ.options.length > 0) {
      rootQ.question = "Select an option";
    }

    extractedQuestions.push(rootQ);
    delete args.question;
    delete args.options;
    delete args.header;
  }

  if (extractedQuestions.length > 0) {
    args.questions = extractedQuestions;
  }
}

const TOOL_SHIMS: Record<string, ShimFn> = {
  // Claude Code Read rejects bad params and retries — wasting tokens with non-Anthropic
  // models that emit oversized limits, negative offsets, stringified numbers, or stray
  // `pages` on non-PDF files. Buffer and emit one cleaned JSON delta so the client never
  // sees the bad fields. See `sanitizeReadArgs` for the per-field rules.
  Read: (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
    const patched = { ...(input as Record<string, unknown>) };
    sanitizeReadArgs(patched);
    return patched;
  },
  // Claude Code Skill tool: GLM-5.2 emits `name` instead of `skill`, causing
  // InputValidationError + retry. Remap so the first call succeeds.
  Skill: (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
    const patched = { ...(input as Record<string, unknown>) };
    sanitizeSkillArgs(patched);
    return patched;
  },
  // Paperclip MCP TaskUpdate: GLM-5.2 emits `taskId` as number instead of string,
  // causing InputValidationError + 9x retry loop. Coerce number → string.
  TaskUpdate: (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
    const patched = { ...(input as Record<string, unknown>) };
    sanitizeTaskUpdateArgs(patched);
    return patched;
  },
  // Claude Code Agent tool: ensures both description and prompt exist, remapping non-standard fields.
  Agent: (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
    const patched = { ...(input as Record<string, unknown>) };
    sanitizeAgentArgs(patched);
    return patched;
  },
  // Claude Code AskUserQuestion tool: normalizes root question/options to questions array with object options.
  AskUserQuestion: (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
    const patched = { ...(input as Record<string, unknown>) };
    sanitizeAskUserQuestionArgs(patched);
    return patched;
  },
  ask_user_question: (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
    const patched = { ...(input as Record<string, unknown>) };
    sanitizeAskUserQuestionArgs(patched);
    return patched;
  },
  submit_pr_review: (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
    const patched = { ...(input as Record<string, unknown>) };
    for (const key of ["functionalChanges", "findings"]) {
      patched[key] = coerceToArray(patched[key]);
    }
    return patched;
  },
};

function resolveToolCallShim(name: string | undefined | null): ShimFn | undefined {
  if (typeof name !== "string" || !name) return undefined;
  if (Object.prototype.hasOwnProperty.call(TOOL_SHIMS, name)) return TOOL_SHIMS[name];
  const lower = name.toLowerCase();
  for (const [key, fn] of Object.entries(TOOL_SHIMS)) {
    if (key.toLowerCase() === lower) return fn;
  }
  return undefined;
}

export function hasToolCallShim(name: string | undefined | null): boolean {
  return Boolean(resolveToolCallShim(name));
}

// ---------------------------------------------------------------------------
// Generic schema-driven argument repair
// ---------------------------------------------------------------------------

const SCHEMA_REPAIR_MAX_DEPTH = 4;

function schemaTypeSet(prop: unknown): Set<string> {
  const p = prop && typeof prop === "object" ? (prop as Record<string, unknown>) : null;
  const t = p?.type;
  if (typeof t === "string") return new Set([t]);
  if (Array.isArray(t)) return new Set(t.filter((x): x is string => typeof x === "string"));
  return new Set();
}

function defaultForTypes(types: Set<string>): unknown {
  if (types.has("array")) return [];
  if (types.has("object")) return {};
  if (types.has("number") || types.has("integer")) return 0;
  if (types.has("boolean")) return false;
  return "";
}

/**
 * Coerce a single scalar/object value toward the schema's declared types.
 * Returns the coerced value, or the original when no safe coercion applies.
 * Only unambiguous conversions are attempted — never guess semantics.
 */
function coerceValueForSchema(value: unknown, propSchema: unknown, depth: number): unknown {
  const types = schemaTypeSet(propSchema);
  if (types.size === 0) return value;

  if (types.has("string") && (typeof value === "number" || typeof value === "boolean")) {
    return String(value);
  }
  if (
    (types.has("number") || types.has("integer")) &&
    typeof value === "string" &&
    value.trim() !== "" &&
    /^-?\d+(\.\d+)?$/.test(value.trim())
  ) {
    const n = Number(value.trim());
    return types.has("integer") && !types.has("number") ? Math.trunc(n) : n;
  }
  if (types.has("boolean")) {
    if (value === "true" || value === 1) return true;
    if (value === "false" || value === 0) return false;
  }
  if (types.has("array") && !Array.isArray(value)) {
    return [value];
  }
  // JSON-stringified object — a common model failure mode.
  if (types.has("object") && typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return sanitizeArgsAgainstSchema(propSchema, parsed, depth + 1);
      }
    } catch {
      /* not JSON — leave as-is */
    }
  }
  if (types.has("object") && value && typeof value === "object" && !Array.isArray(value)) {
    return sanitizeArgsAgainstSchema(propSchema, value, depth + 1);
  }
  if (types.has("array") && Array.isArray(value)) {
    const items =
      propSchema && typeof propSchema === "object"
        ? (propSchema as Record<string, unknown>).items
        : undefined;
    if (items && depth < SCHEMA_REPAIR_MAX_DEPTH) {
      return value.map((item) => coerceValueForSchema(item, items, depth + 1));
    }
  }
  return value;
}

/**
 * Conservative JSON-Schema repair of parsed tool arguments:
 * - drops properties not declared when additionalProperties === false
 * - coerces unambiguous type mismatches (stringified numbers/booleans,
 *   scalar→array, JSON-stringified objects)
 * - fills missing required fields with type-correct empty values
 * - recurses into nested properties/items (depth-capped)
 * Returns the same reference when nothing changed.
 */
function sanitizeArgsAgainstSchema(
  schema: unknown,
  args: unknown,
  depth: number
): Record<string, unknown> | unknown {
  const sch = schema && typeof schema === "object" ? (schema as Record<string, unknown>) : null;
  if (!sch || !args || typeof args !== "object" || Array.isArray(args)) return args;
  if (depth >= SCHEMA_REPAIR_MAX_DEPTH) return args;

  const properties =
    sch.properties && typeof sch.properties === "object"
      ? (sch.properties as Record<string, unknown>)
      : {};
  const required = new Set(
    Array.isArray(sch.required)
      ? sch.required.filter((x): x is string => typeof x === "string")
      : []
  );
  const record = args as Record<string, unknown>;

  // Fill missing required fields with type-correct empties.
  for (const key of required) {
    if (!(key in record)) {
      record[key] = defaultForTypes(schemaTypeSet(properties[key]));
    }
  }

  // Coerce declared properties.
  for (const [key, propSchema] of Object.entries(properties)) {
    if (key in record) {
      record[key] = coerceValueForSchema(record[key], propSchema, depth);
    }
  }

  // Drop undeclared keys when the schema is closed.
  if (sch.additionalProperties === false) {
    for (const key of Object.keys(record)) {
      if (!(key in properties)) delete record[key];
    }
  }

  return record;
}

/**
 * Schema-driven repair entry point for a parsed arguments object.
 */
export function sanitizeToolArgsBySchema(
  schema: Record<string, unknown> | null | undefined,
  args: unknown
): unknown {
  return sanitizeArgsAgainstSchema(schema ?? null, args, 0);
}

/**
 * Apply the registered shim for a tool call's raw assembled arguments string.
 * Returns a stringified JSON value safe to emit as input_json_delta.partial_json.
 * If the buffer is unparseable, returns the empty-object JSON `{}` after applying
 * the shim with `{}` as input (so required arrays still get injected).
 */
export function applyToolCallShimToBuffer(name: string, raw: string): string {
  const shim = resolveToolCallShim(name);
  if (!shim) return raw;

  let parsed: unknown;
  try {
    parsed = raw && raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }

  const patched = shim(parsed);
  return JSON.stringify(patched);
}

/**
 * Full finish-time sanitizer: named shim (if any) followed by schema-driven
 * repair against the tool's declared input_schema/parameters. Callers pass the
 * schema from state.toolSchemas so models that emit wrong field names, wrong
 * types, or extra keys get a corrected argument object instead of a client-side
 * InputValidationError.
 */
export function applyToolCallSanitizers(
  name: string,
  raw: string,
  schema?: Record<string, unknown> | null
): string {
  const shim = resolveToolCallShim(name);

  let parsed: unknown;
  try {
    parsed = raw && raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }

  const patched = shim ? shim(parsed) : parsed;
  const repaired = schema ? sanitizeToolArgsBySchema(schema, patched) : patched;
  return JSON.stringify(repaired);
}

// Exposed for unit tests only.
export const __test = { coerceToArray, TOOL_SHIMS };
