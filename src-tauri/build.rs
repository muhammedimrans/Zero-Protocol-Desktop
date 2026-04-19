fn main() {
    embed_windows_manifest();
    tauri_build::build()
}

/// Embed windows/app.manifest into the .exe so Windows elevates the process
/// via UAC (requireAdministrator) — needed to create the wintun TUN adapter.
fn embed_windows_manifest() {
    #[cfg(target_os = "windows")]
    {
        let mut res = winres::WindowsResource::new();
        res.set_manifest_file("windows/app.manifest");
        if let Err(e) = res.compile() {
            // Non-fatal: warn but don't break the build.
            // The app will still work; TUN adapter creation will fail without admin.
            println!("cargo:warning=Could not embed UAC manifest: {}", e);
        }
    }
}
