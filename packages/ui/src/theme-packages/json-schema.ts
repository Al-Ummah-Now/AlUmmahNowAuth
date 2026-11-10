// A small JSON Schema (2020-12) checker for the keywords the theme package schema uses:
// type, const, enum, properties, required, additionalProperties, patternProperties, propertyNames,
// items, minItems, maxItems, pattern, minLength, maxLength, minimum, maximum, anyOf, $ref (#/$defs/...).
// No dependencies, so it runs the same in Node, Workers and the browser.

type Schema = Record<string, any>;
export interface SchemaError { path: string; message: string }

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const fits = (v: unknown, t: string) => typeOf(v) === t || (t === 'number' && typeOf(v) === 'integer');
const join = (path: string, key: string | number) => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key);

export function checkSchema(value: unknown, schema: Schema, root: Schema = schema, path = ''): SchemaError[] {
  if (schema.$ref) {
    const target = String(schema.$ref).replace(/^#\/\$defs\//, '').split('/').reduce<any>((n, k) => n?.[k], root.$defs);
    if (!target) return [{ path, message: `schema reference ${schema.$ref} is missing` }];
    return checkSchema(value, target, root, path);
  }
  const errors: SchemaError[] = [];
  const err = (message: string, at = path) => errors.push({ path: at || '(root)', message });
  if (schema.anyOf) {
    const branches = (schema.anyOf as Schema[]).map((s) => checkSchema(value, s, root, path));
    if (!branches.some((b) => b.length === 0)) err(describeAnyOf(schema.anyOf, root));
    return errors;
  }
  if ('const' in schema && value !== schema.const) return [{ path: path || '(root)', message: `must be ${JSON.stringify(schema.const)}` }];
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) return [{ path: path || '(root)', message: `must be one of ${schema.enum.map((e: unknown) => JSON.stringify(e)).join(', ')}` }];
  if (schema.type && !fits(value, schema.type)) return [{ path: path || '(root)', message: `must be ${schema.type === 'object' ? 'an object' : schema.type === 'array' ? 'a list' : `a ${schema.type}`}` }];
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) err(schema.minLength === 1 ? 'must not be empty' : `must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) err(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) err(schema.description ? `is not valid: ${firstSentence(schema.description)}` : `does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) err(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) err(`must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) err(`needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) err(`allows at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...checkSchema(item, schema.items, root, join(path, i))));
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) err(`is missing`, join(path, key));
    for (const [key, v] of Object.entries(obj)) {
      const at = join(path, key);
      if (schema.propertyNames) for (const e of checkSchema(key, schema.propertyNames, root, at)) err(`name ${e.message}`, at);
      if (schema.properties?.[key]) { errors.push(...checkSchema(v, schema.properties[key], root, at)); continue; }
      const pattern = Object.entries<Schema>(schema.patternProperties ?? {}).find(([p]) => new RegExp(p, 'u').test(key));
      if (pattern) { errors.push(...checkSchema(v, pattern[1], root, at)); continue; }
      if (schema.additionalProperties === false) err('is not a known field', at);
      else if (typeof schema.additionalProperties === 'object') errors.push(...checkSchema(v, schema.additionalProperties, root, at));
    }
  }
  return errors;
}

const firstSentence = (s: string) => s.split(/(?<=\.)\s/)[0];

function describeAnyOf(options: Schema[], root: Schema): string {
  const names = options.map((o) => (o.$ref ? String(o.$ref).split('/').pop() : o.const !== undefined ? JSON.stringify(o.const) : o.type ?? 'value'));
  const hints = options.map((o) => (o.$ref ? root.$defs[String(o.$ref).split('/').pop()!]?.description : undefined)).filter(Boolean);
  return `must be ${names.join(' or ')}${hints.length ? ` (${hints.map((h: string) => firstSentence(h)).join(' ')})` : ''}`;
}
