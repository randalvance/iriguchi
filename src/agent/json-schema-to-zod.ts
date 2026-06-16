import { z, type ZodTypeAny } from "zod";

/**
 * Minimal JSON Schema → Zod converter for tool parameter schemas.
 * Handles the subset needed by api_call tool parameters in v1:
 * type=string|integer|number|boolean|array|object, plus `required` and
 * nested `properties`. Unknown types fall back to `z.unknown()`.
 */
export function jsonSchemaToZodRawShape(
  schema: Record<string, unknown>,
): Record<string, ZodTypeAny> {
  if (schema?.type !== "object" || typeof schema.properties !== "object") {
    return {};
  }
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, prop] of Object.entries(properties)) {
    let z2: ZodTypeAny = propertyToZod(prop);
    const description = typeof prop?.description === "string" ? prop.description : undefined;
    if (description) z2 = z2.describe(description);
    if (!required.has(name)) z2 = z2.optional();
    shape[name] = z2;
  }
  return shape;
}

function propertyToZod(prop: Record<string, unknown>): ZodTypeAny {
  switch (prop?.type) {
    case "string":
      return z.string();
    case "integer":
      return z.number().int();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    case "object":
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}
