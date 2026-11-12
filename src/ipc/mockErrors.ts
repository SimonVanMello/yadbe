import type {
  ConstraintKind,
  ConstraintViolation,
  ErrorAction,
  ErrorCode,
  YadbeError,
} from './bindings';

function error(
  code: ErrorCode,
  en: string,
  fr: string,
  action: ErrorAction | null = null,
  detail: string | null = null,
): YadbeError {
  return { code, message: { en, fr }, action, detail };
}

/** The backend error catalog (`db/errors.rs`), as the mock backend returns it. */
export const mockErrors = {
  invalidArgument: (en: string, fr: string) => error('invalidArgument', en, fr),
  connectionNotFound: (id: string) =>
    error(
      'connectionNotFound',
      'This connection no longer exists.',
      "Cette connexion n'existe plus.",
      null,
      `connection id ${id}`,
    ),
  groupNotFound: (id: string) =>
    error(
      'groupNotFound',
      'This group no longer exists.',
      "Ce groupe n'existe plus.",
      null,
      `group id ${id}`,
    ),
  savedQueryNotFound: (id: string) =>
    error(
      'savedQueryNotFound',
      'This saved query no longer exists.',
      "Cette requête enregistrée n'existe plus.",
      null,
      `saved query id ${id}`,
    ),
  queryFolderNotFound: (id: string) =>
    error(
      'queryFolderNotFound',
      'This folder no longer exists.',
      "Ce dossier n'existe plus.",
      null,
      `folder id ${id}`,
    ),
  engineNotSupported: (label: string) =>
    error(
      'engineNotSupported',
      `${label} is not supported yet by this version of yadbe.`,
      `${label} n'est pas encore pris en charge par cette version de yadbe.`,
    ),
  passwordRequired: () =>
    error(
      'passwordRequired',
      'A password is required for this connection.',
      'Un mot de passe est requis pour cette connexion.',
      'enterPassword',
    ),
  pendingSecretExpired: () =>
    error(
      'pendingSecretExpired',
      'The password taken from the connection string expired. Paste the string again or type the password.',
      'Le mot de passe extrait de la chaîne de connexion a expiré. Collez à nouveau la chaîne ou saisissez le mot de passe.',
      'enterPassword',
    ),
  hostNotFound: (host: string) =>
    error(
      'hostNotFound',
      `The host "${host}" could not be found. Check its name and your network (VPN, DNS).`,
      `L'hôte « ${host} » est introuvable. Vérifiez son nom et votre réseau (VPN, DNS).`,
      'editConnection',
      'failed to lookup address information: Name or service not known',
    ),
  connectionRefused: (host: string, port: number) =>
    error(
      'connectionRefused',
      `${host}:${port} refused the connection. Check that the server is running and listens on this port.`,
      `${host}:${port} a refusé la connexion. Vérifiez que le serveur est démarré et écoute sur ce port.`,
      'editConnection',
      'Connection refused (os error 111)',
    ),
  connectionTimeout: (host: string, seconds: number) =>
    error(
      'connectionTimeout',
      `${host} did not answer within ${seconds} s. A firewall may block the port, or the server is overloaded.`,
      `${host} n'a pas répondu en ${seconds} s. Un pare-feu bloque peut-être le port, ou le serveur est surchargé.`,
      'retry',
    ),
  tlsFailed: () =>
    error(
      'tlsFailed',
      'The secure (TLS) connection failed: the server certificate could not be verified or the handshake was refused.',
      "La connexion sécurisée (TLS) a échoué : le certificat du serveur n'a pas pu être vérifié ou la négociation a été refusée.",
      'changeTlsMode',
      'invalid peer certificate: UnknownIssuer',
    ),
  tlsClientCertRequired: () =>
    error(
      'tlsClientCertRequired',
      "The server requires a TLS client certificate. Add one in the connection's TLS settings.",
      'Le serveur exige un certificat client TLS. Ajoutez-en un dans les paramètres TLS de la connexion.',
      'editConnection',
      'connection requires a valid client certificate (28000)',
    ),
  tlsClientCertInvalid: (detail: string) =>
    error(
      'tlsClientCertInvalid',
      "The TLS client certificate or its private key could not be used. Check the two files in the connection's TLS settings.",
      "Le certificat client TLS ou sa clé privée n'a pas pu être utilisé. Vérifiez les deux fichiers dans les paramètres TLS de la connexion.",
      'editConnection',
      detail,
    ),
  tlsKeyPassphraseRequired: () =>
    error(
      'tlsKeyPassphraseRequired',
      'The TLS client key is protected by a passphrase.',
      'La clé client TLS est protégée par une phrase de passe.',
      'enterPassword',
    ),
  tlsKeyPassphraseWrong: () =>
    error(
      'tlsKeyPassphraseWrong',
      'The passphrase of the TLS client key is wrong.',
      'La phrase de passe de la clé client TLS est incorrecte.',
      'enterPassword',
    ),
  authFailed: (user: string) =>
    error(
      'authFailed',
      `The server rejected the user "${user}" or its password.`,
      `Le serveur a refusé l'utilisateur « ${user} » ou son mot de passe.`,
      'enterPassword',
      `password authentication failed for user "${user}"`,
    ),
  unknownDatabase: (database: string) =>
    error(
      'unknownDatabase',
      `The database "${database}" does not exist on this server.`,
      `La base « ${database} » n'existe pas sur ce serveur.`,
      'editConnection',
    ),
  fileNotFound: (path: string) =>
    error(
      'fileNotFound',
      `The file "${path}" does not exist.`,
      `Le fichier « ${path} » n'existe pas.`,
      'chooseFile',
    ),
  connectionLost: () =>
    error(
      'connectionLost',
      'The connection to the server was lost. The statement was not run again.',
      "La connexion au serveur a été perdue. L'instruction n'a pas été relancée.",
      'reconnect',
      'terminating connection due to administrator command',
    ),
  invalidConnectionString: () =>
    error(
      'invalidConnectionString',
      'This connection string is not a URL, an ADO.NET string or a JDBC URL.',
      "Cette chaîne de connexion n'est ni une URL, ni une chaîne ADO.NET, ni une URL JDBC.",
    ),
  cancelled: () => error('cancelled', 'Cancelled.', 'Annulé.'),
  scriptError: (exception: string) =>
    error(
      'scriptError',
      'The script threw an exception.',
      'Le script a levé une exception.',
      null,
      exception,
    ),
  mongoshUnsupported: (method: string) =>
    error(
      'notSupported',
      `${method} is not available in yadbe. Use db.runCommand() or db.adminCommand() instead.`,
      `${method} n'est pas disponible dans yadbe. Utilisez db.runCommand() ou db.adminCommand() à la place.`,
    ),
  dangerDeclined: (command: string) =>
    error(
      'cancelled',
      `${command} was not run: it was not confirmed. The script stopped there.`,
      `${command} n'a pas été exécuté : il n'a pas été confirmé. Le script s'est arrêté là.`,
    ),
  statementTimeout: (secs: number) =>
    error(
      'statementTimeout',
      `The statement ran longer than the ${String(secs)} s limit of this connection and was cancelled.`,
      `L'instruction a dépassé la limite de ${String(secs)} s de cette connexion et a été annulée.`,
      'editConnection',
    ),
  notConnected: () =>
    error(
      'notConnected',
      'The connection is not open.',
      "La connexion n'est pas ouverte.",
      'reconnect',
    ),
  queryFailed: (detail: string) =>
    error(
      'queryFailed',
      'The database rejected the statement.',
      "La base de données a refusé l'instruction.",
      null,
      detail,
    ),
  executionRunning: () =>
    error(
      'executionRunning',
      'A query is already running in this tab. Wait for it or cancel it.',
      'Une requête est déjà en cours dans cet onglet. Attendez-la ou annulez-la.',
    ),
  transactionOpen: () =>
    error(
      'transactionOpen',
      'A transaction is open in this tab. Commit or roll it back first.',
      "Une transaction est ouverte dans cet onglet. Validez-la ou annulez-la d'abord.",
    ),
  readOnlyViolation: (statement: string) =>
    statement
      ? error(
          'readOnlyViolation',
          `This connection is read-only: ${statement} may change data or the schema. Nothing was run.`,
          `Cette connexion est en lecture seule : ${statement} peut modifier des données ou le schéma. Rien n'a été exécuté.`,
          'editConnection',
        )
      : error(
          'readOnlyViolation',
          'This connection is read-only and yadbe cannot prove this statement only reads. Nothing was run.',
          "Cette connexion est en lecture seule et yadbe ne peut pas garantir que cette instruction ne fait que lire. Rien n'a été exécuté.",
          'editConnection',
        ),
  resultNotFound: (resultId: number) =>
    error(
      'resultNotFound',
      'This result is no longer available. Run the query again.',
      "Ce résultat n'est plus disponible. Relancez la requête.",
      null,
      `result id ${resultId}`,
    ),
  tableNotEditable: (en: string, fr: string) => error('tableNotEditable', en, fr),
  rowNotFound: (row: string) =>
    error(
      'rowNotFound',
      `The row ${row} was changed or deleted by someone else since it was read. Nothing was applied: refresh the rows and try again.`,
      `La ligne ${row} a été modifiée ou supprimée par quelqu'un d'autre depuis sa lecture. Rien n'a été appliqué : actualisez les lignes et réessayez.`,
      'retry',
    ),
  rowNotUnique: (row: string, count: number) =>
    error(
      'rowNotUnique',
      `The change of the row ${row} would affect ${count} rows: its identity is not unique. Nothing was applied.`,
      `La modification de la ligne ${row} toucherait ${count} lignes : son identité n'est pas unique. Rien n'a été appliqué.`,
    ),
  constraintViolation: (violation: ConstraintViolation) => {
    const kinds: Record<ConstraintKind, [string, string]> = {
      unique: ['unique constraint', "la contrainte d'unicité"],
      foreignKey: ['foreign key', 'la clé étrangère'],
      check: ['check constraint', 'la contrainte de vérification'],
      notNull: ['NOT NULL constraint', 'la contrainte NOT NULL'],
      exclusion: ['exclusion constraint', "la contrainte d'exclusion"],
    };
    const [en, fr] = kinds[violation.kind];
    const name = violation.name ? ` "${violation.name}"` : '';
    const nameFr = violation.name ? ` « ${violation.name} »` : '';
    const column = violation.column ? ` (column "${violation.column}")` : '';
    const columnFr = violation.column ? ` (colonne « ${violation.column} »)` : '';
    return error(
      'constraintViolation',
      `The change breaks the ${en}${name}${column}.`,
      `La modification enfreint ${fr}${nameFr}${columnFr}.`,
    );
  },
  importFileInvalid: (line: number, problem: string) =>
    error(
      'importFileInvalid',
      `The file cannot be read as the chosen format (line ${line}). Check the format options.`,
      `Le fichier ne peut pas être lu dans le format choisi (ligne ${line}). Vérifiez les options de format.`,
      'chooseFile',
      problem,
    ),
  importRejected: (line: number, problem: string) =>
    error(
      'importRejected',
      `The import stopped at line ${line}: a row was rejected. Nothing was kept unless the import commits batch by batch.`,
      `L'import s'est arrêté à la ligne ${line} : une ligne a été rejetée. Rien n'a été conservé, sauf si l'import valide lot par lot.`,
      null,
      problem,
    ),
  connectionFileInvalid: (en: string, fr: string) =>
    error('connectionFileInvalid', en, fr, 'chooseFile'),
  objectNotFound: (name: string) =>
    error(
      'objectNotFound',
      `"${name}" no longer exists. Refresh the explorer to see the current objects.`,
      `« ${name} » n'existe plus. Actualisez l'explorateur pour voir les objets actuels.`,
    ),
  invalidValue: (detail: string) =>
    error(
      'invalidValue',
      'The database could not store a value in its column (format, range or length).',
      "La base de données n'a pas pu enregistrer une valeur dans sa colonne (format, plage ou longueur).",
      null,
      detail,
    ),
};
