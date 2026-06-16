import { describe, it, expect } from "bun:test";
import { jsonSchemaToZodRawShape } from "../../src/agent/json-schema-to-zod.ts";
import { z } from "zod";

describe("jsonSchemaToZodRawShape", () => {
  it("converts simple flat schema with required + optional fields", () => {
    const shape = jsonSchemaToZodRawShape({
      type: "object",
      properties: {
        location: { type: "string" },
        days: { type: "integer", minimum: 1, maximum: 7 },
        units: { type: "string" },
      },
      required: ["location"],
    });
    const schema = z.object(shape);
    expect(schema.parse({ location: "NYC" })).toEqual({ location: "NYC" });
    expect(schema.parse({ location: "NYC", days: 3 })).toEqual({ location: "NYC", days: 3 });
    expect(() => schema.parse({})).toThrow(); // missing required
    expect(() => schema.parse({ location: "NYC", days: "three" })).toThrow();
  });

  it("returns empty shape for non-object root schemas", () => {
    expect(jsonSchemaToZodRawShape({ type: "string" })).toEqual({});
    expect(jsonSchemaToZodRawShape({})).toEqual({});
  });

  it("preserves field descriptions when present", () => {
    const shape = jsonSchemaToZodRawShape({
      type: "object",
      properties: { q: { type: "string", description: "search query" } },
      required: ["q"],
    });
    expect(shape.q.description).toBe("search query");
  });

  it("falls back to z.unknown() for unsupported types", () => {
    const shape = jsonSchemaToZodRawShape({
      type: "object",
      properties: { weird: { type: "geo-point" } },
      required: ["weird"],
    });
    const schema = z.object(shape);
    expect(schema.parse({ weird: { anything: 1 } })).toEqual({ weird: { anything: 1 } });
  });

  it("handles all primitive types", () => {
    const shape = jsonSchemaToZodRawShape({
      type: "object",
      properties: {
        s: { type: "string" },
        i: { type: "integer" },
        n: { type: "number" },
        b: { type: "boolean" },
        a: { type: "array" },
        o: { type: "object" },
      },
      required: ["s", "i", "n", "b", "a", "o"],
    });
    const schema = z.object(shape);
    expect(() =>
      schema.parse({ s: "x", i: 1, n: 1.5, b: true, a: [], o: {} }),
    ).not.toThrow();
    expect(() => schema.parse({ s: 1, i: 1, n: 1.5, b: true, a: [], o: {} })).toThrow();
    expect(() => schema.parse({ s: "x", i: 1.5, n: 1.5, b: true, a: [], o: {} })).toThrow();
  });
});
