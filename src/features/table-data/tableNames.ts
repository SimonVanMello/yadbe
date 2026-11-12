import type { ObjectRef, Qualifier } from '../../ipc';

/**
 * `schema.name`, or the name alone on engines without schemas. With the engine's `database`
 * qualifier (MySQL, `tableQualifier` capability), `database.name`: a database plays the part of a
 * schema there, and two databases can hold tables of the same name.
 */
export function tableLabel(
  table: Pick<ObjectRef, 'schema' | 'name'> & { database?: string },
  qualifier: Qualifier = 'schema',
): string {
  if (qualifier === 'database' && table.database) return `${table.database}.${table.name}`;
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}
