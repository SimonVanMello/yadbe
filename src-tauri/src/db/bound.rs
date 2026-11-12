//! Builds the statements yadbe authors with bound values (table browsing, edits): the SQL
//! with the dialect's placeholders, the values, and the same statement with the values
//! written as literals for reading (rule 2: values are bound, never written into the SQL
//! that runs).

use crate::db::dialect::Dialect;
use crate::db::driver::BoundStatement;
use crate::db::meta::{ColumnInfo, ObjectRef, qualified_name};
use crate::db::value::Value;

pub struct SqlBuilder<'d> {
    dialect: &'d dyn Dialect,
    sql: String,
    display: String,
    params: Vec<Value>,
}

impl<'d> SqlBuilder<'d> {
    pub fn new(dialect: &'d dyn Dialect) -> Self {
        Self {
            dialect,
            sql: String::new(),
            display: String::new(),
            params: Vec::new(),
        }
    }

    pub fn dialect(&self) -> &'d dyn Dialect {
        self.dialect
    }

    /// SQL text yadbe authored (keywords, operators), the same in both forms.
    pub fn push(&mut self, text: &str) -> &mut Self {
        self.sql.push_str(text);
        self.display.push_str(text);
        self
    }

    /// An identifier, quoted by the dialect.
    pub fn ident(&mut self, name: &str) -> &mut Self {
        let quoted = self.dialect.quote_identifier(name);
        self.push(&quoted)
    }

    /// A table, qualified and quoted.
    pub fn table(&mut self, table: &ObjectRef) -> &mut Self {
        let name = qualified_name(self.dialect, table);
        self.push(&name)
    }

    /// A value, bound as the next parameter; `column`: where it is written or compared,
    /// for the dialect's conversion.
    pub fn value(&mut self, value: &Value, column: Option<&ColumnInfo>) -> &mut Self {
        self.params.push(value.clone());
        let placeholder = self.dialect.placeholder(self.params.len());
        self.sql
            .push_str(&self.dialect.bind_expression(column, &placeholder));
        self.display.push_str(&self.dialect.literal(value));
        self
    }

    /// A value bound as the next parameter inside `template` (`{}` stands for it), without
    /// the dialect's conversion: `CAST($1 AS text)`.
    pub fn value_through(&mut self, value: &Value, template: &str) -> &mut Self {
        self.params.push(value.clone());
        let placeholder = self.dialect.placeholder(self.params.len());
        self.sql.push_str(&template.replace("{}", &placeholder));
        self.display
            .push_str(&template.replace("{}", &self.dialect.literal(value)));
        self
    }

    pub fn finish(self, returns_rows: bool) -> BoundStatement {
        BoundStatement {
            sql: self.sql,
            params: self.params,
            display: self.display,
            returns_rows,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::dialect::Engine;

    #[test]
    fn binds_values_and_shows_them_as_literals() {
        let table = ObjectRef {
            database: "shop".into(),
            schema: Some("sales".into()),
            name: "Order \"Lines\"".into(),
        };
        let mut b = SqlBuilder::new(Engine::Postgres.dialect());
        b.push("DELETE FROM ")
            .table(&table)
            .push(" WHERE ")
            .ident("id")
            .push(" = ")
            .value(&Value::Text("x' OR 1=1 --".into()), None);
        let statement = b.finish(false);
        assert_eq!(
            statement.sql,
            r#"DELETE FROM "sales"."Order ""Lines""" WHERE "id" = $1"#
        );
        assert_eq!(
            statement.display,
            r#"DELETE FROM "sales"."Order ""Lines""" WHERE "id" = 'x'' OR 1=1 --'"#
        );
        assert_eq!(statement.params, [Value::Text("x' OR 1=1 --".into())]);

        let mut b = SqlBuilder::new(Engine::Sqlite.dialect());
        b.value(&Value::int(1), None)
            .push(", ")
            .value(&Value::Null, None);
        let statement = b.finish(true);
        assert_eq!(statement.sql, "?1, ?2");
        assert_eq!(statement.display, "1, NULL");
    }
}
