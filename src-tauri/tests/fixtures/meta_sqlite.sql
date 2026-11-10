-- Introspection fixture, SQLite flavor of the logical "shop" schema shared by every engine
-- (see meta_postgres.sql). SQLite has no schemas, sequences, routines nor types: tables of
-- the PostgreSQL `sales` and odd schemas live beside the others, the enum is a CHECK.

CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    full_name VARCHAR(200) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT customers_email_key UNIQUE (email)
);
CREATE INDEX customers_lower_email_idx ON customers (lower(email));

CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku VARCHAR(32) NOT NULL,
    name TEXT NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
    CONSTRAINT products_sku_key UNIQUE (sku),
    CONSTRAINT products_name_status_key UNIQUE (name, status),
    CONSTRAINT products_price_check CHECK (price >= 0)
);

CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    subtotal NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
    shipping NUMERIC(12,2) NOT NULL DEFAULT 0,
    total NUMERIC(12,2) GENERATED ALWAYS AS (subtotal + shipping) STORED,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id)
        REFERENCES customers (id) ON DELETE CASCADE
);
CREATE INDEX orders_created_at_idx ON orders (created_at DESC) WHERE total > 0;

CREATE TABLE order_items (
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (order_id, product_id),
    CONSTRAINT order_items_order_fk FOREIGN KEY (order_id)
        REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT order_items_product_fk FOREIGN KEY (product_id)
        REFERENCES products ON UPDATE CASCADE ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE "Odd ""Table""" (
    "Id" INTEGER PRIMARY KEY,
    "Select" TEXT,
    "col with space" TEXT
);

CREATE TABLE invoices (
    id INTEGER PRIMARY KEY,
    number INTEGER NOT NULL,
    order_id INTEGER NOT NULL,
    issued_at DATE NOT NULL DEFAULT CURRENT_DATE,
    CONSTRAINT invoices_order_fk FOREIGN KEY (order_id) REFERENCES orders (id)
);

CREATE VIEW customer_orders AS
SELECT o.id AS order_id, c.email, o.total
FROM orders o JOIN customers c ON c.id = o.customer_id;

CREATE TRIGGER orders_touch BEFORE UPDATE ON orders
FOR EACH ROW BEGIN SELECT 1; END;
