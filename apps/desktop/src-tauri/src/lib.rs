#[cfg(target_os = "windows")]
fn style_windows_title_bar(app: &mut tauri::App) {
    use std::ffi::c_void;
    use tauri::Manager;

    // Keep Windows' native, accessible window controls and snap/resize behavior,
    // but match their title bar to the dark Vizosten interface. Newer caption
    // color attributes may be unsupported on older Windows versions; in that
    // case Windows simply keeps its default styling.
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut c_void,
            attribute: u32,
            value: *const c_void,
            size: u32,
        ) -> i32;
    }
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(hwnd) = window.hwnd() {
            let dark: i32 = 1;
            let caption: u32 = 0x000000;
            let text: u32 = 0xffffff;
            unsafe {
                let handle = hwnd.0 as *mut c_void;
                DwmSetWindowAttribute(handle, 20, &dark as *const _ as *const c_void, 4);
                DwmSetWindowAttribute(handle, 35, &caption as *const _ as *const c_void, 4);
                DwmSetWindowAttribute(handle, 36, &text as *const _ as *const c_void, 4);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_native_player])
        .setup(|app| {
            #[cfg(target_os = "windows")]
            style_windows_title_bar(app);
            #[cfg(not(target_os = "windows"))]
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Vizosten desktop application failed to start");
}

/// Open a verified HTTPS media URL in the mpv runtime shipped with Vizosten.
/// Arguments are passed directly (never through a shell), and mpv's normal
/// user configuration is disabled so untrusted pages cannot add command flags.
#[tauri::command]
fn open_native_player(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri::{Manager, Url};
    if url.len() > 8192 {
        return Err("نشانی ویدیو بیش از حد طولانی است.".into());
    }
    let parsed = Url::parse(&url).map_err(|_| "نشانی ویدیو نامعتبر است.")?;
    if parsed.scheme() != "https" || parsed.host_str().is_none()
        || !parsed.username().is_empty() || parsed.password().is_some()
    {
        return Err("فقط نشانی مستقیم HTTPS بدون نام کاربری مجاز است.".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let executable = app.path().resolve("mpv/mpv.exe", tauri::path::BaseDirectory::Resource)
            .map_err(|_| "مسیر پلیر پیدا نشد.")?;
        if !executable.is_file() {
            return Err("موتور پخش در بستهٔ برنامه پیدا نشد.".into());
        }
        std::process::Command::new(executable)
            .args(["--no-config", "--no-terminal", "--ytdl=no", "--force-window=yes", "--title=Vizosten Player", "--", parsed.as_str()])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW: no extra console
            .spawn().map_err(|_| "اجرای پلیر بومی ممکن نشد.")?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("پلیر بومی دسکتاپ فقط برای ویندوز آماده شده است.".into())
    }
}
