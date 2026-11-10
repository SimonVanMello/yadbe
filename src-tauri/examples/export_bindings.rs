//! Regenerates `src/ipc/bindings.ts` from the Rust command definitions (`pnpm bindings`).

use std::path::Path;

fn main() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(yadbe_lib::BINDINGS_PATH);
    match yadbe_lib::export_bindings(&path) {
        Ok(()) => println!("Bindings written to {}", path.display()),
        Err(err) => {
            eprintln!("Failed to export bindings: {err}");
            std::process::exit(1);
        }
    }
}
