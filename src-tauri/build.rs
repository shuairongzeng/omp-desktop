fn main() {
    // tauri_build::build() embeds the Common-Controls v6 activation manifest
    // into the *bin* target only (resource.lib, `rustc-link-arg-bins`); its own
    // test-harness workaround (`embed_manifest_for_tests`, tauri-apps/tauri
    // #4383) is gated to the tauri workspace and never runs here. Without an
    // activation context a test exe resolves comctl32 to v5, where tao/muda's
    // `SetWindowSubclass` / `TaskDialogIndirect` imports do not exist, and
    // `cargo test` dies at startup with STATUS_ENTRYPOINT_NOT_FOUND
    // (0xc0000139) — including the test exe for the *bin* target itself.
    //
    // So the manifest moves out of tauri-build's resource.lib and onto a plain
    // link argument: unqualified `rustc-link-arg` reaches every target (bin,
    // lib, each test harness) exactly once, and `new_without_app_manifest`
    // keeps the resource's RT_MANIFEST from colliding with it (a duplicate
    // resource is LNK1123, a hard error). Everything else tauri-build does —
    // version info, the icon, the static VC runtime, capabilities — is kept
    // by calling `try_build` with the same attributes as `build()` minus the
    // manifest.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR is set by cargo");
        let manifest = std::path::Path::new(&out_dir).join("app-manifest.xml");
        std::fs::write(&manifest, APP_MANIFEST).expect("write the app manifest");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    if let Err(error) = tauri_build::try_build(attributes) {
        let error = format!("{error:#}");
        println!("{error}");
        std::process::exit(1);
    }
}

/// The manifest tauri-build would otherwise embed into the bin's resource
/// (its `windows-app-manifest.xml`, verbatim): the Common-Controls v6
/// dependency tao's windows and muda's menus need.
const APP_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;
