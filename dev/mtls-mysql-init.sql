-- A user that must present a client certificate signed by the server's `ssl-ca`.
CREATE USER 'yadbe_x509'@'%' IDENTIFIED BY 'yadbe-x509-pw' REQUIRE X509;
GRANT ALL PRIVILEGES ON `yadbe\_%`.* TO 'yadbe_x509'@'%';
GRANT SELECT ON yadbe_test.* TO 'yadbe_x509'@'%';
