import nodePath from 'node:path';

import fs from 'fs-extra';
import { groupBy } from 'remeda';

import { generateImports } from '../generators';
import {
  type FactoryMethodsLocation,
  type GeneratorImport,
  type GeneratorSchema,
  NamingConvention,
  type NormalizedFactoryMethodsOptions,
} from '../types';
import { conventionName, upath } from '../utils';

type CanonicalInfo = Pick<GeneratorImport, 'importPath' | 'name'>;

/**
 * Patterns to detect operation-derived types (params, bodies, responses).
 * These types are auto-generated from OpenAPI operations, not from component schemas.
 */
const OPERATION_TYPE_PATTERNS = [
  /Params$/i, // GetUserParams, ListUsersParams
  /Body$/, // CreateUserBody, UpdatePostBody (case-sensitive to avoid "Antibody")
  /Body(One|Two|Three|Four|Five|Item)$/, // BodyOne, BodyTwo (union body types)
  /Parameter$/i, // PageParameter, LimitParameter
  /Query$/i, // GetUserQuery
  /Header$/i, // AuthHeader
  /Response\d*$/i, // GetUser200Response, NotFoundResponse
  /^[1-5]\d{2}$/, // 200, 201, 404 (valid HTTP status codes: 1xx-5xx)
  /\d{3}(One|Two|Three|Four|Five|Item)$/i, // 200One, 200Two (union response types)
  /^(get|post|put|patch|delete|head|options)[A-Z].*\d{3}$/, // operation types with status codes (get...200, post...404)
];

/**
 * Check if a schema name matches operation type patterns.
 */
function isOperationType(schemaName: string): boolean {
  return OPERATION_TYPE_PATTERNS.some((pattern) => pattern.test(schemaName));
}

/**
 * Split schemas into regular and operation types.
 */
export function splitSchemasByType(schemas: GeneratorSchema[]): {
  regularSchemas: GeneratorSchema[];
  operationSchemas: GeneratorSchema[];
} {
  const regularSchemas: GeneratorSchema[] = [];
  const operationSchemas: GeneratorSchema[] = [];

  for (const schema of schemas) {
    if (isOperationType(schema.name)) {
      operationSchemas.push(schema);
    } else {
      regularSchemas.push(schema);
    }
  }

  return { regularSchemas, operationSchemas };
}

/**
 * Get the import extension from a file extension.
 * Removes `.ts` suffix since TypeScript doesn't need it in imports.
 */
function getImportExtension(fileExtension: string): string {
  return fileExtension.replace(/\.ts$/, '') || '';
}

/**
 * Fix cross-directory imports when schemas reference other schemas in a different directory.
 * Updates import paths to use correct relative paths between directories.
 */
function fixSchemaImports(
  schemas: GeneratorSchema[],
  targetSchemaNames: Set<string>,
  fromPath: string,
  toPath: string,
  namingConvention: NamingConvention,
  fileExtension: string,
): void {
  const relativePath = upath.relativeSafe(fromPath, toPath);
  const importExtension = getImportExtension(fileExtension);

  for (const schema of schemas) {
    schema.imports = schema.imports.map((imp) => {
      if (targetSchemaNames.has(imp.name)) {
        const fileName = conventionName(imp.name, namingConvention);
        return {
          ...imp,
          importPath: upath.joinSafe(relativePath, fileName) + importExtension,
        };
      }
      return imp;
    });

    if (schema.factory) {
      schema.factory.imports = schema.factory.imports.map((imp) => {
        const baseName = imp.schemaName || imp.name;
        if (targetSchemaNames.has(baseName)) {
          const fileName = conventionName(baseName, namingConvention);
          return {
            ...imp,
            importPath:
              upath.joinSafe(relativePath, fileName) + importExtension,
          };
        }
        return imp;
      });
    }
  }
}

/**
 * Fix imports in operation schemas that reference regular schemas.
 */
export function fixCrossDirectoryImports(
  operationSchemas: GeneratorSchema[],
  regularSchemaNames: Set<string>,
  schemaPath: string,
  operationSchemaPath: string,
  namingConvention: NamingConvention,
  fileExtension: string,
): void {
  fixSchemaImports(
    operationSchemas,
    regularSchemaNames,
    operationSchemaPath,
    schemaPath,
    namingConvention,
    fileExtension,
  );
}

/**
 * Fix imports in regular schemas that reference operation schemas.
 */
export function fixRegularSchemaImports(
  regularSchemas: GeneratorSchema[],
  operationSchemaNames: Set<string>,
  schemaPath: string,
  operationSchemaPath: string,
  namingConvention: NamingConvention,
  fileExtension: string,
): void {
  fixSchemaImports(
    regularSchemas,
    operationSchemaNames,
    schemaPath,
    operationSchemaPath,
    namingConvention,
    fileExtension,
  );
}

function getSchemaKey(
  schemaPath: string,
  schemaName: string,
  namingConvention: NamingConvention,
  fileExtension: string,
) {
  return getPath(
    schemaPath,
    conventionName(schemaName, namingConvention),
    fileExtension,
  )
    .toLowerCase()
    .replaceAll('\\', '/');
}

function getSchemaGroups(
  schemaPath: string,
  schemas: GeneratorSchema[],
  namingConvention: NamingConvention,
  fileExtension: string,
) {
  return groupBy(schemas, (schema) =>
    getSchemaKey(schemaPath, schema.name, namingConvention, fileExtension),
  );
}

function getCanonicalMap(
  schemaGroups: Record<string, GeneratorSchema[]>,
  schemaPath: string,
  namingConvention: NamingConvention,
  fileExtension: string,
) {
  const canonicalPathMap = new Map<string, CanonicalInfo>();
  for (const [key, groupSchemas] of Object.entries(schemaGroups)) {
    const canonicalPath = getPath(
      schemaPath,
      conventionName(groupSchemas[0].name, namingConvention),
      fileExtension,
    );

    canonicalPathMap.set(key, {
      importPath: canonicalPath,
      name: groupSchemas[0].name,
    });
  }
  return canonicalPathMap;
}

function normalizeCanonicalImportPaths(
  schemas: GeneratorSchema[],
  canonicalPathMap: Map<string, CanonicalInfo>,
  schemaPath: string,
  namingConvention: NamingConvention,
  fileExtension: string,
) {
  for (const schema of schemas) {
    schema.imports = schema.imports.map((imp) => {
      const resolvedImportKey = resolveImportKey(
        schemaPath,
        imp.importPath ?? `./${conventionName(imp.name, namingConvention)}`,
        fileExtension,
      );
      const canonical = canonicalPathMap.get(resolvedImportKey);
      if (!canonical?.importPath) return imp;

      const importPath = removeFileExtension(
        upath.relativeSafe(
          schemaPath,
          canonical.importPath.replaceAll('\\', '/'),
        ),
        fileExtension,
      );

      return { ...imp, importPath };
    });

    if (schema.factory) {
      schema.factory.imports = schema.factory.imports.map((imp) => {
        const baseName = imp.schemaName || imp.name;
        const resolvedImportKey = resolveImportKey(
          schemaPath,
          imp.importPath ?? `./${conventionName(baseName, namingConvention)}`,
          fileExtension,
        );
        const canonical = canonicalPathMap.get(resolvedImportKey);
        if (!canonical?.importPath) return imp;

        const importPath = removeFileExtension(
          upath.relativeSafe(
            schemaPath,
            canonical.importPath.replaceAll('\\', '/'),
          ),
          fileExtension,
        );

        return { ...imp, importPath };
      });
    }
  }
}

function resolveFactoryImports(
  imports: GeneratorImport[],
  location: FactoryMethodsLocation,
  namingConvention: NamingConvention,
): GeneratorImport[] {
  return imports.map((imp) => {
    if (imp.isFactory) {
      const baseName = conventionName(
        imp.schemaName || imp.name,
        namingConvention,
      );
      let importPath = imp.importPath ?? `./${baseName}`;
      if (location === 'separate-file') {
        importPath = `${importPath}.factory`;
      } else if (location === 'combined-separate-file') {
        importPath = `./factoryMethods`;
      }
      return { ...imp, importPath };
    }
    return imp;
  });
}

function mergeSchemaGroup(schemas: GeneratorSchema[]): GeneratorSchema {
  const baseSchemaName = schemas[0].name;
  const baseSchema = schemas[0].schema;
  const mergedImports = [
    ...new Map(
      schemas
        .flatMap((schema) => schema.imports)
        .map((imp) => [JSON.stringify(imp), imp]),
    ).values(),
  ];
  const mergedDependencies = [
    ...new Set(schemas.flatMap((schema) => schema.dependencies ?? [])),
  ];
  const factory = schemas.find((schema) => schema.factory)?.factory;
  return {
    name: baseSchemaName,
    schema: baseSchema,
    model: schemas.map((schema) => schema.model).join('\n'),
    imports: mergedImports,
    dependencies: mergedDependencies,
    factory,
  };
}

function resolveImportKey(
  schemaPath: string,
  importPath: string,
  fileExtension: string,
) {
  return upath
    .join(schemaPath, `${importPath}${fileExtension}`)
    .toLowerCase()
    .replaceAll('\\', '/');
}

function removeFileExtension(path: string, fileExtension: string) {
  return path.endsWith(fileExtension)
    ? path.slice(0, path.length - fileExtension.length)
    : path;
}

interface GetSchemaOptions {
  schema: GeneratorSchema;
  target: string;
  header: string;
  namingConvention?: NamingConvention;
}

function getSchema({
  schema: { imports, model },
  target,
  header,
  namingConvention = NamingConvention.CAMEL_CASE,
}: GetSchemaOptions): string {
  let file = header;
  file += generateImports({
    imports: imports.filter(
      (imp) =>
        !model.includes(`type ${imp.alias ?? imp.name} =`) &&
        !model.includes(`interface ${imp.alias ?? imp.name} {`) &&
        !model.includes(`function ${imp.alias ?? imp.name}(`),
    ),
    target,
    namingConvention,
  });
  file += imports.length > 0 ? '\n\n' : '\n';
  file += model;
  return file;
}

function getPath(path: string, name: string, fileExtension: string): string {
  return nodePath.join(path, `${name}${fileExtension}`);
}

export function writeModelInline(acc: string, model: string): string {
  return acc + `${model}\n`;
}

export function writeModelsInline(array: GeneratorSchema[]): string {
  let acc = '';
  for (const { model } of array) {
    acc = writeModelInline(acc, model);
  }
  return acc;
}

interface WriteSchemaOptions {
  path: string;
  schema: GeneratorSchema;
  target: string;
  namingConvention: NamingConvention;
  fileExtension: string;
  header: string;
}

export async function writeSchema({
  path,
  schema,
  target,
  namingConvention,
  fileExtension,
  header,
}: WriteSchemaOptions) {
  const name = conventionName(schema.name, namingConvention);

  try {
    await fs.outputFile(
      getPath(path, name, fileExtension),
      getSchema({
        schema,
        target,
        header,
        namingConvention,
      }),
    );
  } catch (error) {
    throw new Error(
      `Oups... 🍻. An Error occurred while writing schema ${name} => ${String(error)}`,
    );
  }
}

interface WriteSchemasOptions {
  schemaPath: string;
  schemas: GeneratorSchema[];
  target: string;
  namingConvention: NamingConvention;
  fileExtension: string;
  header: string;
  indexFiles: boolean;
  factoryMethods?: NormalizedFactoryMethodsOptions;
}

export async function writeSchemas({
  schemaPath,
  schemas,
  target,
  namingConvention,
  fileExtension,
  header,
  indexFiles,
  factoryMethods,
}: WriteSchemasOptions) {
  const schemaGroups = getSchemaGroups(
    schemaPath,
    schemas,
    namingConvention,
    fileExtension,
  );

  const canonicalPathByKey = getCanonicalMap(
    schemaGroups,
    schemaPath,
    namingConvention,
    fileExtension,
  );

  normalizeCanonicalImportPaths(
    schemas,
    canonicalPathByKey,
    schemaPath,
    namingConvention,
    fileExtension,
  );

  let combinedFactoryModel = '';
  const combinedFactoryImports: GeneratorImport[] = [];

  for (const groupSchemas of Object.values(schemaGroups)) {
    if (groupSchemas.length === 1 && !groupSchemas[0].factory) {
      await writeSchema({
        path: schemaPath,
        schema: groupSchemas[0],
        target,
        namingConvention,
        fileExtension,
        header,
      });
      continue;
    }

    const mergedSchema =
      groupSchemas.length === 1
        ? groupSchemas[0]
        : mergeSchemaGroup(groupSchemas);

    if (mergedSchema.factory) {
      const location = factoryMethods?.location || 'inline-with-model';
      const resolvedImports = resolveFactoryImports(
        mergedSchema.factory.imports,
        location,
        namingConvention,
      );

      switch (location) {
        case 'inline-with-model': {
          mergedSchema.model += '\n' + mergedSchema.factory.model;
          mergedSchema.imports.push(...resolvedImports);

          break;
        }
        case 'separate-file': {
          const factorySchema: GeneratorSchema = {
            name: mergedSchema.name,
            model: mergedSchema.factory.model,
            imports: resolvedImports,
          };
          await writeSchema({
            path: schemaPath,
            schema: factorySchema,
            target,
            namingConvention,
            fileExtension: `.factory${fileExtension}`,
            header,
          });

          break;
        }
        case 'combined-separate-file': {
          combinedFactoryModel += mergedSchema.factory.model + '\n';
          combinedFactoryImports.push(...resolvedImports);

          break;
        }
        // No default
      }
    }

    await writeSchema({
      path: schemaPath,
      schema: mergedSchema,
      target,
      namingConvention,
      fileExtension,
      header,
    });
  }

  if (
    factoryMethods?.location === 'combined-separate-file' &&
    combinedFactoryModel
  ) {
    const factorySchema: GeneratorSchema = {
      name: 'factoryMethods',
      model: combinedFactoryModel,
      imports: combinedFactoryImports,
    };
    await writeSchema({
      path: schemaPath,
      schema: factorySchema,
      target,
      namingConvention: NamingConvention.CAMEL_CASE,
      fileExtension,
      header,
    });
  }

  if (indexFiles) {
    const schemaFilePath = nodePath.join(schemaPath, `index${fileExtension}`);
    await fs.ensureFile(schemaFilePath);

    // Ensure separate files are used for parallel schema writing.
    // Throw an exception if duplicates are detected (using convention names)
    const ext = fileExtension.endsWith('.ts')
      ? fileExtension.slice(0, -3)
      : fileExtension;
    const conventionNamesSet = new Set(
      Object.values(schemaGroups).map((group) =>
        conventionName(group[0].name, namingConvention),
      ),
    );

    try {
      // Create unique export statements from schemas (deduplicate by schema name)
      const uniqueSchemaNames = [...conventionNamesSet];
      const newExports: string[] = [];

      if (factoryMethods?.generate) {
        if (factoryMethods.location === 'separate-file') {
          for (const groupSchemas of Object.values(schemaGroups)) {
            const mergedSchema =
              groupSchemas.length === 1
                ? groupSchemas[0]
                : mergeSchemaGroup(groupSchemas);
            if (mergedSchema.factory) {
              newExports.push(
                `export * from './${conventionName(mergedSchema.name, namingConvention)}.factory${ext}';`,
              );
            }
          }
        } else if (
          factoryMethods.location === 'combined-separate-file' &&
          combinedFactoryModel
        ) {
          newExports.push(`export * from './factoryMethods${ext}';`);
        }
      }

      // Create export statements
      const currentExports = uniqueSchemaNames
        .map((schemaName) => `export * from './${schemaName}${ext}';`)
        .concat(newExports)
        .toSorted((a, b) => a.localeCompare(b));

      const existingContent = await fs.readFile(schemaFilePath, 'utf8');
      const existingExports =
        existingContent
          .match(/export\s+\*\s+from\s+['"][^'"]+['"]/g)
          ?.map((statement) => {
            const match = /export\s+\*\s+from\s+['"]([^'"]+)['"]/.exec(
              statement,
            );
            if (!match) return;
            return `export * from '${match[1]}';`;
          })
          .filter(Boolean) ?? [];

      const exports = [...new Set([...existingExports, ...currentExports])]
        .toSorted((a, b) => a.localeCompare(b))
        .join('\n');

      const fileContent = `${header}\n${exports}`;

      await fs.writeFile(schemaFilePath, fileContent, { encoding: 'utf8' });
    } catch (error) {
      throw new Error(
        `Oups... 🍻. An Error occurred while writing schema index file ${schemaFilePath} => ${String(error)}`,
      );
    }
  }
}
