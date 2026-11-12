-- Runs once, when the container initializes its data directory. The integration tests
-- create uniquely named databases (`yadbe_t_…`) next to `yadbe_test` and drop them after.
GRANT ALL PRIVILEGES ON `yadbe\_%`.* TO 'yadbe'@'%';
-- KILL QUERY on the test user's own connections needs nothing more. The activity monitor
-- tests (M3-11) also read every thread and the lock tables of performance_schema: without
-- these two grants they still run, and skip what the monitor reports as unavailable.
GRANT PROCESS ON *.* TO 'yadbe'@'%';
GRANT SELECT ON performance_schema.* TO 'yadbe'@'%';
