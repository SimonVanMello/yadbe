-- Runs once, when the container initializes its data directory. The integration tests
-- create uniquely named databases (`yadbe_t_…`) next to `yadbe_test` and drop them after.
GRANT ALL PRIVILEGES ON `yadbe\_%`.* TO 'yadbe'@'%';
-- KILL QUERY on the test user's own connections needs nothing more; reading every
-- session's processlist entry (cancel tests on other users) is not needed.
