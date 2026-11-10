import type { ObjectRef } from '../../ipc';

/** `schema.name`, or the name alone on engines without schemas. */
export function tableLabel(table: Pick<ObjectRef, 'schema' | 'name'>): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}
