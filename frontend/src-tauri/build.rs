fn main() {
    // tauri-build embeds icons/icon.ico as the exe's icon resource but never tells cargo to watch it, so a changed icon kept the
    // old one baked into the exe (and into the window/taskbar icon) until something else forced this script to rerun.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
