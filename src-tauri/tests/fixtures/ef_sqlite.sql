-- What Microsoft.EntityFrameworkCore.Sqlite creates, with a few migrations recorded out of order.
CREATE TABLE "__EFMigrationsHistory" (
  "MigrationId" TEXT NOT NULL CONSTRAINT "PK___EFMigrationsHistory" PRIMARY KEY,
  "ProductVersion" TEXT NOT NULL
);
INSERT INTO "__EFMigrationsHistory" VALUES
  ('20240608141755_AddAuditColumns', '8.0.6'),
  ('20230214091200_InitialCreate', '7.0.2'),
  ('00000000000000_Legacy', '3.1.0'),
  ('20230301154501_AddCustomers', '7.0.3');
