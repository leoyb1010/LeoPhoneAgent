use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Cap the log file at 5 MiB. When the existing file already exceeds this
/// at startup, we truncate it (start fresh) — keeping a single rolling file
/// instead of a .old/.1/.2 ladder. The updater runs only minutes per update,
/// so within a single run we never exceed the cap; rotation is purely a
/// "next-launch" concern.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

static LOG_FILE: OnceLock<Mutex<Option<File>>> = OnceLock::new();
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn init(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Rotate-by-truncate if the existing file is over the cap. Stat failures
    // (file missing) fall through to "open append" which handles creation.
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_LOG_BYTES {
            // Open in write+truncate mode to wipe content. We deliberately do
            // NOT delete + recreate, because some AV scanners briefly hold a
            // delete lock that would race the subsequent OpenOptions::new()
            // append below.
            if let Ok(mut f) = OpenOptions::new().write(true).truncate(true).open(path) {
                let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
                let header = format!(
                    "[{ts}] [INFO] [logger] log truncated (was {} bytes, cap {} bytes)\n",
                    meta.len(),
                    MAX_LOG_BYTES
                );
                let _ = f.write_all(header.as_bytes());
            }
        }
    }

    let file = OpenOptions::new().create(true).append(true).open(path).ok();
    let _ = LOG_FILE.set(Mutex::new(file));
    let _ = LOG_PATH.set(path.to_path_buf());
}

fn write(level: &str, line: impl AsRef<str>) {
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let formatted = format!("[{ts}] [{level}] {}\n", line.as_ref());
    if let Some(lock) = LOG_FILE.get() {
        if let Ok(mut guard) = lock.lock() {
            if let Some(file) = guard.as_mut() {
                let _ = file.write_all(formatted.as_bytes());
                let _ = file.flush();
            }
        }
    }
    eprint!("{formatted}");
}

pub fn info(line: impl AsRef<str>) {
    write("INFO", line);
}

pub fn warn(line: impl AsRef<str>) {
    write("WARN", line);
}

pub fn error(line: impl AsRef<str>) {
    write("ERROR", line);
}
