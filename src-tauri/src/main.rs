// 릴리스에서 Windows 콘솔 창이 뜨지 않게
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if air_pdf_lib::run_setup_task() {
        return;
    }
    air_pdf_lib::run()
}
