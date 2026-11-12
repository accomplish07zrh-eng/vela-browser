use tauri::WebviewWindow;

pub struct WindowOrigin(pub String);

/// Desktop capabilities belong only to Vela's main dashboard window.
pub(crate) fn authorize(window: &WebviewWindow, state: &WindowOrigin) -> Result<(), String> {
    if window.label() != "main" {
        return Err("desktop capabilities are available only to the main window".to_owned());
    }
    let origin = window
        .url()
        .map_err(|_| "could not verify the dashboard origin".to_owned())?
        .origin()
        .ascii_serialization();
    if origin != state.0 {
        return Err("desktop capability rejected the window origin".to_owned());
    }
    Ok(())
}
