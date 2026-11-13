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
