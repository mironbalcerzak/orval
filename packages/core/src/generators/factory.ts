import { getKey } from '../getters/keys';
import { getRefInfo } from '../getters/ref';
import { resolveRef } from '../resolvers';
import type {
  ContextSpec,
  GeneratorImport,
  OpenApiReferenceObject,
  OpenApiSchemaObject,
} from '../types';
import { isReference } from '../utils/assertion';
import { pascal } from '../utils/case';
import { escape } from '../utils/string';

function getDefaultValue(
  schema: OpenApiSchemaObject | OpenApiReferenceObject,
  context: ContextSpec,
  parents: string[],
): { value: string; imports: GeneratorImport[] } {
  if (isReference(schema)) {
    const { name: refName, originalName } = getRefInfo(schema.$ref, context);
    if (parents.includes(refName)) {
      return {
        value: `{} as ${refName}`,
        imports: [{ name: refName, schemaName: originalName }],
      };
    }

    const resolved = resolveRef(schema, context);
    const isEnum = !!resolved.schema.enum;
    const isObject =
      resolved.schema.type === 'object' ||
      resolved.schema.properties ||
      resolved.schema.allOf ||
      resolved.schema.anyOf ||
      resolved.schema.oneOf;

    if (isObject && !isEnum) {
      const prefix = context.output.override.factoryMethods?.prefix!;
      const factoryName = `${prefix}${pascal(refName)}`;
      return {
        value: `${factoryName}()`,
        imports: [
          { name: refName, schemaName: originalName },
          {
            name: factoryName,
            schemaName: originalName,
            isFactory: true,
            values: true,
          },
        ],
      };
    }

    return getDefaultValue(resolved.schema, context, [...parents, refName]);
  }

  const type = schema.type;
  const nullable =
    schema.nullable || (Array.isArray(type) && type.includes('null'));

  if (nullable) {
    return { value: 'null', imports: [] };
  }

  if (schema.enum && schema.enum.length > 0) {
    const first = schema.enum[0];
    if (typeof first === 'string') {
      if (context.output.override.enumGenerationType === 'enum') {
        return { value: `'${escape(first)}' as any`, imports: [] };
      }
      return { value: `'${escape(first)}'`, imports: [] };
    }
    return { value: String(first), imports: [] };
  }

  if (schema.oneOf || schema.anyOf) {
    const list = schema.oneOf || schema.anyOf;
    if (list && list.length > 0) {
      return getDefaultValue(list[0], context, parents);
    }
  }

  if (schema.allOf) {
    let objValue = '{';
    const imports: GeneratorImport[] = [];
    let hasProps = false;
    for (const sub of schema.allOf) {
      const subDef = getDefaultValue(sub, context, parents);
      if (subDef.value.startsWith('{') && subDef.value.endsWith('}')) {
        const inner = subDef.value.slice(1, -1).trim();
        if (inner) {
          objValue += (hasProps ? ', ' : ' ') + inner;
          hasProps = true;
        }
      } else if (subDef.value.endsWith('()')) {
        objValue += (hasProps ? ', ' : ' ') + `...${subDef.value}`;
        hasProps = true;
      } else {
        objValue += (hasProps ? ', ' : ' ') + `...(${subDef.value})`;
        hasProps = true;
      }
      imports.push(...subDef.imports);
    }
    objValue += hasProps ? ' }' : '}';
    return { value: objValue, imports };
  }

  if (type === 'array' || schema.items) {
    return { value: '[]', imports: [] };
  }

  if (type === 'number' || type === 'integer') {
    return { value: '0', imports: [] };
  }

  if (type === 'boolean') {
    return { value: 'false', imports: [] };
  }

  if (type === 'string') {
    if (schema.format === 'binary') {
      return { value: 'new Blob([])', imports: [] };
    }
    if (
      context.output.override.useDates &&
      (schema.format === 'date' || schema.format === 'date-time')
    ) {
      return { value: 'new Date(0)', imports: [] };
    }
    return { value: "''", imports: [] };
  }

  if (type === 'object' || schema.properties) {
    let objValue = '{';
    const imports: GeneratorImport[] = [];
    let hasProps = false;
    const props = schema.properties || {};
    const requiredProps = schema.required || [];
    const strategy =
      context.output.override.factoryMethods?.optionalPropertyStrategy!;

    for (const [propName, propSchema] of Object.entries(props)) {
      // readOnly properties are included because they might be required by the DTO interface
      const isRequired = requiredProps.includes(propName);
      if (!isRequired && strategy === 'omit') continue;

      const propDef = getDefaultValue(
        propSchema as OpenApiSchemaObject,
        context,
        parents,
      );
      objValue += `${hasProps ? ',' : ''}\n  ${getKey(propName)}: ${propDef.value}`;
      imports.push(...propDef.imports);
      hasProps = true;
    }

    objValue += hasProps ? '\n}' : '}';
    return { value: objValue, imports };
  }

  return { value: '{} as unknown', imports: [] };
}

export function generateFactory(
  schema: OpenApiSchemaObject,
  name: string,
  context: ContextSpec,
): { model: string; imports: GeneratorImport[] } | undefined {
  const isObject =
    schema.type === 'object' ||
    schema.properties ||
    schema.allOf ||
    schema.anyOf ||
    schema.oneOf;
  const isEnum = !!schema.enum;

  if (!isObject || isEnum) {
    return undefined;
  }

  const prefix = context.output.override.factoryMethods?.prefix!;
  const factoryName = `${prefix}${pascal(name)}`;

  const def = getDefaultValue(schema, context, [name]);

  const model = `export function ${factoryName}(): ${name} {\n  return ${def.value};\n}\n`;

  return {
    model,
    imports: [...def.imports, { name }],
  };
}
