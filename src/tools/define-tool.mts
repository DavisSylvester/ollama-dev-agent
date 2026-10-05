import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import type { JSONSchema } from '@langchain/core/utils/json_schema';
import type { Static, TObject } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export interface ToolFields<T extends TObject> {
  name: string;
  description: string;
  schema: T;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A property with a `default` is optional for the model: drop it from every
 * `required` list (at any depth) so the model may omit it, the same way a zod
 * `.default()` field behaved. The default is filled in before validation.
 */
function relaxDefaulted(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(relaxDefaulted);
  }
  if (!isJsonObject(node)) {
    return node;
  }

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = relaxDefaulted(value);
  }

  const properties: unknown = out['properties'];
  const required: unknown = out['required'];
  if (isJsonObject(properties) && Array.isArray(required)) {
    const kept: unknown[] = required.filter((name) => {
      const prop: unknown = typeof name === 'string' ? properties[name] : undefined;
      return !(isJsonObject(prop) && 'default' in prop);
    });
    if (kept.length > 0) {
      out['required'] = kept;
    } else {
      delete out['required'];
    }
  }

  return out;
}

/** Plain JSON Schema for the model: TypeBox's symbol keys are dropped. */
export function toModelSchema(schema: TObject): JSONSchema {
  const plain: unknown = relaxDefaulted(JSON.parse(JSON.stringify(schema)));
  return plain as JSONSchema;
}

/**
 * Define a LangChain tool from a TypeBox schema. The model sees plain JSON
 * Schema; the handler receives input that has had defaults applied and been
 * checked against the schema, typed as `Static<T>`. Invalid input returns an
 * error string to the model rather than throwing, like every other tool error.
 */
export function defineTool<T extends TObject>(
  run: (input: Static<T>) => Promise<string>,
  fields: ToolFields<T>,
): StructuredTool {
  return tool(
    async (raw: unknown): Promise<string> => {
      const input: unknown = Value.Default(fields.schema, Value.Clone(raw ?? {}));
      if (!Value.Check(fields.schema, input)) {
        const first = Value.Errors(fields.schema, input).First();
        const where: string = first?.path ? first.path : '(root)';
        return `Error: invalid arguments for ${fields.name}: ${where} ${first?.message ?? 'does not match the schema'}`;
      }
      return run(input);
    },
    {
      name: fields.name,
      description: fields.description,
      schema: toModelSchema(fields.schema),
      // Tell the model which argument was wrong, not just that one was.
      verboseParsingErrors: true,
    },
  );
}
