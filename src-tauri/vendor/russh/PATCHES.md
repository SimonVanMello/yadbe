# russh 0.65.1, patched for yadbe

The commit `chore(vendor): russh 0.65.1 as published on crates.io` holds the crate's source,
manifest and README exactly as published (0.65.1 is the latest release as of 2026-11; upstream
commit `b33092aad1e51c66258a12e8b83fc473a68d9d34`), with the Apache-2.0 license text it is
published under. The next commit applies the patches below; `git diff <that commit> --
src-tauri/vendor/russh` shows all of them.

## Why a fork

yadbe's SSH tunnel (F-010) carries every database connection of a session (metadata, each
query tab, each table tab, exports) over one SSH session, one `direct-tcpip` channel each. The
published client refills a channel's receive window as soon as data *arrives*, then hands the
data to the channel's bounded queue and waits for room there. A consumer that stops reading
(a result paused at its row cap, an export writing to a slow disk) therefore never stops the
server through the window: its queue fills, the session task blocks on it, and every other
channel of the session stops with it (the explorer, the other tabs). No public API or flag
controls when the window is refilled (`Handler::adjust_window` only sets the size of the next
refill, `channel_buffer_size` only moves the point where the session blocks), so the fix has to
be in the crate.

Ruled out: one SSH connection per database connection (a handshake and an authentication per
tab, an agent confirmation per tab, and still head-of-line blocking on a shared jump host);
reading channels eagerly into unbounded buffers (a paused 10-million-row result would be held
in memory twice).

## Patches

| # | Change | Files | Upstreamable |
|---|---|---|---|
| 1 | Consumer-driven receive windows for client-opened channels | `channels/mod.rs`, `channels/io/rx.rs`, `client/mod.rs`, `client/encrypted.rs`, `session.rs`, `server/session.rs` | Yes, it is what RFC 4254 §5.2 intends |
| 2 | Manifest without tests, examples, benches and dev-dependencies | `Cargo.toml` | No (vendoring only) |
| 3 | No dead-code warning without the `flate2` feature | `cipher/mod.rs` | Yes, 2 lines |

1. **Consumer-driven receive windows.** Channels opened through `client::Handle` (session,
   X11, `direct-tcpip`, `direct-streamlocal`) no longer get their window refilled when data
   arrives: the session only accounts for it (`Encrypted::consume_window`). Their read half
   reports every `Data` / `ExtendedData` message its consumer took (`ChannelReadHalf::wait`,
   `Channel::wait`, the `AsyncRead` of `make_reader*` and `ChannelStream`, skipped messages
   included) through a new `client::Msg::ReadCredit`, sent on the session's unbounded priority
   queue; the session grants those bytes back with `CHANNEL_WINDOW_ADJUST` once the window the
   server sees is below half of `Config::window_size` (`Encrypted::grant_window`). The server
   then never has more than one window of unread data in flight on a channel, and a consumer
   that stops reading stops its own channel only. Channels the server opens (forwarded TCP/IP,
   agent, X11 to the client) and the server side keep the published behavior. Callers must
   size `Config::channel_buffer_size` to hold a window of small packets (yadbe: 2 MiB window,
   1024 messages), or a reader that is behind can still block the session briefly until it
   reads one message.
2. **Manifest.** The `[[example]]`, `[[test]]` and `[[bench]]` targets and the dev-dependencies
   are dropped (their files are not vendored); the `_bench` feature stays, empty, because the
   source tests for it.
3. **Dead code.** `MAXIMUM_DECOMPRESSED_PACKET_LEN` is only read with `flate2`, which yadbe
   turns off.

## Updating

Copy the new release over `src-tauri/vendor/russh` in a commit of its own (source, manifest,
README), then re-apply the patches above and check `cargo test --test ssh_tunnel` with the test
servers of `dev/ssh-test.sh` (the paused-result test fails without patch 1).
