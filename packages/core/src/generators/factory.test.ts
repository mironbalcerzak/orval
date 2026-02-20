import { describe, expect, it } from 'vitest';

import type { ContextSpec, OpenApiSchemaObject } from '../types';
import { generateFactory } from './factory';

const createMockContext = (overrides = {}): ContextSpec =>
  ({
    target: 'spec',
    workspace: '',
    spec: {
      components: {
        schemas: {},
      },
    },
    output: {
      override: {
        enumGenerationType: 'const',
        factoryMethods: {
          generate: true,
          prefix: 'create',
          location: 'inline-with-model',
          optionalPropertyStrategy: 'omit',
        },
        ...overrides,
      },
      namingConvention: 'camelCase',
    },
  }) as unknown as ContextSpec;

describe('generateFactory', () => {
  it('should return undefined for non-object/enum schemas', () => {
    const context = createMockContext();
    const schema: OpenApiSchemaObject = { type: 'string' };
    const result = generateFactory(schema, 'MyString', context);
    expect(result).toBeUndefined();
  });

  it('should generate a factory for a simple object', () => {
    const context = createMockContext();
    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['id', 'name'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        optionalField: { type: 'number' },
      },
    };

    const result = generateFactory(schema, 'SimpleObject', context);

    expect(result?.model).toContain(
      'export function createSimpleObject(): SimpleObject',
    );
    expect(result?.model).toContain(`id: ''`);
    expect(result?.model).toContain(`name: ''`);
    expect(result?.model).not.toContain('optionalField'); // default strategy is 'omit'
  });

  it('should include optional properties if strategy is include', () => {
    const context = createMockContext({
      factoryMethods: {
        generate: true,
        optionalPropertyStrategy: 'include',
      },
    });
    const schema: OpenApiSchemaObject = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        optionalField: { type: 'number' },
      },
    };

    const result = generateFactory(schema, 'SimpleObject', context);

    expect(result?.model).toContain(`id: ''`);
    expect(result?.model).toContain(`optionalField: 0`);
  });

  it('should handle nested references', () => {
    const context = createMockContext();
    context.spec.components = {
      schemas: {
        NestedObject: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
        },
      },
    };

    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['nested'],
      properties: {
        nested: { $ref: '#/components/schemas/NestedObject' },
      },
    };

    const result = generateFactory(schema, 'MainObject', context);

    expect(result?.model).toContain(`nested: createNestedObject()`);
    expect(result?.imports).toEqual(
      expect.arrayContaining([
        { name: 'NestedObject', schemaName: 'NestedObject' },
        {
          name: 'createNestedObject',
          schemaName: 'NestedObject',
          isFactory: true,
          values: true,
        },
        { name: 'MainObject' },
      ]),
    );
  });

  it('should prevent infinite loops on circular references', () => {
    const context = createMockContext();
    context.spec.components = {
      schemas: {
        Node: {
          type: 'object',
          required: ['child'],
          properties: {
            child: { $ref: '#/components/schemas/Node' },
          },
        },
      },
    };

    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['child'],
      properties: {
        child: { $ref: '#/components/schemas/Node' },
      },
    };

    const result = generateFactory(schema, 'Node', context);

    expect(result?.model).toContain(`child: {} as Node`);
  });

  it('should generate defaults for various primitive types', () => {
    const context = createMockContext();
    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['str', 'num', 'bool', 'arr', 'nul', 'enumStr', 'enumNum'],
      properties: {
        str: { type: 'string' },
        num: { type: 'number' },
        bool: { type: 'boolean' },
        arr: { type: 'array', items: { type: 'string' } },
        nul: { type: 'string', nullable: true },
        enumStr: { type: 'string', enum: ['A', 'B'] },
        enumNum: { type: 'number', enum: [1, 2] },
      },
    };

    const result = generateFactory(schema, 'Primitives', context);

    expect(result?.model).toContain(`str: ''`);
    expect(result?.model).toContain(`num: 0`);
    expect(result?.model).toContain(`bool: false`);
    expect(result?.model).toContain(`arr: []`);
    expect(result?.model).toContain(`nul: null`);
    expect(result?.model).toContain(`enumStr: 'A'`);
    expect(result?.model).toContain(`enumNum: 1`);
  });

  it('should handle allOf correctly', () => {
    const context = createMockContext();
    const schema: OpenApiSchemaObject = {
      type: 'object',
      allOf: [
        {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
      ],
    };

    const result = generateFactory(schema, 'AllOfObject', context);

    expect(result?.model).toContain(`id: ''`);
    expect(result?.model).toContain(`name: ''`);
  });

  it('should handle allOf with references correctly', () => {
    const context = createMockContext();
    context.spec.components = {
      schemas: {
        Base: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    };
    const schema: OpenApiSchemaObject = {
      type: 'object',
      allOf: [
        { $ref: '#/components/schemas/Base' },
        {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
      ],
    };

    const result = generateFactory(schema, 'AllOfObject', context);

    expect(result?.model).toContain(`{ ...createBase(), name: '' }`);
  });

  it('should handle readOnly properties by including them if required', () => {
    const context = createMockContext();
    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['id', 'name'],
      properties: {
        id: { type: 'string', readOnly: true },
        name: { type: 'string' },
      },
    };

    const result = generateFactory(schema, 'ReadOnlyObject', context);

    expect(result?.model).toContain(`id: ''`);
    expect(result?.model).toContain(`name: ''`);
  });

  it('should respect custom prefix', () => {
    const context = createMockContext({
      factoryMethods: {
        generate: true,
        prefix: 'build',
      },
    });
    const schema: OpenApiSchemaObject = {
      type: 'object',
      properties: {},
    };

    const result = generateFactory(schema, 'SimpleObject', context);

    expect(result?.model).toContain(
      'export function buildSimpleObject(): SimpleObject',
    );
  });

  it('should handle format binary with Blob', () => {
    const context = createMockContext();
    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    };

    const result = generateFactory(schema, 'FileObject', context);

    expect(result?.model).toContain(`file: new Blob([])`);
  });

  it('should handle format date with Date if useDates is true', () => {
    const context = createMockContext({
      useDates: true,
    });
    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['createdAt'],
      properties: {
        createdAt: { type: 'string', format: 'date' },
      },
    };

    const result = generateFactory(schema, 'DateObject', context);

    expect(result?.model).toContain(`createdAt: new Date(0)`);
  });

  it('should format enums as any if enumGenerationType is enum', () => {
    const context = createMockContext({
      enumGenerationType: 'enum',
      factoryMethods: {
        generate: true,
        optionalPropertyStrategy: 'include',
      },
    });
    const schema: OpenApiSchemaObject = {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['foo', 'bar'] },
      },
    };
    const result = generateFactory(schema, 'EnumObject', context);
    expect(result?.model).toContain(`type: 'foo' as any`);
  });

  it('should select first available option for anyOf/oneOf', () => {
    const context = createMockContext();
    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['unionProp'],
      properties: {
        unionProp: {
          oneOf: [{ type: 'number' }, { type: 'string' }],
        },
      },
    };
    const result = generateFactory(schema, 'UnionObject', context);
    expect(result?.model).toContain(`unionProp: 0`);
  });

  it('should generate empty object for unknown type fallback', () => {
    const context = createMockContext();
    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['unknownProp'],
      properties: {
        unknownProp: { type: 'something_invalid' as any },
      },
    };
    const result = generateFactory(schema, 'FallbackObject', context);
    expect(result?.model).toContain(`unknownProp: {} as unknown`);
  });

  it('should handle nullable type via array correctly', () => {
    const context = createMockContext();
    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['maybeProp'],
      properties: {
        maybeProp: { type: ['string', 'null'] },
      },
    };
    const result = generateFactory(schema, 'NullableArrayTypeObject', context);
    expect(result?.model).toContain(`maybeProp: null`);
  });

  it('should handle nested inline objects', () => {
    const context = createMockContext();
    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['address'],
      properties: {
        address: {
          type: 'object',
          required: ['city'],
          properties: {
            city: { type: 'string' },
          },
        },
      },
    };
    const result = generateFactory(schema, 'NestedInlineObject', context);
    expect(result?.model).toContain(`address: {\n  city: ''\n}`);
  });

  it('should handle missing properties safely', () => {
    const context = createMockContext();
    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['something'],
    };
    const result = generateFactory(schema, 'MissingPropsObject', context);
    expect(result?.model).toContain('return {}');
  });
});
