-- What EF Core's Npgsql provider creates, with a few migrations recorded out of order.
CREATE TABLE {ef}."__EFMigrationsHistory" (
  "MigrationId" character varying(150) NOT NULL,
  "ProductVersion" character varying(32) NOT NULL,
  CONSTRAINT "PK___EFMigrationsHistory" PRIMARY KEY ("MigrationId")
);
INSERT INTO {ef}."__EFMigrationsHistory" VALUES
  ('20240608141755_AddAuditColumns', '8.0.6'),
  ('20230214091200_InitialCreate', '7.0.2'),
  ('00000000000000_Legacy', '3.1.0'),
  ('20230301154501_AddCustomers', '7.0.3');
