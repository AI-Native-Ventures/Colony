import {
  format,
  type OutputUnit,
  type Schema,
  Validator,
} from "@cfworker/json-schema";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";

import {
  BLOCK_MAX_DEPTH,
  BLOCK_MAX_NODES,
  BLOCK_MAX_QUESTION_OPTIONS,
  BLOCK_PRIMITIVE_HANDLES,
  BLOCK_SCHEMA_DRAFT_2020_12,
  type BlockActionDeclaration,
  type BlockFailureCode,
  type BlockInteraction,
  type BlockManifest,
  type BlockNode,
  type BlockParseResult,
} from "./contracts";
import {
  validateQuestionNodeDefinition,
  validateQuestionOptionsData,
} from "./questionOptions";

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDLE_RE = /^[a-z][a-z0-9-]{0,63}$/;

const jsonSchema = z.unknown();
const gapSchema = z.enum(["small", "medium", "large"]);
const presentationInteractionSchema = z
  .object({
    type: z.literal("presentation"),
    surface: z.literal("agent-review"),
  })
  .strict();
const signedInteractionSchema = z
  .object({
    type: z.literal("signed"),
    action_id: z.string(),
    resolves_attention: z.boolean().default(false),
  })
  .strict();
const interactionSchema = z.discriminatedUnion("type", [
  presentationInteractionSchema,
  signedInteractionSchema,
]);

const actionDeclarationSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    input_schema: jsonSchema.optional(),
    interaction: interactionSchema,
    permissions: z.array(z.string()).default([]),
  })
  .strict();

const blockNodeSchema: z.ZodType<BlockNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("stack"),
        gap: gapSchema,
        children: z.array(blockNodeSchema),
      })
      .strict(),
    z
      .object({
        type: z.literal("grid"),
        columns: z.number().int().nonnegative(),
        gap: gapSchema,
        children: z.array(blockNodeSchema),
      })
      .strict(),
    z
      .object({
        type: z.literal("section"),
        title: z.string().optional(),
        text: z.string().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("metric"),
        label: z.string(),
        value: z.string(),
        unit: z.string().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("details"),
        items: z.array(
          z.object({ label: z.string(), value: z.string() }).strict(),
        ),
      })
      .strict(),
    z
      .object({
        type: z.literal("table"),
        columns: z.array(
          z.object({ key: z.string(), label: z.string() }).strict(),
        ),
        rows_path: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("card"),
        title: z.string().optional(),
        description: z.string().optional(),
        children: z.array(blockNodeSchema).default([]),
      })
      .strict(),
    z
      .object({
        type: z.literal("card-list"),
        items_path: z.string(),
        card: blockNodeSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("chart"),
        kind: z.enum(["bar", "line", "area", "donut"]),
        data_path: z.string(),
        label_key: z.string(),
        value_key: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("media"),
        url: z.string().optional(),
        url_path: z.string().optional(),
        alt: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("status"),
        label: z.string(),
        state_path: z.string().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("actions"),
        controls: z.array(
          z
            .object({
              label: z.string(),
              interaction: interactionSchema,
            })
            .strict(),
        ),
      })
      .strict(),
    z
      .object({
        type: z.literal("question"),
        prompt: z.string(),
        mode: z.enum(["single-select", "multi-select"]),
        options: z
          .array(
            z
              .object({
                id: z.string().regex(HANDLE_RE),
                label: z.string().min(1).max(120),
                description: z.string().min(1).max(500).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(BLOCK_MAX_QUESTION_OPTIONS)
          .optional(),
        options_path: z.string().min(1).max(256).optional(),
        min_selections: z.number().int().min(0).max(255),
        max_selections: z.number().int().min(0).max(255),
        allow_custom: z.boolean(),
        require_custom_input: z.boolean(),
        submit_action: z.string(),
      })
      .strict(),
  ]),
);

const manifestSchema = z
  .object({
    schema: z.string(),
    handle: z.string(),
    version: z.string().regex(SEMVER_RE),
    name: z.string(),
    description: z.string(),
    origin: z.enum(["core", "installed", "workspace-custom"]),
    created_at: z.number().int().nonnegative().safe(),
    input_schema: jsonSchema,
    tree: blockNodeSchema,
    actions: z.array(actionDeclarationSchema),
    permissions: z.array(
      z
        .object({
          capability: z.string(),
          constraints: z.unknown().default(null),
        })
        .strict(),
    ),
    fallback_template: z.string(),
    supported_clients: z.array(z.string()),
    primitive_versions: z.record(z.string(), z.number().int().nonnegative()),
    examples: z.array(
      z.object({ name: z.string(), data: z.unknown() }).strict(),
    ),
    validation: z
      .object({
        state: z.enum(["draft", "tested"]).default("draft"),
        requires_attention: z.boolean().default(false),
      })
      .strict()
      .default({ state: "draft", requires_attention: false }),
  })
  .strict();

// Manifests arrive from the relay at runtime, so their schemas can only be
// interpreted, never precompiled. The packaged desktop CSP has no
// `'unsafe-eval'` (desktop/src-tauri/tauri.conf.json, pinned by
// src-tauri/tests/csp.rs), which rules out any validator that generates code
// and hands it to `new Function`. @cfworker/json-schema walks the schema
// instead, so Blocks render under the shipped CSP.
//
// Its format table is shared module state; these two entries replace the
// library defaults with the stricter ones this module has always enforced:
// RFC 4122 versions 1-8 for uuid, and WHATWG URL parsing for uri.
format.uuid = (value: string): boolean => UUID_RE.test(value);
format.uri = (value: string): boolean => {
  try {
    return Boolean(new URL(value));
  } catch {
    return false;
  }
};

type SchemaValidationResult = {
  valid: boolean;
  errors: OutputUnit[];
};

type SchemaValidator = (value: unknown) => SchemaValidationResult;

const schemaValidators = new WeakMap<object, SchemaValidator>();

function failure<T>(
  code: BlockFailureCode,
  message: string,
): BlockParseResult<T> {
  return { ok: false, code, message };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "manifest";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function formatSchemaErrors(errors: readonly OutputUnit[]): string {
  return errors
    .slice(0, 4)
    .map((error) => `${error.instanceLocation || "#"} ${error.error}`)
    .join("; ");
}

function containsRemoteRef(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsRemoteRef);
  }
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, child]) =>
        (key === "$ref" &&
          typeof child === "string" &&
          !child.startsWith("#")) ||
        containsRemoteRef(child),
    );
  }
  return false;
}

function containsSecretLookingKey(value: unknown): boolean {
  const forbidden = [
    "privatekey",
    "secretkey",
    "envvars",
    "environmentvariables",
    "providercredentials",
    "backendconfiguration",
    "backendconfig",
    "apikey",
    "accesstoken",
    "password",
    "credential",
  ];
  if (Array.isArray(value)) {
    return value.some(containsSecretLookingKey);
  }
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, child]) => {
      const normalized = key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
      return (
        forbidden.some((candidate) => normalized.includes(candidate)) ||
        containsSecretLookingKey(child)
      );
    });
  }
  return false;
}

function compileDynamicSchema(
  schema: unknown,
  context: string,
): BlockParseResult<SchemaValidator> {
  if (
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    !Object.hasOwn(schema, "$schema")
  ) {
    return failure(
      "invalid-manifest",
      `${context} must be a JSON Schema object`,
    );
  }
  if (
    (schema as { $schema?: unknown }).$schema !== BLOCK_SCHEMA_DRAFT_2020_12
  ) {
    return failure(
      "invalid-manifest",
      `${context} must use JSON Schema Draft 2020-12`,
    );
  }
  if (containsRemoteRef(schema)) {
    return failure(
      "invalid-manifest",
      `${context} contains a forbidden remote JSON Schema reference`,
    );
  }
  const cached = schemaValidators.get(schema);
  if (cached) {
    return { ok: true, value: cached };
  }
  try {
    // An interpreting validator defers work Ajv did at compile time, so a
    // schema that cannot be evaluated (an unresolved local $ref, an instance
    // type it refuses) throws on first use rather than here. Convert that into
    // an ordinary rejection so callers keep their existing failure shape.
    const compiled = new Validator(schema as Schema, "2020-12", false);
    const validator: SchemaValidator = (value) => {
      try {
        return compiled.validate(value);
      } catch (error) {
        return {
          valid: false,
          errors: [
            {
              keyword: "$schema",
              keywordLocation: "#",
              instanceLocation: "#",
              error: `schema could not be evaluated: ${String(error)}`,
            },
          ],
        };
      }
    };
    schemaValidators.set(schema, validator);
    return { ok: true, value: validator };
  } catch (error) {
    return failure(
      "invalid-manifest",
      `${context} is not a valid JSON Schema: ${String(error)}`,
    );
  }
}

function validateInteraction(
  interaction: BlockInteraction,
  manifest: BlockManifest,
  knownActionIds: ReadonlySet<string>,
  context: string,
): BlockParseResult<true> {
  if (interaction.type === "presentation") {
    return manifest.origin === "core"
      ? { ok: true, value: true }
      : failure(
          "invalid-manifest",
          `${context} uses a Core-only presentation surface`,
        );
  }
  if (!knownActionIds.has(interaction.action_id)) {
    return failure(
      "invalid-manifest",
      `${context} references unknown action ${interaction.action_id}`,
    );
  }
  return { ok: true, value: true };
}

function validateTree(
  manifest: BlockManifest,
  actionIds: ReadonlySet<string>,
): BlockParseResult<true> {
  let nodeCount = 0;

  function visit(node: BlockNode, depth: number): BlockParseResult<true> {
    if (depth > BLOCK_MAX_DEPTH) {
      return failure(
        "invalid-manifest",
        `composition exceeds ${BLOCK_MAX_DEPTH} nesting levels`,
      );
    }
    nodeCount += 1;
    if (nodeCount > BLOCK_MAX_NODES) {
      return failure(
        "invalid-manifest",
        `composition exceeds ${BLOCK_MAX_NODES} nodes`,
      );
    }

    if (node.type === "grid" && (node.columns < 1 || node.columns > 12)) {
      return failure(
        "invalid-manifest",
        "grid columns must be between 1 and 12",
      );
    }
    if (node.type === "media") {
      if ((node.url === undefined) === (node.url_path === undefined)) {
        return failure(
          "invalid-manifest",
          "media requires exactly one of url or url_path",
        );
      }
      if (node.url !== undefined) {
        try {
          const parsed = new URL(node.url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return failure("invalid-manifest", "media URL must use HTTP(S)");
          }
        } catch {
          return failure("invalid-manifest", "media URL must be valid HTTP(S)");
        }
      }
    }
    if (node.type === "actions") {
      for (const [index, control] of node.controls.entries()) {
        const result = validateInteraction(
          control.interaction,
          manifest,
          actionIds,
          `action control ${index}`,
        );
        if (!result.ok) return result;
      }
    }
    if (node.type === "question") {
      const definitionError = validateQuestionNodeDefinition(node);
      if (definitionError) {
        return failure("invalid-manifest", definitionError);
      }
      if (!actionIds.has(node.submit_action)) {
        return failure(
          "invalid-manifest",
          "Question references an undeclared submit action",
        );
      }
    }

    const children =
      node.type === "stack" || node.type === "grid" || node.type === "card"
        ? node.children
        : node.type === "card-list"
          ? [node.card]
          : [];
    for (const child of children) {
      const result = visit(child, depth + 1);
      if (!result.ok) return result;
    }
    return { ok: true, value: true };
  }

  return visit(manifest.tree, 1);
}

function validateApprovalSchema(
  manifest: BlockManifest,
): BlockParseResult<true> {
  if (manifest.handle !== "approval") {
    return { ok: true, value: true };
  }
  const schema = manifest.input_schema as {
    required?: unknown;
    properties?: unknown;
    additionalProperties?: unknown;
  };
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties =
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? schema.properties
      : {};
  for (const field of ["action", "destination", "content", "expires_at"]) {
    if (!required.includes(field) || !Object.hasOwn(properties, field)) {
      return failure(
        "invalid-manifest",
        `Approval schema must require exact ${field}`,
      );
    }
  }
  if (schema.additionalProperties !== false) {
    return failure(
      "invalid-manifest",
      "Approval schema must reject unspecified fields",
    );
  }
  return { ok: true, value: true };
}

function validateActionSchemas(
  manifest: BlockManifest,
): BlockParseResult<true> {
  const actionIds = new Set<string>();
  for (const action of manifest.actions) {
    if (action.id.trim() === "" || actionIds.has(action.id)) {
      return failure(
        "invalid-manifest",
        "action IDs must be non-empty and unique",
      );
    }
    actionIds.add(action.id);
  }

  for (const action of manifest.actions) {
    const interaction = validateInteraction(
      action.interaction,
      manifest,
      actionIds,
      `action ${action.id}`,
    );
    if (!interaction.ok) return interaction;
    if (
      action.interaction.type === "signed" &&
      action.interaction.action_id !== action.id
    ) {
      return failure(
        "invalid-manifest",
        "signed interaction must reference its declaration ID",
      );
    }
    if (
      action.interaction.type === "signed" &&
      action.interaction.resolves_attention &&
      action.input_schema === undefined
    ) {
      return failure(
        "invalid-manifest",
        "resolving actions require an input schema",
      );
    }
    if (
      action.interaction.type === "signed" &&
      action.input_schema !== undefined
    ) {
      const compiled = compileDynamicSchema(
        action.input_schema,
        `action ${action.id} input_schema`,
      );
      if (!compiled.ok) return compiled;
    }
  }

  if (
    manifest.validation.requires_attention &&
    !manifest.actions.some(
      (action) =>
        action.interaction.type === "signed" &&
        action.interaction.resolves_attention,
    )
  ) {
    return failure(
      "invalid-manifest",
      "attention requires at least one resolving signed action",
    );
  }
  return validateTree(manifest, actionIds);
}

export function normalizeBlockHandle(raw: string): BlockParseResult<string> {
  const trimmed = raw.trim();
  const normalized = (
    trimmed.startsWith("@") ? trimmed.slice(1) : trimmed
  ).toLowerCase();
  return HANDLE_RE.test(normalized)
    ? { ok: true, value: normalized }
    : failure("invalid-manifest", `invalid block handle: ${raw}`);
}

export function validateBlockManifest(
  value: unknown,
): BlockParseResult<BlockManifest> {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      !Object.hasOwn(value, "input_schema")
    ) {
      return failure("invalid-manifest", "manifest.input_schema is required");
    }
    const rawExamples = (value as { examples?: unknown }).examples;
    if (
      Array.isArray(rawExamples) &&
      rawExamples.some(
        (example) =>
          !example ||
          typeof example !== "object" ||
          !Object.hasOwn(example, "data"),
      )
    ) {
      return failure("invalid-manifest", "every manifest example needs data");
    }
    const parsed = manifestSchema.safeParse(value);
    if (!parsed.success) {
      return failure("invalid-manifest", formatZodError(parsed.error));
    }
    const manifest = parsed.data as BlockManifest;
    const handle = normalizeBlockHandle(manifest.handle);
    if (!handle.ok || handle.value !== manifest.handle) {
      return failure(
        "invalid-manifest",
        "manifest handle must already be normalized",
      );
    }
    if (
      manifest.schema.trim() === "" ||
      manifest.name.trim() === "" ||
      manifest.description.trim() === "" ||
      manifest.fallback_template.trim() === "" ||
      manifest.created_at === 0
    ) {
      return failure(
        "invalid-manifest",
        "required manifest metadata must not be empty",
      );
    }

    const inputSchema = compileDynamicSchema(
      manifest.input_schema,
      "manifest.input_schema",
    );
    if (!inputSchema.ok) return inputSchema;

    const actionValidation = validateActionSchemas(manifest);
    if (!actionValidation.ok) return actionValidation;

    for (const [primitive, major] of Object.entries(
      manifest.primitive_versions,
    )) {
      const normalized = normalizeBlockHandle(primitive);
      if (
        !normalized.ok ||
        !BLOCK_PRIMITIVE_HANDLES.includes(
          normalized.value as (typeof BLOCK_PRIMITIVE_HANDLES)[number],
        ) ||
        major !== 1
      ) {
        return failure(
          "invalid-manifest",
          `unsupported primitive version: ${primitive}@${major}`,
        );
      }
    }

    for (const permission of manifest.permissions) {
      if (
        permission.capability.trim() === "" ||
        containsSecretLookingKey(permission.constraints)
      ) {
        return failure(
          "invalid-manifest",
          "permission payloads must be named and non-secret",
        );
      }
    }

    const approval = validateApprovalSchema(manifest);
    if (!approval.ok) return approval;

    if (
      manifest.handle === "agent-proposal" &&
      (containsSecretLookingKey(manifest.input_schema) ||
        manifest.actions.some((action) =>
          containsSecretLookingKey(action.input_schema),
        ))
    ) {
      return failure(
        "invalid-manifest",
        "Agent Proposal schemas must not permit secret-bearing fields",
      );
    }

    for (const example of manifest.examples) {
      if (example.name.trim() === "") {
        return failure("invalid-manifest", "example names must not be empty");
      }
      const validated = inputSchema.value(example.data);
      if (!validated.valid) {
        return failure(
          "invalid-manifest",
          `example ${example.name} is invalid: ${formatSchemaErrors(validated.errors)}`,
        );
      }
      const questionOptionsError = validateQuestionOptionsData(
        manifest.tree,
        example.data,
      );
      if (questionOptionsError) {
        return failure(
          "invalid-manifest",
          `example ${example.name} is invalid: ${questionOptionsError}`,
        );
      }
    }
    return { ok: true, value: manifest };
  } catch (error) {
    return failure(
      "invalid-manifest",
      `manifest validation failed safely: ${String(error)}`,
    );
  }
}

export function validateBlockData(
  manifest: BlockManifest,
  value: unknown,
): BlockParseResult<unknown> {
  try {
    const compiled = compileDynamicSchema(
      manifest.input_schema,
      "manifest.input_schema",
    );
    if (!compiled.ok) {
      return failure("invalid-data", compiled.message);
    }
    const validated = compiled.value(value);
    if (!validated.valid) {
      return failure(
        "invalid-data",
        `Block data does not match the manifest: ${formatSchemaErrors(validated.errors)}`,
      );
    }
    const questionOptionsError = validateQuestionOptionsData(
      manifest.tree,
      value,
    );
    return questionOptionsError
      ? failure("invalid-data", questionOptionsError)
      : { ok: true, value };
  } catch (error) {
    return failure(
      "invalid-data",
      `Block data validation failed safely: ${String(error)}`,
    );
  }
}

export function validateBlockActionData(
  manifest: BlockManifest,
  actionId: string,
  value: unknown,
): BlockParseResult<unknown> {
  try {
    const action = manifest.actions.find(
      (candidate) => candidate.id === actionId,
    );
    if (
      action?.interaction.type !== "signed" ||
      action.input_schema === undefined
    ) {
      return failure(
        "invalid-data",
        `action ${actionId} has no signed input contract`,
      );
    }
    const compiled = compileDynamicSchema(
      action.input_schema,
      `action ${actionId} input_schema`,
    );
    if (!compiled.ok) {
      return failure("invalid-data", compiled.message);
    }
    const validated = compiled.value(value);
    return validated.valid
      ? { ok: true, value }
      : failure(
          "invalid-data",
          `action data does not match ${actionId}: ${formatSchemaErrors(validated.errors)}`,
        );
  } catch (error) {
    return failure(
      "invalid-data",
      `action validation failed safely: ${String(error)}`,
    );
  }
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalBlockJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Block JSON cannot contain non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalBlockJson).join(",")}]`;
  }
  if (isPlainJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalBlockJson(value[key] as unknown)}`,
      )
      .join(",")}}`;
  }
  throw new Error("Block data must contain only JSON values");
}

export function blockJsonSha256(value: unknown): string {
  return bytesToHex(
    sha256(new TextEncoder().encode(canonicalBlockJson(value))),
  );
}

export type ApprovalProposal = {
  action: string;
  destination: string;
  content: unknown;
  expires_at: number;
};

export function computeApprovalHash(proposal: ApprovalProposal): string {
  return blockJsonSha256(proposal);
}

export function isSignedInteraction(
  action: BlockActionDeclaration,
): action is BlockActionDeclaration & {
  interaction: Extract<BlockInteraction, { type: "signed" }>;
} {
  return action.interaction.type === "signed";
}
