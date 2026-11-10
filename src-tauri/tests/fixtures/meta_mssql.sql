-- Introspection fixture, SQL Server flavor of the logical "shop" schema shared by every
-- engine (see meta_postgres.sql). Loaded batch by batch (yadbe's own `GO` splitter) into a
-- database created for the run, which the test drops afterwards.
-- Where SQL Server differs (the conformance suite reads it from the dialect's capabilities):
-- no expression index (a computed column would add a column to `customers`), triggers run
-- AFTER the statement, NO ACTION stands for RESTRICT, and since a filtered index cannot
-- reference a computed column, `orders_created_at_idx` filters on `subtotal`.

CREATE SCHEMA shop;
GO
CREATE SCHEMA sales;
GO
CREATE SCHEMA [Odd Schema];
GO
EXEC sp_addextendedproperty 'MS_Description', 'Catalog and orders', 'SCHEMA', 'shop';
CREATE TYPE shop.positive_amount FROM decimal(12,2) NOT NULL;
CREATE TYPE shop.order_lines AS TABLE (product_id int NOT NULL, quantity int NOT NULL);
GO

CREATE TABLE shop.customers (
    id int IDENTITY(1,1) NOT NULL CONSTRAINT customers_pkey PRIMARY KEY,
    email nvarchar(320) NOT NULL,
    full_name nvarchar(200) NOT NULL,
    created_at datetime2(3) NOT NULL CONSTRAINT customers_created_at_default DEFAULT SYSUTCDATETIME(),
    CONSTRAINT customers_email_key UNIQUE (email)
);
EXEC sp_addextendedproperty 'MS_Description', 'People who ordered',
    'SCHEMA', 'shop', 'TABLE', 'customers';
EXEC sp_addextendedproperty 'MS_Description', 'Lower-cased',
    'SCHEMA', 'shop', 'TABLE', 'customers', 'COLUMN', 'email';
GO

CREATE TABLE shop.products (
    id int IDENTITY(1,1) NOT NULL CONSTRAINT products_pkey PRIMARY KEY,
    sku varchar(32) NOT NULL,
    name nvarchar(200) NOT NULL,
    price decimal(10,2) NOT NULL,
    status varchar(10) NOT NULL CONSTRAINT products_status_default DEFAULT 'draft',
    CONSTRAINT products_sku_key UNIQUE (sku),
    CONSTRAINT products_name_status_key UNIQUE (name, status),
    CONSTRAINT products_price_check CHECK (price >= 0)
);
GO

CREATE TABLE shop.orders (
    id int IDENTITY(1,1) NOT NULL CONSTRAINT orders_pkey PRIMARY KEY,
    customer_id int NOT NULL,
    subtotal shop.positive_amount,
    shipping decimal(12,2) NOT NULL CONSTRAINT orders_shipping_default DEFAULT 0,
    total AS (subtotal + shipping) PERSISTED,
    created_at datetime2(3) NOT NULL CONSTRAINT orders_created_at_default DEFAULT SYSUTCDATETIME(),
    CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id)
        REFERENCES shop.customers (id) ON DELETE CASCADE
);
CREATE INDEX orders_created_at_idx ON shop.orders (created_at DESC) WHERE subtotal > 0;
GO

CREATE TABLE shop.order_items (
    order_id int NOT NULL,
    product_id int NOT NULL,
    quantity int NOT NULL CHECK (quantity > 0),
    CONSTRAINT order_items_pkey PRIMARY KEY (order_id, product_id),
    CONSTRAINT order_items_order_fk FOREIGN KEY (order_id)
        REFERENCES shop.orders (id) ON DELETE CASCADE,
    CONSTRAINT order_items_product_fk FOREIGN KEY (product_id)
        REFERENCES shop.products (id) ON UPDATE CASCADE
);
GO

CREATE TABLE [Odd Schema].[Odd "Table"] (
    [Id] int CONSTRAINT odd_pkey PRIMARY KEY,
    [Select] nvarchar(max),
    [col with space] nvarchar(max)
);
GO

CREATE SEQUENCE sales.invoice_number_seq AS bigint START WITH 1000;
GO

CREATE TABLE sales.invoices (
    id bigint IDENTITY(1,1) NOT NULL CONSTRAINT invoices_pkey PRIMARY KEY,
    number bigint NOT NULL
        CONSTRAINT invoices_number_default DEFAULT (NEXT VALUE FOR sales.invoice_number_seq),
    order_id int NOT NULL,
    issued_at date NOT NULL CONSTRAINT invoices_issued_at_default DEFAULT CAST(GETDATE() AS date),
    CONSTRAINT invoices_order_fk FOREIGN KEY (order_id) REFERENCES shop.orders (id)
);
GO

CREATE VIEW shop.customer_orders AS
SELECT o.id AS order_id, c.email, o.total
FROM shop.orders o JOIN shop.customers c ON c.id = o.customer_id;
GO

CREATE FUNCTION shop.order_total(@order_id int) RETURNS decimal(13,2)
AS
BEGIN
    RETURN (SELECT total FROM shop.orders WHERE id = @order_id);
END;
GO
EXEC sp_addextendedproperty 'MS_Description', 'Total of an order',
    'SCHEMA', 'shop', 'FUNCTION', 'order_total';
GO

CREATE FUNCTION shop.orders_of(@customer_id int) RETURNS TABLE
AS RETURN SELECT id, total FROM shop.orders WHERE customer_id = @customer_id;
GO

CREATE PROCEDURE sales.archive_invoices @before date, @archived int OUTPUT
AS
BEGIN
    DELETE FROM sales.invoices WHERE issued_at < @before;
    SET @archived = @@ROWCOUNT;
END;
GO

CREATE TRIGGER shop.orders_touch ON shop.orders AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE o SET created_at = SYSUTCDATETIME()
    FROM shop.orders o JOIN inserted i ON i.id = o.id;
END;
GO
