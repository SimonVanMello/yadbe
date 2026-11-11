import type {
  ColumnInfo,
  DatabaseInfo,
  ForeignKeyAction,
  IndexInfo,
  ObjectInfo,
  ObjectKind,
  ObjectRef,
  SchemaInfo,
  TableDetails,
  TriggerInfo,
  TypeCategory,
  ValueKind,
} from '../bindings';

/** One schema of a mock database (`info: null` on engines without schemas). */
export interface MockSchema {
  info: SchemaInfo | null;
  objects: ObjectInfo[];
  /** Details of tables, views and materialized views, by name. */
  tables: Map<string, TableDetails>;
}

export interface MockDatabase {
  info: DatabaseInfo;
  schemas: MockSchema[];
  searchPath: string[];
  /** Expanding the database fails with this message (no `CONNECT` privilege). */
  denied?: string;
}

/** Object kinds per engine, in explorer order (mirror of `MetaCapabilities`). */
export const MOCK_OBJECT_KINDS: Record<string, ObjectKind[]> = {
  postgres: ['table', 'view', 'materializedView', 'function', 'procedure', 'sequence', 'type'],
  mssql: ['table', 'view', 'function', 'procedure', 'sequence', 'type'],
  mysql: ['table', 'view', 'function', 'procedure'],
  sqlite: ['table', 'view'],
};

/** Logical family of a type name, like the drivers report it. */
export function kindOfType(typeName: string): ValueKind {
  const t = typeName.toLowerCase();
  if (t.endsWith('[]')) return 'array';
  if (t === 'boolean' || t === 'bool') return 'bool';
  if (/^(small|big)?int(eger)?\b|^serial|^int[248]?$/.test(t)) return 'int';
  if (t.startsWith('numeric') || t.startsWith('decimal') || t === 'money') return 'decimal';
  if (t === 'real' || t.startsWith('double') || t.startsWith('float')) return 'float';
  if (t === 'bytea' || t === 'blob') return 'bytes';
  if (t === 'date') return 'date';
  if (t.startsWith('timestamp with time zone') || t === 'timestamptz') return 'timestampTz';
  if (t.startsWith('timestamp') || t === 'datetime') return 'timestamp';
  if (t.startsWith('time')) return 'time';
  if (t === 'interval') return 'interval';
  if (t === 'uuid') return 'uuid';
  if (t === 'json' || t === 'jsonb') return 'json';
  if (t === 'text' || t.includes('char') || t === 'citext' || t.includes('status')) return 'text';
  return 'other';
}

// --- Compact definitions -------------------------------------------------------------------

interface ColumnDef {
  name: string;
  type: string;
  nullable?: boolean;
  default?: string;
  identity?: 'always' | 'byDefault';
  generated?: string;
  comment?: string;
}

interface ForeignKeyDef {
  columns: string[];
  /** `schema.table` or `table` (same schema). */
  references: string;
  referencedColumns?: string[];
  onDelete?: ForeignKeyAction;
  onUpdate?: ForeignKeyAction;
}

interface TableDef {
  name: string;
  kind?: 'table' | 'view' | 'materializedView';
  comment?: string;
  rows?: number;
  columns: ColumnDef[];
  primaryKey?: string[];
  unique?: string[][];
  foreignKeys?: ForeignKeyDef[];
  checks?: [string, string][];
  indexes?: { name: string; columns: string[]; unique?: boolean; predicate?: string }[];
  triggers?: { name: string; timing: TriggerInfo['timing']; events: TriggerInfo['events'] }[];
}

interface RoutineDef {
  name: string;
  args: string;
  identity: string;
  returns: string | null;
  language?: string;
  comment?: string;
}

interface SchemaDef {
  name: string | null;
  system?: boolean;
  owner?: string;
  comment?: string;
  tables: TableDef[];
  functions?: RoutineDef[];
  procedures?: RoutineDef[];
  sequences?: { name: string; ownedBy?: [string, string] }[];
  types?: {
    name: string;
    category: TypeCategory;
    values?: string[];
    base?: string;
    attributes?: [string, string][];
  }[];
}

const c = (name: string, type: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type,
  ...extra,
});
const id = (identity: 'always' | 'byDefault' = 'always') => c('id', 'integer', { identity });
const createdAt = () => c('created_at', 'timestamp with time zone', { default: 'now()' });
const updatedAt = () => c('updated_at', 'timestamp with time zone', { default: 'now()' });
const opt = (name: string, type: string, extra: Partial<ColumnDef> = {}) =>
  c(name, type, { nullable: true, ...extra });
const fk = (
  column: string,
  references: string,
  onDelete: ForeignKeyAction = 'noAction',
): ForeignKeyDef => ({ columns: [column], references, onDelete });

function table(name: string, rows: number, columns: ColumnDef[], extra: Partial<TableDef> = {}) {
  return { name, rows, columns, primaryKey: ['id'], ...extra } satisfies TableDef;
}

const touch: NonNullable<TableDef['triggers']>[number] = {
  name: 'touch_updated_at',
  timing: 'before',
  events: ['update'],
};

const SHOP_SCHEMAS: SchemaDef[] = [
  {
    name: 'public',
    owner: 'postgres',
    comment: 'standard public schema',
    tables: [
      table('schema_migrations', 48, [c('version', 'bigint'), createdAt()], {
        primaryKey: ['version'],
      }),
      table('feature_flags', 12, [
        id(),
        c('key', 'text'),
        c('enabled', 'boolean', { default: 'false' }),
        opt('rollout', 'numeric(5,2)'),
      ]),
      table(
        'type_samples',
        64,
        [
          id('byDefault'),
          opt('flag', 'boolean'),
          opt('small', 'smallint'),
          opt('big', 'bigint'),
          opt('amount', 'numeric(20,6)'),
          opt('ratio', 'double precision'),
          opt('label', 'text'),
          opt('raw', 'bytea'),
          opt('day', 'date'),
          opt('at_time', 'time without time zone'),
          opt('local_at', 'timestamp without time zone'),
          opt('at', 'timestamp with time zone'),
          opt('duration', 'interval'),
          opt('ref', 'uuid'),
          opt('doc', 'jsonb'),
          opt('tags', 'text[]'),
          opt('address', 'inet'),
        ],
        { comment: 'One column of each value kind' },
      ),
    ],
  },
  {
    name: 'shop',
    owner: 'shop_owner',
    comment: 'Catalog, customers and orders',
    tables: [
      table(
        'customers',
        48_210,
        [
          id(),
          c('email', 'shop.email', { comment: 'Lower-cased, unique' }),
          c('full_name', 'character varying(200)'),
          opt('phone', 'character varying(32)'),
          opt('birth_date', 'date'),
          c('marketing_opt_in', 'boolean', { default: 'false' }),
          createdAt(),
          updatedAt(),
        ],
        {
          comment: 'People who placed at least one order or created an account',
          unique: [['email']],
          indexes: [{ name: 'customers_lower_email_idx', columns: ['lower(email)'] }],
          triggers: [touch],
        },
      ),
      table(
        'addresses',
        61_002,
        [
          id(),
          c('customer_id', 'integer'),
          c('kind', 'text', { default: "'shipping'::text" }),
          c('line1', 'text'),
          opt('line2', 'text'),
          c('city', 'text'),
          opt('postal_code', 'character varying(16)'),
          c('country_code', 'character(2)'),
        ],
        {
          foreignKeys: [fk('customer_id', 'customers', 'cascade')],
          checks: [
            ['addresses_kind_check', "kind = ANY (ARRAY['shipping'::text, 'billing'::text])"],
          ],
        },
      ),
      table(
        'categories',
        86,
        [id(), opt('parent_id', 'integer'), c('slug', 'text'), c('name', 'text')],
        {
          unique: [['slug']],
          foreignKeys: [fk('parent_id', 'categories', 'setNull')],
        },
      ),
      table(
        'products',
        3_412,
        [
          id(),
          c('sku', 'character varying(32)'),
          c('name', 'text'),
          opt('description', 'text'),
          c('price', 'numeric(10,2)'),
          c('status', 'shop.product_status', { default: "'draft'::shop.product_status" }),
          opt('attributes', 'jsonb'),
          c('weight_grams', 'integer', { default: '0' }),
          createdAt(),
          updatedAt(),
        ],
        {
          unique: [['sku']],
          checks: [['products_price_check', 'price >= 0::numeric']],
          indexes: [
            { name: 'products_status_idx', columns: ['status'], predicate: "status <> 'archived'" },
          ],
          triggers: [touch],
        },
      ),
      table(
        'product_categories',
        5_120,
        [c('product_id', 'integer'), c('category_id', 'integer')],
        {
          primaryKey: ['product_id', 'category_id'],
          foreignKeys: [
            fk('product_id', 'products', 'cascade'),
            fk('category_id', 'categories', 'cascade'),
          ],
        },
      ),
      table('suppliers', 41, [
        id(),
        c('name', 'text'),
        opt('contact_email', 'text'),
        opt('country_code', 'character(2)'),
      ]),
      table('warehouses', 4, [id(), c('code', 'character varying(8)'), c('city', 'text')], {
        unique: [['code']],
      }),
      table(
        'inventory',
        13_200,
        [
          c('product_id', 'integer'),
          c('warehouse_id', 'integer'),
          c('quantity', 'integer', { default: '0' }),
          opt('reorder_level', 'integer'),
          updatedAt(),
        ],
        {
          primaryKey: ['product_id', 'warehouse_id'],
          foreignKeys: [fk('product_id', 'products', 'cascade'), fk('warehouse_id', 'warehouses')],
          checks: [['inventory_quantity_check', 'quantity >= 0']],
        },
      ),
      table(
        'orders',
        182_944,
        [
          id(),
          c('customer_id', 'integer'),
          c('status', 'shop.order_status', { default: "'pending'::shop.order_status" }),
          c('subtotal', 'numeric(12,2)'),
          c('shipping', 'numeric(12,2)', { default: '0' }),
          c('total', 'numeric(12,2)', { generated: '(subtotal + shipping)' }),
          opt('shipping_address_id', 'integer'),
          opt('note', 'text'),
          createdAt(),
          updatedAt(),
        ],
        {
          comment: 'One row per checkout',
          foreignKeys: [
            fk('customer_id', 'customers', 'restrict'),
            fk('shipping_address_id', 'addresses', 'setNull'),
          ],
          indexes: [
            { name: 'orders_customer_id_idx', columns: ['customer_id'] },
            { name: 'orders_created_at_idx', columns: ['created_at DESC'] },
          ],
          triggers: [touch],
        },
      ),
      table(
        'order_items',
        512_330,
        [
          c('order_id', 'integer'),
          c('line_no', 'smallint'),
          c('product_id', 'integer'),
          c('quantity', 'integer'),
          c('unit_price', 'numeric(10,2)'),
          c('discount', 'numeric(10,2)', { default: '0' }),
        ],
        {
          primaryKey: ['order_id', 'line_no'],
          foreignKeys: [
            fk('order_id', 'orders', 'cascade'),
            fk('product_id', 'products', 'restrict'),
          ],
          checks: [['order_items_quantity_check', 'quantity > 0']],
        },
      ),
      table(
        'payments',
        179_001,
        [
          id(),
          c('order_id', 'integer'),
          c('provider', 'text'),
          c('amount', 'numeric(12,2)'),
          c('currency', 'character(3)', { default: "'EUR'::bpchar" }),
          opt('captured_at', 'timestamp with time zone'),
          opt('provider_ref', 'text'),
        ],
        {
          foreignKeys: [fk('order_id', 'orders', 'cascade')],
          unique: [['provider', 'provider_ref']],
        },
      ),
      table(
        'shipments',
        170_455,
        [
          id(),
          c('order_id', 'integer'),
          c('warehouse_id', 'integer'),
          opt('carrier', 'text'),
          opt('tracking_number', 'text'),
          opt('shipped_at', 'timestamp with time zone'),
          opt('delivered_at', 'timestamp with time zone'),
        ],
        { foreignKeys: [fk('order_id', 'orders', 'cascade'), fk('warehouse_id', 'warehouses')] },
      ),
      table(
        'returns',
        6_210,
        [
          id(),
          c('order_id', 'integer'),
          c('reason', 'text'),
          c('approved', 'boolean', { default: 'false' }),
          createdAt(),
        ],
        { foreignKeys: [fk('order_id', 'orders')] },
      ),
      table(
        'coupons',
        220,
        [
          id(),
          c('code', 'character varying(24)'),
          c('percent_off', 'smallint'),
          opt('valid_until', 'date'),
        ],
        { unique: [['code']] },
      ),
      table('order_coupons', 31_870, [c('order_id', 'integer'), c('coupon_id', 'integer')], {
        primaryKey: ['order_id', 'coupon_id'],
        foreignKeys: [fk('order_id', 'orders', 'cascade'), fk('coupon_id', 'coupons')],
      }),
      table(
        'reviews',
        22_418,
        [
          id(),
          c('product_id', 'integer'),
          c('customer_id', 'integer'),
          c('rating', 'smallint'),
          opt('body', 'text'),
          createdAt(),
        ],
        {
          foreignKeys: [
            fk('product_id', 'products', 'cascade'),
            fk('customer_id', 'customers', 'cascade'),
          ],
          checks: [['reviews_rating_check', 'rating >= 1 AND rating <= 5']],
        },
      ),
      table(
        'carts',
        9_877,
        [id(), opt('customer_id', 'integer'), c('token', 'uuid'), createdAt()],
        {
          foreignKeys: [fk('customer_id', 'customers', 'cascade')],
          unique: [['token']],
        },
      ),
      table(
        'cart_items',
        21_010,
        [
          c('cart_id', 'integer'),
          c('product_id', 'integer'),
          c('quantity', 'integer', { default: '1' }),
        ],
        {
          primaryKey: ['cart_id', 'product_id'],
          foreignKeys: [fk('cart_id', 'carts', 'cascade'), fk('product_id', 'products', 'cascade')],
        },
      ),
      table(
        'wishlists',
        4_402,
        [c('customer_id', 'integer'), c('product_id', 'integer'), createdAt()],
        {
          primaryKey: ['customer_id', 'product_id'],
          foreignKeys: [
            fk('customer_id', 'customers', 'cascade'),
            fk('product_id', 'products', 'cascade'),
          ],
        },
      ),
      table(
        'price_history',
        18_903,
        [
          id('byDefault'),
          c('product_id', 'integer'),
          c('price', 'numeric(10,2)'),
          c('valid_from', 'timestamp with time zone'),
        ],
        { foreignKeys: [fk('product_id', 'products', 'cascade')] },
      ),
      table(
        'Order Notes',
        312,
        [
          id(),
          c('order_id', 'integer'),
          c('Select', 'text', { comment: 'Odd identifier: a keyword' }),
          opt('author name', 'text'),
        ],
        {
          comment: 'Odd identifiers that need quoting',
          foreignKeys: [fk('order_id', 'orders', 'cascade')],
        },
      ),
      {
        name: 'customer_orders',
        kind: 'view',
        comment: 'Orders with their customer',
        columns: [
          opt('order_id', 'integer'),
          opt('email', 'shop.email'),
          opt('status', 'shop.order_status'),
          opt('total', 'numeric(12,2)'),
          opt('created_at', 'timestamp with time zone'),
        ],
      },
      {
        name: 'product_stock',
        kind: 'view',
        columns: [
          opt('product_id', 'integer'),
          opt('sku', 'character varying(32)'),
          opt('in_stock', 'bigint'),
        ],
      },
    ],
    functions: [
      {
        name: 'order_total',
        args: 'p_order_id integer',
        identity: 'p_order_id integer',
        returns: 'numeric',
        language: 'sql',
        comment: 'Sum of the lines of an order',
      },
      {
        name: 'price_at',
        args: 'p_product_id integer',
        identity: 'p_product_id integer',
        returns: 'numeric',
        language: 'sql',
      },
      {
        name: 'price_at',
        args: 'p_product_id integer, p_at timestamp with time zone',
        identity: 'p_product_id integer, p_at timestamp with time zone',
        returns: 'numeric',
        language: 'sql',
      },
      {
        name: 'apply_coupon',
        args: "p_order_id integer, p_code text DEFAULT ''::text",
        identity: 'p_order_id integer, p_code text',
        returns: 'boolean',
        language: 'plpgsql',
      },
      { name: 'touch_updated_at', args: '', identity: '', returns: 'trigger', language: 'plpgsql' },
    ],
    procedures: [
      {
        name: 'restock',
        args: 'p_warehouse_id integer',
        identity: 'p_warehouse_id integer',
        returns: null,
        language: 'plpgsql',
      },
    ],
    sequences: [{ name: 'price_history_id_seq', ownedBy: ['price_history', 'id'] }],
    types: [
      {
        name: 'order_status',
        category: 'enum',
        values: ['pending', 'paid', 'shipped', 'delivered', 'cancelled'],
      },
      { name: 'product_status', category: 'enum', values: ['draft', 'active', 'archived'] },
      { name: 'email', category: 'domain', base: 'citext' },
      {
        name: 'money_amount',
        category: 'composite',
        attributes: [
          ['amount', 'numeric(12,2)'],
          ['currency', 'character(3)'],
        ],
      },
    ],
  },
  {
    name: 'sales',
    owner: 'shop_owner',
    tables: [
      table(
        'invoices',
        175_330,
        [
          id(),
          c('number', 'bigint', { default: "nextval('sales.invoice_number_seq'::regclass)" }),
          c('order_id', 'integer'),
          c('issued_at', 'date', { default: 'CURRENT_DATE' }),
          c('total', 'numeric(12,2)'),
          opt('pdf', 'bytea'),
        ],
        { unique: [['number']], foreignKeys: [fk('order_id', 'shop.orders', 'restrict')] },
      ),
      table(
        'invoice_lines',
        498_211,
        [
          c('invoice_id', 'integer'),
          c('line_no', 'smallint'),
          c('label', 'text'),
          c('amount', 'numeric(12,2)'),
          c('tax_rate_id', 'integer'),
        ],
        {
          primaryKey: ['invoice_id', 'line_no'],
          foreignKeys: [fk('invoice_id', 'invoices', 'cascade'), fk('tax_rate_id', 'tax_rates')],
        },
      ),
      table(
        'refunds',
        3_002,
        [
          id(),
          c('invoice_id', 'integer'),
          opt('line_no', 'smallint', { comment: 'The refunded line, when not the whole invoice' }),
          c('amount', 'numeric(12,2)'),
          opt('reason', 'text'),
          createdAt(),
        ],
        {
          foreignKeys: [
            fk('invoice_id', 'invoices'),
            // A composite key: the line of the invoice (F-088 fills both columns together).
            {
              columns: ['invoice_id', 'line_no'],
              references: 'invoice_lines',
              referencedColumns: ['invoice_id', 'line_no'],
            },
          ],
        },
      ),
      table('tax_rates', 9, [
        id(),
        c('country_code', 'character(2)'),
        c('rate', 'numeric(5,4)'),
        opt('valid_to', 'date'),
      ]),
      table(
        'currencies',
        31,
        [c('code', 'character(3)'), c('name', 'text'), c('decimals', 'smallint', { default: '2' })],
        {
          primaryKey: ['code'],
        },
      ),
      table(
        'exchange_rates',
        11_315,
        [c('currency', 'character(3)'), c('day', 'date'), c('rate', 'numeric(18,8)')],
        { primaryKey: ['currency', 'day'], foreignKeys: [fk('currency', 'currencies', 'cascade')] },
      ),
      {
        name: 'monthly_revenue',
        kind: 'view',
        columns: [opt('month', 'date'), opt('revenue', 'numeric'), opt('invoices', 'bigint')],
      },
    ],
    procedures: [
      {
        name: 'archive_invoices',
        args: 'p_before date',
        identity: 'p_before date',
        returns: null,
        language: 'plpgsql',
      },
    ],
    sequences: [{ name: 'invoice_number_seq' }],
  },
  {
    name: 'auth',
    owner: 'shop_owner',
    tables: [
      table(
        'users',
        312,
        [
          c('id', 'uuid', { default: 'gen_random_uuid()' }),
          c('login', 'text'),
          c('password_hash', 'text'),
          opt('customer_id', 'integer'),
          c('disabled', 'boolean', { default: 'false' }),
          opt('last_login_at', 'timestamp with time zone'),
        ],
        { unique: [['login']], foreignKeys: [fk('customer_id', 'shop.customers', 'setNull')] },
      ),
      table('roles', 6, [id(), c('name', 'text')], { unique: [['name']] }),
      table('user_roles', 340, [c('user_id', 'uuid'), c('role_id', 'integer')], {
        primaryKey: ['user_id', 'role_id'],
        foreignKeys: [fk('user_id', 'users', 'cascade'), fk('role_id', 'roles', 'cascade')],
      }),
      table(
        'sessions',
        1_870,
        [
          c('token', 'text'),
          c('user_id', 'uuid'),
          c('expires_at', 'timestamp with time zone'),
          opt('ip', 'inet'),
        ],
        { primaryKey: ['token'], foreignKeys: [fk('user_id', 'users', 'cascade')] },
      ),
      table(
        'api_keys',
        18,
        [id(), c('user_id', 'uuid'), c('prefix', 'character(8)'), c('hash', 'text'), createdAt()],
        {
          foreignKeys: [fk('user_id', 'users', 'cascade')],
        },
      ),
      table(
        'audit_log',
        2_401_877,
        [
          id('byDefault'),
          opt('user_id', 'uuid'),
          c('action', 'text'),
          opt('payload', 'jsonb'),
          c('at', 'timestamp with time zone', { default: 'now()' }),
        ],
        { comment: 'Append-only' },
      ),
    ],
    functions: [
      {
        name: 'hash_password',
        args: 'p_plain text',
        identity: 'p_plain text',
        returns: 'text',
        language: 'plpgsql',
      },
      {
        name: 'has_role',
        args: 'p_user uuid, p_role text',
        identity: 'p_user uuid, p_role text',
        returns: 'boolean',
        language: 'sql',
      },
    ],
  },
  {
    name: 'analytics',
    owner: 'analyst',
    tables: [
      table('events', 9_812_330, [
        id('byDefault'),
        c('name', 'text'),
        opt('customer_id', 'integer'),
        opt('properties', 'jsonb'),
        c('at', 'timestamp with time zone'),
      ]),
      table(
        'page_views',
        31_200_412,
        [
          id('byDefault'),
          c('path', 'text'),
          opt('referrer', 'text'),
          opt('session_id', 'uuid'),
          c('at', 'timestamp with time zone'),
        ],
        { primaryKey: undefined, comment: 'Append-only, without key: read-only in table tabs' },
      ),
      {
        name: 'daily_sales',
        kind: 'materializedView',
        rows: 1_460,
        columns: [opt('day', 'date'), opt('orders', 'bigint'), opt('revenue', 'numeric')],
      },
      {
        name: 'top_products',
        kind: 'materializedView',
        rows: 100,
        columns: [opt('product_id', 'integer'), opt('units', 'bigint')],
      },
    ],
    functions: [
      {
        name: 'funnel',
        args: 'p_from date, p_to date',
        identity: 'p_from date, p_to date',
        returns: 'TABLE(step text, visitors bigint)',
        language: 'sql',
      },
    ],
  },
  {
    name: 'information_schema',
    system: true,
    owner: 'postgres',
    tables: [
      {
        name: 'columns',
        kind: 'view',
        columns: [
          opt('table_schema', 'name'),
          opt('table_name', 'name'),
          opt('column_name', 'name'),
          opt('data_type', 'character varying'),
        ],
      },
      {
        name: 'tables',
        kind: 'view',
        columns: [
          opt('table_schema', 'name'),
          opt('table_name', 'name'),
          opt('table_type', 'character varying'),
        ],
      },
    ],
  },
  {
    name: 'pg_catalog',
    system: true,
    owner: 'postgres',
    comment: 'system catalog schema',
    tables: [
      table(
        'pg_class',
        415,
        [c('oid', 'oid'), c('relname', 'name'), c('relnamespace', 'oid'), c('relkind', '"char"')],
        { primaryKey: ['oid'] },
      ),
      table('pg_namespace', 9, [c('oid', 'oid'), c('nspname', 'name'), c('nspowner', 'oid')], {
        primaryKey: ['oid'],
      }),
      {
        name: 'pg_stat_activity',
        kind: 'view',
        columns: [
          opt('pid', 'integer'),
          opt('usename', 'name'),
          opt('state', 'text'),
          opt('query', 'text'),
        ],
      },
    ],
    functions: [
      {
        name: 'now',
        args: '',
        identity: '',
        returns: 'timestamp with time zone',
        language: 'internal',
      },
      { name: 'lower', args: 'text', identity: 'text', returns: 'text', language: 'internal' },
    ],
  },
];

const APP_SQLITE: SchemaDef[] = [
  {
    name: null,
    tables: [
      table('notes', 1_204, [
        c('id', 'INTEGER', { identity: 'byDefault' }),
        c('title', 'TEXT'),
        opt('body', 'TEXT'),
        c('pinned', 'BOOLEAN', { default: '0' }),
        c('created_at', 'DATETIME', { default: 'CURRENT_TIMESTAMP' }),
      ]),
      table('tags', 37, [c('id', 'INTEGER', { identity: 'byDefault' }), c('name', 'TEXT')], {
        unique: [['name']],
      }),
      table('note_tags', 2_890, [c('note_id', 'INTEGER'), c('tag_id', 'INTEGER')], {
        primaryKey: ['note_id', 'tag_id'],
        foreignKeys: [fk('note_id', 'notes', 'cascade'), fk('tag_id', 'tags', 'cascade')],
      }),
      table('settings', 14, [c('key', 'TEXT'), opt('value', 'TEXT')], { primaryKey: ['key'] }),
      { name: 'sqlite_sequence', columns: [opt('name', ''), opt('seq', '')] },
      {
        name: 'recent_notes',
        kind: 'view',
        columns: [opt('id', 'INTEGER'), opt('title', 'TEXT'), opt('created_at', 'DATETIME')],
      },
    ],
  },
];

// --- Building the model --------------------------------------------------------------------

function ref(database: string, schema: string | null, name: string): ObjectRef {
  return { database, schema, name };
}

function buildTable(database: string, schema: string | null, def: TableDef): TableDetails {
  const kind = def.kind ?? 'table';
  const pk = kind === 'table' ? (def.primaryKey ?? null) : null;
  const fkColumns = new Set((def.foreignKeys ?? []).flatMap((f) => f.columns));
  const columns: ColumnInfo[] = def.columns.map((col, index) => ({
    name: col.name,
    ordinal: index + 1,
    typeName: col.type,
    kind: kindOfType(col.type),
    nullable: col.nullable ?? false,
    default: col.default ?? null,
    identity: col.identity ?? null,
    generated: col.generated ? { stored: true, expression: col.generated } : null,
    comment: col.comment ?? null,
    primaryKey: pk?.includes(col.name) ?? false,
    foreignKey: fkColumns.has(col.name),
  }));
  const named = schema === null ? null : undefined;
  const indexes: IndexInfo[] = [];
  if (pk) {
    indexes.push({
      name: schema === null ? `sqlite_autoindex_${def.name}_1` : `${def.name}_pkey`,
      columns: pk,
      unique: true,
      primary: true,
      method: schema === null ? null : 'btree',
      predicate: null,
      definition: null,
    });
  }
  for (const key of def.unique ?? []) {
    indexes.push({
      name: `${def.name}_${key.join('_')}_key`,
      columns: key,
      unique: true,
      primary: false,
      method: schema === null ? null : 'btree',
      predicate: null,
      definition: null,
    });
  }
  for (const index of def.indexes ?? []) {
    indexes.push({
      name: index.name,
      columns: index.columns,
      unique: index.unique ?? false,
      primary: false,
      method: schema === null ? null : 'btree',
      predicate: index.predicate ?? null,
      definition: `CREATE INDEX ${index.name} ON ${def.name} (${index.columns.join(', ')})${index.predicate ? ` WHERE ${index.predicate}` : ''}`,
    });
  }
  return {
    table: ref(database, schema, def.name),
    kind,
    comment: def.comment ?? null,
    rowEstimate: kind === 'view' || schema === null ? null : (def.rows ?? null),
    columns,
    primaryKey: pk ? { name: named === null ? null : `${def.name}_pkey`, columns: pk } : null,
    uniqueKeys: (def.unique ?? []).map((key) => ({
      name: named === null ? null : `${def.name}_${key.join('_')}_key`,
      columns: key,
    })),
    foreignKeys: (def.foreignKeys ?? []).map((f) => {
      const [refSchema, refName] = f.references.includes('.')
        ? (f.references.split('.') as [string, string])
        : [schema, f.references];
      return {
        name: named === null ? null : `${def.name}_${f.columns.join('_')}_fkey`,
        columns: f.columns,
        referencedTable: ref(database, refSchema, refName),
        // Filled with the referenced primary key by `database()` when not given.
        referencedColumns: f.referencedColumns ?? [],
        onUpdate: f.onUpdate ?? 'noAction',
        onDelete: f.onDelete ?? 'noAction',
        deferrable: false,
      };
    }),
    checks: (def.checks ?? []).map(([name, expression]) => ({
      name: named === null ? null : name,
      expression,
    })),
    indexes,
    triggers: (def.triggers ?? []).map((t) => ({
      name: t.name,
      timing: t.timing,
      events: [...t.events],
      forEachRow: true,
      enabled: true,
      function: schema === null ? null : `${schema}.${t.name}`,
      definition: `CREATE TRIGGER ${t.name} ${t.timing.toUpperCase()} ${t.events.join(' OR ').toUpperCase()} ON ${def.name} FOR EACH ROW EXECUTE FUNCTION ${t.name}()`,
    })),
  };
}

function buildSchema(database: string, def: SchemaDef): MockSchema {
  const objects: ObjectInfo[] = [];
  const tables = new Map<string, TableDetails>();
  for (const t of def.tables) {
    const details = buildTable(database, def.name, t);
    tables.set(t.name, details);
    objects.push({
      kind: details.kind,
      name: t.name,
      id: t.name,
      system: def.name === null && t.name.startsWith('sqlite_'),
      comment: t.comment ?? null,
      detail: {
        type: 'relation',
        rowEstimate: details.rowEstimate,
        partitioned: false,
        foreign: false,
      },
    });
  }
  const routine = (kind: 'function' | 'procedure') => (r: RoutineDef) => {
    objects.push({
      kind,
      name: r.name,
      id: `${r.name}(${r.identity})`,
      system: false,
      comment: r.comment ?? null,
      detail: {
        type: 'routine',
        arguments: r.args,
        identityArguments: r.identity,
        returnType: r.returns,
        language: r.language ?? null,
        aggregate: false,
      },
    });
  };
  (def.functions ?? []).forEach(routine('function'));
  (def.procedures ?? []).forEach(routine('procedure'));
  for (const s of def.sequences ?? []) {
    objects.push({
      kind: 'sequence',
      name: s.name,
      id: s.name,
      system: false,
      comment: null,
      detail: {
        type: 'sequence',
        dataType: 'bigint',
        start: '1',
        increment: '1',
        min: '1',
        max: '9223372036854775807',
        cycle: false,
        ownedBy: s.ownedBy
          ? { table: ref(database, def.name, s.ownedBy[0]), column: s.ownedBy[1] }
          : null,
      },
    });
  }
  for (const t of def.types ?? []) {
    objects.push({
      kind: 'type',
      name: t.name,
      id: t.name,
      system: false,
      comment: null,
      detail: {
        type: 'type',
        category: t.category,
        enumValues: t.values ?? [],
        baseType: t.base ?? null,
        attributes: (t.attributes ?? []).map(([name, typeName]) => ({ name, typeName })),
      },
    });
  }
  objects.sort((a, b) => a.name.localeCompare(b.name));
  return {
    info:
      def.name === null
        ? null
        : {
            name: def.name,
            system: def.system ?? false,
            owner: def.owner ?? null,
            comment: def.comment ?? null,
          },
    objects,
    tables,
  };
}

function database(
  name: string,
  schemas: SchemaDef[],
  extra: Partial<DatabaseInfo> & { denied?: string } = {},
): MockDatabase {
  const { denied, ...info } = extra;
  // Sorted like the backend (`ORDER BY nspname`).
  const built = schemas
    .map((s) => buildSchema(name, s))
    .sort((a, b) => (a.info?.name ?? '').localeCompare(b.info?.name ?? ''));
  const find = (r: ObjectRef) =>
    built.find((s) => (s.info?.name ?? null) === r.schema)?.tables.get(r.name);
  for (const details of built.flatMap((s) => [...s.tables.values()])) {
    for (const key of details.foreignKeys) {
      if (key.referencedColumns.length === 0) {
        key.referencedColumns = find(key.referencedTable)?.primaryKey?.columns ?? ['id'];
      }
    }
  }
  return {
    info: { name, current: false, system: false, accessible: true, comment: null, ...info },
    schemas: built,
    searchPath: schemas.some((s) => s.name === 'public') ? ['public'] : [],
    ...(denied ? { denied } : {}),
  };
}

const PUBLIC_ONLY: SchemaDef[] = [
  { name: 'public', owner: 'postgres', comment: 'standard public schema', tables: [] },
];

/** The databases a mock PostgreSQL server holds; `current` is the connection's database. */
export function postgresServer(current: string, large: LargeCatalogOptions | null): MockDatabase[] {
  const main = current || 'postgres';
  const content = large ? largeSchemas(large) : SHOP_SCHEMAS;
  const databases = [
    database(main, content, { current: true, comment: 'Online shop' }),
    database('analytics_archive', PUBLIC_ONLY, {
      accessible: false,
      denied: 'permission denied for database analytics_archive',
    }),
    database('template1', PUBLIC_ONLY, { system: true }),
  ];
  if (main !== 'postgres') {
    databases.push(
      database('postgres', PUBLIC_ONLY, { comment: 'default administrative connection database' }),
    );
  }
  return databases.sort((a, b) => a.info.name.localeCompare(b.info.name));
}

/** The single database of a mock SQLite file. */
export function sqliteFile(): MockDatabase[] {
  return [database('main', APP_SQLITE, { current: true })];
}

// --- Large synthetic catalog (perf tests) --------------------------------------------------

export interface LargeCatalogOptions {
  schemas: number;
  tablesPerSchema: number;
  columnsPerTable: number;
  viewsPerSchema: number;
  functionsPerSchema: number;
}

/** 10 schemas × (900 tables + 50 views + 50 functions) = 10 000 objects. */
export const LARGE_CATALOG: LargeCatalogOptions = {
  schemas: 10,
  tablesPerSchema: 900,
  columnsPerTable: 10,
  viewsPerSchema: 50,
  functionsPerSchema: 50,
};

const SYNTHETIC_TYPES = [
  'integer',
  'bigint',
  'text',
  'numeric(12,2)',
  'boolean',
  'timestamp with time zone',
  'uuid',
  'jsonb',
];

function largeSchemas(options: LargeCatalogOptions): SchemaDef[] {
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  const schemas: SchemaDef[] = [];
  for (let s = 0; s < options.schemas; s++) {
    const tables: TableDef[] = [];
    for (let t = 0; t < options.tablesPerSchema; t++) {
      const columns: ColumnDef[] = [id()];
      for (let k = 1; k < options.columnsPerTable; k++) {
        columns.push(
          opt(`col_${pad(k, 2)}`, SYNTHETIC_TYPES[k % SYNTHETIC_TYPES.length] ?? 'text'),
        );
      }
      tables.push(
        table(`table_${pad(t, 4)}`, t * 13, columns, {
          foreignKeys: t > 0 ? [{ columns: ['col_01'], references: `table_${pad(t - 1, 4)}` }] : [],
        }),
      );
    }
    for (let v = 0; v < options.viewsPerSchema; v++) {
      tables.push({
        name: `view_${pad(v, 3)}`,
        kind: 'view',
        columns: [opt('id', 'integer'), opt('label', 'text')],
      });
    }
    const functions: RoutineDef[] = [];
    for (let f = 0; f < options.functionsPerSchema; f++) {
      functions.push({
        name: `fn_${pad(f, 3)}`,
        args: 'p integer',
        identity: 'p integer',
        returns: 'integer',
        language: 'sql',
      });
    }
    schemas.push({ name: `schema_${pad(s, 2)}`, owner: 'bench', tables, functions });
  }
  return [{ name: 'public', owner: 'postgres', tables: [] }, ...schemas];
}
