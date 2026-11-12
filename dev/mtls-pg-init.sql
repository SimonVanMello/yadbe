-- The user the client certificate (CN=yadbe_client) logs in as, with no password.
CREATE ROLE yadbe_client LOGIN;
GRANT ALL ON DATABASE yadbe_test TO yadbe_client;
