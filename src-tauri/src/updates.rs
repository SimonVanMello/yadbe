//! Update check and install (SPEC §10, F-127), ported from yaggui. Opt-in: the frontend only
//! checks when the user turned the check on, or asked for it; nothing here runs on its own.
//!
//! The check reads `latest.json`, the update manifest attached to the newest published GitHub
//! release (written by `scripts/updater-manifest.mjs`). How the update is installed depends on
//! how the app was:
//!
//! - the Tauri updater replaces what a release installer put on disk (Windows installers, the
//!   macOS app, the AppImage), and the Homebrew cask, which declares `auto_updates`; it checks
//!   the minisign signature of the bundle against the public key of `tauri.conf.json` first;
//! - a copy owned by a Linux package manager (the AUR, a `.deb` or `.rpm`) is upgraded by that
//!   package manager, or it would no longer know which version is installed. yadbe has no
//!   terminal of its own (yaggui runs the command in one): it downloads the package, checks it
//!   against the release's `SHA256SUMS.txt`, and gives the user the command to run.
//!
//! A build without the updater public key (a build from source, a pull request build) is not
//! "configured": it never checks and never installs, so a copy that could not verify an update
//! never offers one.

use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;

use crate::db::errors::YadbeError;

/// Manifest of the newest published release. Drafts and pre-releases are never `latest`.
pub const MANIFEST_URL: &str =
    "https://github.com/SimonVanMello/yadbe/releases/latest/download/latest.json";
/// Page of the newest published release, for the installs that are upgraded by hand.
pub const RELEASE_PAGE_URL: &str = "https://github.com/SimonVanMello/yadbe/releases/latest";
/// Assets of a given release: `{RELEASE_DOWNLOAD_URL}/v{version}/{asset}`.
const RELEASE_DOWNLOAD_URL: &str = "https://github.com/SimonVanMello/yadbe/releases/download";
const CHECKSUMS_ASSET: &str = "SHA256SUMS.txt";

/// The manifest is a few KB; anything bigger is not what we asked for.
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
/// The `.deb` and `.rpm` weigh about 20 MB.
const MAX_PACKAGE_BYTES: u64 = 300 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
/// Folder of the app cache where packages are downloaded, emptied before each download.
const DOWNLOAD_FOLDER: &str = "update";

/// pacman's database of installed packages: one `<name>-<version>` folder each.
const PACMAN_LOCAL: &str = "/var/lib/pacman/local";
const AUR_PACKAGE: &str = "yadbe-bin";
/// AUR helpers, by preference: pacman itself cannot build an AUR package.
const AUR_HELPERS: [&str; 2] = ["yay", "paru"];
/// Where system programs live when the app was started with a short `PATH`.
const SYSTEM_BIN: [&str; 3] = ["/usr/local/bin", "/usr/bin", "/bin"];

/// How the running copy was installed, which decides how it is updated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum InstallChannel {
    /// Replaced by the Tauri updater: Windows installer, macOS app (from the `.dmg` or the
    /// Homebrew cask), AppImage.
    SelfUpdate,
    /// The `yadbe-bin` AUR package, upgraded with the user's AUR helper.
    Aur,
    /// The `.deb`: the new one is downloaded and checked, then installed with apt by the user.
    Deb,
    /// The `.rpm`: the new one is downloaded and checked, then installed with dnf or zypper.
    Rpm,
    /// A development build or an unknown layout: the user downloads the new version from the
    /// release page.
    Manual,
}

/// What the app knows about its updates without asking the network.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// The build carries the updater public key: it may check for updates and install them.
    pub configured: bool,
    pub channel: InstallChannel,
    pub current_version: String,
}

/// A newer published version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub version: String,
    /// Release notes of the manifest: the release page address, or Markdown.
    pub notes: Option<String>,
    /// Publication date (RFC 3339), if any.
    pub date: Option<String>,
    pub channel: InstallChannel,
}

/// The upgrade of a package-manager copy, ready for the user to run in a terminal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PackageUpgrade {
    /// Shell command line, shown and copied, never run by yadbe.
    pub command: String,
    /// The downloaded and checked package (`.deb` / `.rpm`); `None` for the AUR.
    pub package: Option<String>,
}

/// What the channel detection looks at, gathered apart so that the decision can be tested.
#[derive(Debug, Clone, Default)]
struct Facts {
    bundle: Option<BundleType>,
    /// Built without optimizations (`tauri dev`): never replaced in place.
    debug: bool,
    /// The executable lives inside a `.app` bundle (not a bare binary from `cargo build`).
    in_app_bundle: bool,
    aur_package: bool,
}

fn classify(facts: Facts) -> InstallChannel {
    if facts.debug {
        return InstallChannel::Manual;
    }
    match facts.bundle {
        Some(BundleType::Msi | BundleType::Nsis | BundleType::AppImage) => {
            InstallChannel::SelfUpdate
        }
        // `bundle_type` answers `App` for any macOS binary: only a real bundle is replaced.
        Some(BundleType::App | BundleType::Dmg) if facts.in_app_bundle => {
            InstallChannel::SelfUpdate
        }
        // The AUR package repackages the `.deb`.
        Some(BundleType::Deb) if facts.aur_package => InstallChannel::Aur,
        Some(BundleType::Deb) => InstallChannel::Deb,
        Some(BundleType::Rpm) => InstallChannel::Rpm,
        _ => InstallChannel::Manual,
    }
}

/// How the running copy was installed.
pub fn install_channel() -> InstallChannel {
    let mut facts = Facts {
        bundle: bundle_type(),
        debug: cfg!(debug_assertions),
        ..Facts::default()
    };
    match facts.bundle {
        Some(BundleType::App | BundleType::Dmg) => {
            facts.in_app_bundle = std::env::current_exe()
                .is_ok_and(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"));
        }
        Some(BundleType::Deb) => facts.aur_package = has_pacman_package(AUR_PACKAGE),
        _ => {}
    }
    classify(facts)
}

fn has_pacman_package(name: &str) -> bool {
    let prefix = format!("{name}-");
    std::fs::read_dir(PACMAN_LOCAL).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
    })
}

/// Whether the `plugins.updater` section of the app configuration holds a public key. The
/// repository ships it empty (the owner pastes the key of their release key pair, see
/// `docs/RELEASING.md`): such a build cannot verify an update, so it offers none.
fn has_public_key(updater: Option<&serde_json::Value>) -> bool {
    updater
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|key| !key.trim().is_empty())
}

fn configured(app: &tauri::AppHandle) -> bool {
    has_public_key(app.config().plugins.0.get("updater"))
}

/// What the frontend needs to show the update settings, without any network call.
pub fn status(app: &tauri::AppHandle) -> UpdateStatus {
    UpdateStatus {
        configured: configured(app),
        channel: install_channel(),
        current_version: env!("CARGO_PKG_VERSION").to_owned(),
    }
}

fn ensure_configured(app: &tauri::AppHandle) -> Result<(), YadbeError> {
    if configured(app) {
        Ok(())
    } else {
        Err(YadbeError::updates_not_configured())
    }
}

/// The fields of the Tauri update manifest the check needs.
#[derive(Debug, Deserialize)]
struct Manifest {
    version: String,
    notes: Option<String>,
    pub_date: Option<String>,
}

fn parse_version(text: &str) -> Option<semver::Version> {
    semver::Version::parse(text.trim().trim_start_matches('v')).ok()
}

/// The update described by `manifest`, `None` when it is not newer than `current`.
fn newer_release(
    manifest: &str,
    current: &str,
    channel: InstallChannel,
) -> Result<Option<UpdateInfo>, YadbeError> {
    let manifest: Manifest = serde_json::from_str(manifest)
        .map_err(|err| YadbeError::update_check_failed(format!("invalid manifest: {err}")))?;
    let latest = parse_version(&manifest.version).ok_or_else(|| {
        YadbeError::update_check_failed(format!("invalid version: {}", manifest.version))
    })?;
    let installed = parse_version(current)
        .ok_or_else(|| YadbeError::internal(format!("invalid app version: {current}")))?;
    if latest <= installed {
        return Ok(None);
    }
    Ok(Some(UpdateInfo {
        current_version: installed.to_string(),
        version: latest.to_string(),
        notes: manifest.notes.filter(|notes| !notes.trim().is_empty()),
        date: manifest.pub_date,
        channel,
    }))
}

/// HTTPS only, with yadbe's name and version as the user agent and nothing else about the user.
fn client(timeout: Duration) -> Result<reqwest::Client, YadbeError> {
    // The TLS stack is built without a default crypto provider: ring, like the drivers.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .user_agent(concat!("yadbe/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|err| YadbeError::internal(format!("HTTP client: {err}")))
}

/// The body of `response`, refused beyond `limit` bytes.
async fn read_limited(mut response: reqwest::Response, limit: u64) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err(format!("answer larger than {limit} bytes"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|err| err.to_string())? {
        if (body.len() + chunk.len()) as u64 > limit {
            return Err(format!("answer larger than {limit} bytes"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Reads the manifest of the newest release. `None` when the installed version is the newest,
/// or when that release has no manifest (published before the updater existed). Refused,
/// without any request, by a build that is not configured.
pub async fn check(app: &tauri::AppHandle) -> Result<Option<UpdateInfo>, YadbeError> {
    ensure_configured(app)?;
    let failed = YadbeError::update_check_failed;
    let response = client(CHECK_TIMEOUT)?
        .get(MANIFEST_URL)
        .send()
        .await
        .map_err(|err| failed(err.to_string()))?;
    match response.status().as_u16() {
        200 => {}
        404 => return Ok(None),
        status => return Err(failed(format!("HTTP {status}"))),
    }
    let body = read_limited(response, MAX_MANIFEST_BYTES)
        .await
        .map_err(failed)?;
    let body =
        String::from_utf8(body).map_err(|_| failed(String::from("the manifest is not UTF-8")))?;
    newer_release(&body, env!("CARGO_PKG_VERSION"), install_channel())
}

/// Reports a download at most once per percent.
struct Progress<F: FnMut(Option<u8>)> {
    report: F,
    downloaded: u64,
    last: Option<Option<u8>>,
}

impl<F: FnMut(Option<u8>)> Progress<F> {
    fn new(report: F) -> Self {
        Self {
            report,
            downloaded: 0,
            last: None,
        }
    }

    fn advance(&mut self, chunk: u64, total: Option<u64>) {
        self.downloaded = self.downloaded.saturating_add(chunk);
        let percent = total
            .filter(|total| *total > 0)
            .map(|total| u8::try_from(self.downloaded.min(total) * 100 / total).unwrap_or(100));
        if self.last != Some(percent) {
            self.last = Some(percent);
            (self.report)(percent);
        }
    }
}

/// Downloads, verifies and installs the newest release with the Tauri updater, then restarts
/// the app (see [`restart`]). Only for the [`InstallChannel::SelfUpdate`] installs of a
/// configured build. The updater checks the bundle's minisign signature against the public key
/// of the configuration, and that the signature was made for the announced version
/// (`requireSignedVersion`), before it installs anything.
pub async fn install(
    app: &tauri::AppHandle,
    mut on_progress: impl FnMut(Option<u8>) + Send,
) -> Result<(), YadbeError> {
    use tauri_plugin_updater::UpdaterExt;

    ensure_configured(app)?;
    if install_channel() != InstallChannel::SelfUpdate {
        return Err(YadbeError::update_install_failed(
            "this copy is not replaced by the updater",
        ));
    }
    let failed =
        |err: tauri_plugin_updater::Error| YadbeError::update_install_failed(err.to_string());
    let url = MANIFEST_URL
        .parse()
        .map_err(|err| YadbeError::internal(format!("manifest URL: {err}")))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(failed)?
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(failed)?;
    let Some(update) = updater.check().await.map_err(failed)? else {
        return Err(YadbeError::update_install_failed(
            "no newer version in the manifest",
        ));
    };
    tracing::info!(version = %update.version, "installing update");
    let mut progress = Progress::new(&mut on_progress);
    update
        .download_and_install(|chunk, total| progress.advance(chunk as u64, total), || {})
        .await
        .map_err(failed)?;
    tracing::info!("update installed, restarting");
    restart(app);
    Ok(())
}

/// Restarts the app on the version just installed. Only returns on macOS, where the app then
/// exits on its own.
pub fn restart(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(bundle) = std::env::current_exe().ok().as_deref().and_then(app_bundle) {
        match relaunch_when_gone(&bundle) {
            Ok(()) => return app.exit(0),
            Err(err) => tracing::warn!(error = %err, "failed to schedule the relaunch"),
        }
    }
    app.restart()
}

/// The `.app` bundle an executable lives in (`<bundle>.app/Contents/MacOS/<exe>`).
#[cfg(any(target_os = "macos", test))]
fn app_bundle(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let named = |path: &Path, name: &str| path.file_name().is_some_and(|n| n == name);
    let is_app = bundle.extension().is_some_and(|ext| ext == "app");
    (named(macos, "MacOS") && named(contents, "Contents") && is_app).then(|| bundle.to_path_buf())
}

/// Waits for this process to exit (30 s at most), then opens `$2` through LaunchServices.
#[cfg(target_os = "macos")]
const RELAUNCH_SCRIPT: &str = r#"i=0
while kill -0 "$1" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done
exec /usr/bin/open "$2""#;

/// Tauri's restart runs `open -n` while this process is still alive: the Dock sees a second
/// instance and gives it its own tile instead of the pinned one, which stays empty. Opening the
/// bundle once this process is gone makes the new one the only instance, on the pinned tile.
/// The bundle path and the pid are arguments of the script, never part of it.
#[cfg(target_os = "macos")]
fn relaunch_when_gone(bundle: &Path) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;

    Command::new("/bin/sh")
        .arg("-c")
        .arg(RELAUNCH_SCRIPT)
        .arg("yadbe-relaunch")
        .arg(std::process::id().to_string())
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Out of our process group, so nothing sent to it on exit reaches the script.
        .process_group(0)
        .spawn()
        .map(drop)
}

/// One shell word: kept as is when it only holds safe characters, single-quoted otherwise.
fn shell_word(word: &str) -> String {
    let safe = |c: char| c.is_ascii_alphanumeric() || "/._-+=:@%,".contains(c);
    if !word.is_empty() && word.chars().all(safe) {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', r#"'\''"#))
    }
}

/// The package manager command that upgrades a copy of `channel`, for the user's terminal.
/// `package` is the downloaded `.deb` / `.rpm` (an absolute path); `find` looks a program up by
/// name, to pick the tools this system has.
fn upgrade_command(
    channel: InstallChannel,
    package: Option<&Path>,
    find: impl Fn(&str) -> Option<PathBuf>,
) -> Result<String, YadbeError> {
    let missing = |what: &str| YadbeError::update_install_failed(format!("{what} not found"));
    if channel == InstallChannel::Aur {
        return Ok(match AUR_HELPERS.iter().find(|name| find(name).is_some()) {
            Some(helper) => format!("{helper} -S {AUR_PACKAGE}"),
            // The AUR's own way, without a helper.
            None => format!(
                "git clone https://aur.archlinux.org/{AUR_PACKAGE}.git && cd {AUR_PACKAGE} && makepkg -si"
            ),
        });
    }
    let manager = match channel {
        InstallChannel::Deb => {
            find("apt").ok_or_else(|| missing("apt"))?;
            "apt install"
        }
        InstallChannel::Rpm => match (find("dnf"), find("zypper")) {
            (Some(_), _) => "dnf install",
            // Release packages are not signed with a key zypper knows.
            (None, Some(_)) => "zypper install --allow-unsigned-rpm",
            (None, None) => return Err(missing("dnf or zypper")),
        },
        _ => {
            return Err(YadbeError::update_install_failed(
                "this copy is not upgraded by a package manager",
            ));
        }
    };
    // An absolute path: a package manager never reads it as an option or a package name.
    let package = package
        .filter(|package| package.is_absolute())
        .ok_or_else(|| YadbeError::internal("no downloaded package to install"))?;
    Ok(format!(
        "sudo {manager} {}",
        shell_word(&package.to_string_lossy())
    ))
}

/// File name of the release package of `channel`, `None` when none is published for `arch`.
fn package_asset(channel: InstallChannel, version: &semver::Version, arch: &str) -> Option<String> {
    match (channel, arch) {
        (InstallChannel::Deb, "x86_64") => Some(format!("yadbe_{version}_amd64.deb")),
        (InstallChannel::Rpm, "x86_64") => Some(format!("yadbe-{version}-1.x86_64.rpm")),
        _ => None,
    }
}

/// The SHA-256 of `asset` in a `sha256sum` listing, lowercase.
fn expected_checksum(sums: &str, asset: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, name) = line.split_once(char::is_whitespace)?;
        // `sha256sum` marks a file read in binary mode with `*`.
        let name = name.trim_start().trim_start_matches('*');
        (name == asset && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
    })
}

/// First `name` on the `PATH`, then in the system folders.
fn find_program(name: &str) -> Option<PathBuf> {
    let search = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&search)
        .chain(SYSTEM_BIN.iter().map(PathBuf::from))
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

async fn fetch(client: &reqwest::Client, url: &str) -> Result<reqwest::Response, YadbeError> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|err| YadbeError::update_install_failed(format!("{url}: {err}")))?;
    match response.status().as_u16() {
        200 => Ok(response),
        status => Err(YadbeError::update_install_failed(format!(
            "{url}: HTTP {status}"
        ))),
    }
}

/// Downloads the release package of `channel` into `folder` (emptied first) and checks it
/// against the release's checksums. A package that does not match is deleted.
async fn download_package(
    channel: InstallChannel,
    version: &str,
    folder: &Path,
    on_progress: impl FnMut(Option<u8>) + Send,
) -> Result<PathBuf, YadbeError> {
    let failed = YadbeError::update_install_failed;
    let version =
        parse_version(version).ok_or_else(|| failed(format!("invalid version: {version}")))?;
    let arch = std::env::consts::ARCH;
    let asset = package_asset(channel, &version, arch)
        .ok_or_else(|| failed(format!("no release package for {arch}")))?;
    let base = format!("{RELEASE_DOWNLOAD_URL}/v{version}");
    let client = client(DOWNLOAD_TIMEOUT)?;

    let sums = read_limited(
        fetch(&client, &format!("{base}/{CHECKSUMS_ASSET}")).await?,
        MAX_MANIFEST_BYTES,
    )
    .await
    .map_err(|err| failed(format!("{CHECKSUMS_ASSET}: {err}")))?;
    let sums = String::from_utf8_lossy(&sums);
    let expected = expected_checksum(&sums, &asset)
        .ok_or_else(|| failed(format!("{asset} is not in {CHECKSUMS_ASSET}")))?;

    let mut response = fetch(&client, &format!("{base}/{asset}")).await?;
    let total = response.content_length();
    if total.is_some_and(|total| total > MAX_PACKAGE_BYTES) {
        return Err(failed(format!(
            "{asset}: larger than {MAX_PACKAGE_BYTES} bytes"
        )));
    }
    let mut bytes = Vec::new();
    let mut hasher = Sha256::new();
    let mut progress = Progress::new(on_progress);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| failed(format!("{asset}: {err}")))?
    {
        if (bytes.len() + chunk.len()) as u64 > MAX_PACKAGE_BYTES {
            return Err(failed(format!(
                "{asset}: larger than {MAX_PACKAGE_BYTES} bytes"
            )));
        }
        hasher.update(&chunk);
        bytes.extend_from_slice(&chunk);
        progress.advance(chunk.len() as u64, total);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        return Err(failed(format!(
            "{asset}: checksum mismatch (expected {expected}, got {actual})"
        )));
    }
    let folder = folder.to_path_buf();
    let path = folder.join(&asset);
    let written = path.clone();
    tauri::async_runtime::spawn_blocking(move || write_package(&folder, &written, &bytes))
        .await
        .map_err(|err| YadbeError::internal(format!("background task failed: {err}")))??;
    tracing::info!(path = %path.display(), "update package downloaded");
    Ok(path)
}

/// Empties `folder` (an earlier download), then writes the checked package in it.
fn write_package(folder: &Path, path: &Path, bytes: &[u8]) -> Result<(), YadbeError> {
    let io = |err: std::io::Error| {
        YadbeError::update_install_failed(format!("{}: {err}", folder.display()))
    };
    if folder.exists() {
        std::fs::remove_dir_all(folder).map_err(io)?;
    }
    std::fs::create_dir_all(folder).map_err(io)?;
    std::fs::write(path, bytes).map_err(io)
}

/// Gets the upgrade of a package-manager copy ready: downloads and checks the new `.deb` /
/// `.rpm` into `cache_dir`, then returns the command that installs it, for the user to run in
/// a terminal. Download progress goes to `on_progress`.
pub async fn prepare_package_upgrade(
    app: &tauri::AppHandle,
    cache_dir: &Path,
    on_progress: impl FnMut(Option<u8>) + Send,
) -> Result<PackageUpgrade, YadbeError> {
    ensure_configured(app)?;
    let channel = install_channel();
    let package = match channel {
        InstallChannel::Aur => None,
        InstallChannel::Deb | InstallChannel::Rpm => {
            let update = check(app)
                .await
                .map_err(|err| {
                    YadbeError::update_install_failed(
                        err.detail.unwrap_or_else(|| "update check failed".into()),
                    )
                })?
                .ok_or_else(|| {
                    YadbeError::update_install_failed("no newer version in the manifest")
                })?;
            Some(
                download_package(
                    channel,
                    &update.version,
                    &cache_dir.join(DOWNLOAD_FOLDER),
                    on_progress,
                )
                .await?,
            )
        }
        _ => {
            return Err(YadbeError::update_install_failed(
                "this copy is not upgraded by a package manager",
            ));
        }
    };
    let command = upgrade_command(channel, package.as_deref(), find_program)?;
    tracing::info!(%command, "upgrade ready");
    Ok(PackageUpgrade {
        command,
        package: package.map(|path| path.to_string_lossy().into_owned()),
    })
}

/// The program that opens a web page in the default browser on `os`, with its arguments. Only
/// for the `https://` addresses written in this file: the generic opener runs whatever it is
/// given.
fn browser_command(os: &str, url: &str) -> (&'static str, Vec<String>) {
    match os {
        "macos" => ("open", vec![url.to_owned()]),
        "windows" => ("explorer.exe", vec![url.to_owned()]),
        _ => ("xdg-open", vec![url.to_owned()]),
    }
}

/// Opens the release page in the default browser, without waiting for it.
pub fn open_release_page() -> Result<(), YadbeError> {
    let (program, args) = browser_command(std::env::consts::OS, RELEASE_PAGE_URL);
    let mut child = std::process::Command::new(program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| YadbeError::internal(format!("{program}: {err}")))?;
    // Reaped in the background: the opener returns at once, the browser outlives it.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::errors::ErrorCode;

    fn facts(bundle: BundleType) -> Facts {
        Facts {
            bundle: Some(bundle),
            ..Facts::default()
        }
    }

    #[test]
    fn a_build_without_the_public_key_is_not_configured() {
        assert!(!has_public_key(None));
        for config in [
            serde_json::json!({}),
            serde_json::json!({ "pubkey": "" }),
            serde_json::json!({ "pubkey": "  \n" }),
            serde_json::json!({ "pubkey": null }),
        ] {
            assert!(!has_public_key(Some(&config)), "{config}");
        }
        let config = serde_json::json!({ "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu" });
        assert!(has_public_key(Some(&config)));
    }

    #[test]
    fn the_updater_section_is_complete() {
        // The plugin refuses to start without `pubkey`: the repository ships it empty and the
        // owner pastes the key of their release key pair there (docs/RELEASING.md). Only the
        // release workflow creates the signed bundles (`createUpdaterArtifacts`).
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        assert!(
            updater.is_object(),
            "plugins.updater must exist: the plugin needs it"
        );
        assert!(updater["pubkey"].is_string());
        assert_eq!(updater["requireSignedVersion"], serde_json::json!(true));
        assert!(config["bundle"]["createUpdaterArtifacts"].is_null());
    }

    #[test]
    fn not_configured_is_a_typed_error_without_a_retry() {
        let err = YadbeError::updates_not_configured();
        assert_eq!(err.code, ErrorCode::UpdatesNotConfigured);
        assert_eq!(err.action, None);
    }

    #[test]
    fn app_bundle_is_found_from_its_executable() {
        assert_eq!(
            app_bundle(Path::new("/Applications/yadbe.app/Contents/MacOS/yadbe")),
            Some(PathBuf::from("/Applications/yadbe.app"))
        );
        assert_eq!(app_bundle(Path::new("/usr/local/bin/yadbe")), None);
        assert_eq!(
            app_bundle(Path::new("/tmp/yadbe/Contents/MacOS/yadbe")),
            None
        );
        assert_eq!(app_bundle(Path::new("yadbe")), None);
    }

    #[test]
    fn release_installers_update_themselves() {
        for bundle in [BundleType::Msi, BundleType::Nsis, BundleType::AppImage] {
            assert_eq!(classify(facts(bundle)), InstallChannel::SelfUpdate);
        }
        let app = Facts {
            in_app_bundle: true,
            ..facts(BundleType::App)
        };
        assert_eq!(classify(app), InstallChannel::SelfUpdate);
    }

    #[test]
    fn the_homebrew_cask_updates_itself() {
        // The cask declares `auto_updates`: Homebrew leaves the upgrade to the app.
        let cask = Facts {
            in_app_bundle: true,
            ..facts(BundleType::Dmg)
        };
        assert_eq!(classify(cask), InstallChannel::SelfUpdate);
    }

    #[test]
    fn linux_packages_are_upgraded_by_their_package_manager() {
        let aur = Facts {
            aur_package: true,
            ..facts(BundleType::Deb)
        };
        assert_eq!(classify(aur), InstallChannel::Aur);
        assert_eq!(classify(facts(BundleType::Deb)), InstallChannel::Deb);
        assert_eq!(classify(facts(BundleType::Rpm)), InstallChannel::Rpm);
    }

    #[test]
    fn development_and_bare_builds_are_never_replaced() {
        let dev = Facts {
            debug: true,
            ..facts(BundleType::Nsis)
        };
        assert_eq!(classify(dev), InstallChannel::Manual);
        // `cargo build` on macOS: `bundle_type` says `App`, but there is no bundle.
        assert_eq!(classify(facts(BundleType::App)), InstallChannel::Manual);
        assert_eq!(classify(Facts::default()), InstallChannel::Manual);
    }

    const MANIFEST: &str = r#"{
        "version": "0.2.0",
        "notes": "https://github.com/SimonVanMello/yadbe/releases/tag/v0.2.0",
        "pub_date": "2026-11-20T10:00:00Z",
        "platforms": {}
    }"#;

    #[test]
    fn a_newer_manifest_is_an_update() {
        let update = newer_release(MANIFEST, "0.1.0", InstallChannel::Deb)
            .unwrap()
            .unwrap();
        assert_eq!(
            update,
            UpdateInfo {
                current_version: "0.1.0".into(),
                version: "0.2.0".into(),
                notes: Some("https://github.com/SimonVanMello/yadbe/releases/tag/v0.2.0".into()),
                date: Some("2026-11-20T10:00:00Z".into()),
                channel: InstallChannel::Deb,
            }
        );
    }

    #[test]
    fn the_same_or_an_older_version_is_not_an_update() {
        for current in ["0.2.0", "0.10.0", "1.0.0"] {
            assert_eq!(
                newer_release(MANIFEST, current, InstallChannel::Manual).unwrap(),
                None,
                "{current}"
            );
        }
    }

    #[test]
    fn versions_compare_as_semver_and_accept_a_v_prefix() {
        let manifest = r#"{ "version": "v0.10.0", "notes": "  " }"#;
        let update = newer_release(manifest, "0.9.3", InstallChannel::Manual)
            .unwrap()
            .unwrap();
        assert_eq!(update.version, "0.10.0");
        assert_eq!(update.notes, None);
    }

    #[test]
    fn a_broken_manifest_is_a_typed_error() {
        for manifest in ["<html>", r#"{ "version": "latest" }"#] {
            let err = newer_release(manifest, "0.1.0", InstallChannel::Manual).unwrap_err();
            assert_eq!(err.code, ErrorCode::UpdateCheckFailed);
            assert_eq!(err.action, Some(crate::db::errors::ErrorAction::Retry));
        }
    }

    /// A `find` that knows `names`, installed in `/usr/bin`.
    fn tools(names: &'static [&'static str]) -> impl Fn(&str) -> Option<PathBuf> {
        move |name| {
            names
                .contains(&name)
                .then(|| PathBuf::from(format!("/usr/bin/{name}")))
        }
    }

    /// A downloaded package: absolute on every OS (`/home/…` is not, on Windows).
    fn package(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    #[test]
    fn the_aur_package_is_rebuilt_by_the_installed_helper() {
        let yay = upgrade_command(InstallChannel::Aur, None, tools(&["yay", "paru"])).unwrap();
        assert_eq!(yay, "yay -S yadbe-bin");
        let paru = upgrade_command(InstallChannel::Aur, None, tools(&["paru"])).unwrap();
        assert_eq!(paru, "paru -S yadbe-bin");
        let none = upgrade_command(InstallChannel::Aur, None, tools(&["sudo"])).unwrap();
        assert_eq!(
            none,
            "git clone https://aur.archlinux.org/yadbe-bin.git && cd yadbe-bin && makepkg -si"
        );
    }

    #[test]
    fn a_downloaded_package_is_installed_with_sudo() {
        let deb = &package("yadbe_0.4.0_amd64.deb");
        let apt = upgrade_command(InstallChannel::Deb, Some(deb), tools(&["sudo", "apt"])).unwrap();
        assert_eq!(
            apt,
            format!("sudo apt install {}", shell_word(&deb.to_string_lossy()))
        );

        let rpm = &package("yadbe-0.4.0-1.x86_64.rpm");
        let rpm_arg = shell_word(&rpm.to_string_lossy());
        let dnf =
            upgrade_command(InstallChannel::Rpm, Some(rpm), tools(&["dnf", "zypper"])).unwrap();
        assert_eq!(dnf, format!("sudo dnf install {rpm_arg}"));
        let zypper = upgrade_command(InstallChannel::Rpm, Some(rpm), tools(&["zypper"])).unwrap();
        assert_eq!(
            zypper,
            format!("sudo zypper install --allow-unsigned-rpm {rpm_arg}")
        );
    }

    #[test]
    fn a_package_path_is_one_shell_word() {
        assert_eq!(
            shell_word("/home/me/.cache/dev.tropico.yadbe/update/yadbe_0.4.0_amd64.deb"),
            "/home/me/.cache/dev.tropico.yadbe/update/yadbe_0.4.0_amd64.deb"
        );
        assert_eq!(
            shell_word("/home/Jo Doe/.cache/x.deb"),
            "'/home/Jo Doe/.cache/x.deb'"
        );
        assert_eq!(
            shell_word("/tmp/it's;rm -rf ~"),
            r#"'/tmp/it'\''s;rm -rf ~'"#
        );
        assert_eq!(shell_word(""), "''");
    }

    #[test]
    fn an_upgrade_without_its_tools_or_package_is_a_typed_error() {
        let deb = package("yadbe.deb");
        let deb = deb.as_path();
        for (channel, package, names) in [
            (InstallChannel::Deb, Some(deb), &["sudo"][..]),
            (InstallChannel::Rpm, Some(deb), &["sudo", "apt"][..]),
            (InstallChannel::Manual, None, &["sudo", "apt"][..]),
            (InstallChannel::SelfUpdate, None, &["sudo", "apt"][..]),
        ] {
            let names: &'static [&'static str] = names;
            let err = upgrade_command(channel, package, tools(names)).unwrap_err();
            assert_eq!(err.code, ErrorCode::UpdateInstallFailed, "{channel:?}");
        }
        for package in [None, Some(Path::new("yadbe.deb"))] {
            let err = upgrade_command(InstallChannel::Deb, package, tools(&["apt"])).unwrap_err();
            assert_eq!(err.code, ErrorCode::Internal);
        }
    }

    #[test]
    fn release_packages_are_named_like_the_bundler_names_them() {
        let version = semver::Version::new(0, 4, 0);
        assert_eq!(
            package_asset(InstallChannel::Deb, &version, "x86_64").as_deref(),
            Some("yadbe_0.4.0_amd64.deb")
        );
        assert_eq!(
            package_asset(InstallChannel::Rpm, &version, "x86_64").as_deref(),
            Some("yadbe-0.4.0-1.x86_64.rpm")
        );
        assert_eq!(
            package_asset(InstallChannel::Deb, &version, "aarch64"),
            None
        );
        assert_eq!(package_asset(InstallChannel::Aur, &version, "x86_64"), None);
    }

    #[test]
    fn the_checksum_of_an_asset_is_read_from_the_sums() {
        let deb = "0b66918684626bf7d698e384311e27cbca1427c02ecf20280180b208230de3ea";
        let sums = format!(
            "8ba21d75112c0a79a098e5946abb8656535275a189a5159cca7f528cdd53a7dd  latest.json\n\
             {}  yadbe_0.3.0_amd64.deb\n\
             332ec9dbaa2b418fb691a563924a342b414dcf6091ba68dbfbd495bb9da4818c *yadbe-0.3.0-1.x86_64.rpm\n",
            deb.to_uppercase()
        );
        assert_eq!(
            expected_checksum(&sums, "yadbe_0.3.0_amd64.deb").as_deref(),
            Some(deb)
        );
        assert!(expected_checksum(&sums, "yadbe-0.3.0-1.x86_64.rpm").is_some());
        assert_eq!(expected_checksum(&sums, "yadbe_0.3.0_amd64.AppImage"), None);
        assert_eq!(expected_checksum("nothex  yadbe.deb", "yadbe.deb"), None);
    }

    #[test]
    fn download_progress_is_reported_once_per_percent() {
        let mut seen = Vec::new();
        let mut progress = Progress::new(|percent| seen.push(percent));
        for _ in 0..4 {
            progress.advance(1, Some(400));
        }
        progress.advance(396, Some(400));
        progress.advance(10, None);
        assert_eq!(seen, [Some(0), Some(1), Some(100), None]);
    }

    #[test]
    fn the_release_page_opens_with_the_system_opener() {
        assert_eq!(
            browser_command("linux", RELEASE_PAGE_URL),
            ("xdg-open", vec![RELEASE_PAGE_URL.to_owned()])
        );
        assert_eq!(browser_command("macos", RELEASE_PAGE_URL).0, "open");
        assert_eq!(
            browser_command("windows", RELEASE_PAGE_URL).0,
            "explorer.exe"
        );
        for url in [MANIFEST_URL, RELEASE_PAGE_URL, RELEASE_DOWNLOAD_URL] {
            assert!(url.starts_with("https://github.com/SimonVanMello/yadbe/releases/"));
        }
    }

    #[test]
    fn the_package_folder_is_emptied_before_a_download() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join(DOWNLOAD_FOLDER);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("yadbe_0.1.0_amd64.deb"), b"old").unwrap();
        let path = folder.join("yadbe_0.2.0_amd64.deb");
        write_package(&folder, &path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 1);
    }
}
