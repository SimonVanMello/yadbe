-- Introspection fixture, MySQL / MariaDB flavor of the logical "shop" schema shared by every
-- engine (see meta_postgres.sql). Loaded statement by statement (yadbe's own splitter,
-- `DELIMITER` included) into a database created for the run, which the test drops
-- afterwards. Databases are MySQL's namespaces: the tables of the PostgreSQL `sales` and odd
-- schemas live beside the others, like on SQLite.
-- Where MySQL differs (the conformance suite reads it from the dialect's capabilities): no
-- partial index, and no expression index on MariaDB (the MySQL 8 specifics add one).

CREATE TABLE customers (
    id INT NOT NULL AUTO_INCREMENT,
    email VARCHAR(320) NOT NULL COMMENT 'Lower-cased',
    full_name VARCHAR(200) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    CONSTRAINT customers_email_key UNIQUE (email)
) COMMENT 'People who ordered';

CREATE TABLE products (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sku VARCHAR(32) NOT NULL,
    name VARCHAR(200) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    status ENUM('draft', 'active', 'archived') NOT NULL DEFAULT 'draft',
    CONSTRAINT products_sku_key UNIQUE (sku),
    CONSTRAINT products_name_status_key UNIQUE (name, status),
    CONSTRAINT products_price_check CHECK (price >= 0)
);

CREATE TABLE orders (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    subtotal DECIMAL(12,2) NOT NULL,
    shipping DECIMAL(12,2) NOT NULL DEFAULT 0,
    total DECIMAL(12,2) AS (subtotal + shipping) STORED,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id)
        REFERENCES customers (id) ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT orders_subtotal_check CHECK (subtotal >= 0)
);
CREATE INDEX orders_created_at_idx ON orders (created_at DESC);

CREATE TABLE order_items (
    order_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (order_id, product_id),
    CONSTRAINT order_items_order_fk FOREIGN KEY (order_id)
        REFERENCES orders (id) ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT order_items_product_fk FOREIGN KEY (product_id)
        REFERENCES products (id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE `Odd "Table"` (
    `Id` INT NOT NULL PRIMARY KEY,
    `Select` TEXT,
    `col with space` TEXT
);

CREATE TABLE invoices (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    number BIGINT NOT NULL,
    order_id INT NOT NULL,
    issued_at DATE NOT NULL DEFAULT (CURRENT_DATE),
    CONSTRAINT invoices_order_fk FOREIGN KEY (order_id) REFERENCES orders (id)
);

CREATE VIEW customer_orders AS
SELECT o.id AS order_id, c.email, o.total
FROM orders o JOIN customers c ON c.id = o.customer_id;

CREATE FUNCTION order_total(p_order_id INT) RETURNS DECIMAL(13,2)
    READS SQL DATA
    COMMENT 'Total of an order'
    RETURN (SELECT total FROM orders WHERE id = p_order_id);

DELIMITER //
CREATE PROCEDURE archive_invoices(IN p_before DATE, OUT p_archived INT)
BEGIN
    DELETE FROM invoices WHERE issued_at < p_before;
    SET p_archived = ROW_COUNT();
END//

CREATE TRIGGER orders_touch BEFORE UPDATE ON orders
FOR EACH ROW
BEGIN
    SET NEW.created_at = NEW.created_at;
END//
DELIMITER ;
