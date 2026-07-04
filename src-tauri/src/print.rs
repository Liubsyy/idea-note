// Trigger the OS print dialog ("存储为 PDF") for the current webview.
//
// Why a backend command instead of JS `window.print()`:
// on macOS, `window.print()` is a no-op inside WKWebView, so Tauri exposes a
// native `WebviewWindow::print()` (an NSPrintOperation) that actually opens the
// print panel. On other platforms that native method isn't implemented, but JS
// `window.print()` does work there — so we `eval` it instead. Either way the
// print stylesheet (`@media print`) is what isolates the note from the app UI.

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| format!("print failed: {e}"))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .eval("window.print()")
        .map_err(|e| format!("print failed: {e}"))
}

// ---------------------------------------------------------------------------
// export_pdf: silent print-to-PDF via the native webview, no print dialog.
//
// Tauri/wry expose no cross-platform API for this, so each platform talks to
// its own webview directly (through `with_webview`, which runs the closure on
// the UI thread):
//   - macOS:   WKWebView printOperationWithPrintInfo + NSPrintSaveJob
//   - Windows: ICoreWebView2_7::PrintToPdf
//   - Linux:   WebKitPrintOperation + GtkPrintSettings "output-uri"
// All engines apply `@media print`, so print.css isolates #print-root exactly
// like the dialog-based print_page above. The frontend must have filled
// #print-root before invoking this.

use std::sync::mpsc::Sender;
use std::time::Duration;

type ExportResult = Result<(), String>;

/// One heading in the exported document. `marker` is an invisible ASCII string
/// the frontend planted right before the heading; locating it in the finished
/// PDF gives the bookmark's page and position (searching the heading title
/// itself is unreliable: CJK glyphs can map to variant codepoints in the text
/// layer).
#[derive(serde::Deserialize)]
pub struct OutlineEntry {
    level: u32,
    title: String,
    marker: String,
}

#[tauri::command]
pub async fn export_pdf(
    window: tauri::WebviewWindow,
    path: String,
    outline: Vec<OutlineEntry>,
) -> Result<(), String> {
    let target = std::path::PathBuf::from(&path);
    match target.parent() {
        Some(parent) if parent.is_dir() => {}
        _ => return Err(format!("导出目录不存在: {path}")),
    }
    // Remove any stale file so completion detection can't latch onto an old one.
    if target.exists() {
        std::fs::remove_file(&target).map_err(|e| format!("无法覆盖已有文件: {e}"))?;
    }

    let (done_tx, done_rx) = std::sync::mpsc::channel::<ExportResult>();
    let webview_path = path.clone();
    window
        .with_webview(move |webview| start_export(webview, webview_path, done_tx))
        .map_err(|e| format!("failed to access webview: {e}"))?;

    // The platform code reports back asynchronously (completion callback on
    // Windows/Linux, file polling on macOS); don't block the async runtime.
    tauri::async_runtime::spawn_blocking(move || {
        done_rx
            .recv_timeout(Duration::from_secs(90))
            .unwrap_or_else(|_| Err("导出 PDF 超时".into()))
    })
    .await
    .map_err(|e| e.to_string())??;

    match std::fs::metadata(&target) {
        Ok(meta) if meta.len() > 0 => {}
        _ => return Err("导出失败：未生成 PDF 文件".into()),
    }

    // Best-effort: bookmarks are an enhancement, a failure here must not fail
    // an export that already produced a valid PDF.
    #[cfg(target_os = "macos")]
    if !outline.is_empty() {
        if let Err(e) = unsafe { add_outline_macos(&path, &outline) } {
            eprintln!("export_pdf: PDF outline skipped: {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = &outline; // TODO: outline post-processing for Windows/Linux

    Ok(())
}

/// Rewrite the finished PDF with a bookmark tree via PDFKit: find each
/// heading's invisible marker to get its page + position, nest entries by
/// heading level, and save in place.
#[cfg(target_os = "macos")]
unsafe fn add_outline_macos(path: &str, entries: &[OutlineEntry]) -> ExportResult {
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_foundation::{NSPoint, NSString, NSStringCompareOptions, NSURL};
    use objc2_pdf_kit::{PDFDestination, PDFDocument, PDFOutline};

    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let doc =
        PDFDocument::initWithURL(PDFDocument::alloc(), &url).ok_or("PDFKit 无法打开导出的文件")?;

    let root = PDFOutline::init(PDFOutline::alloc());
    // Stack of (heading level, outline node) from root to the current branch.
    let mut stack: Vec<(u32, Retained<PDFOutline>)> = vec![(0, root.clone())];
    let mut added = false;
    for entry in entries {
        let matches = doc.findString_withOptions(
            &NSString::from_str(&entry.marker),
            NSStringCompareOptions::LiteralSearch,
        );
        let Some(selection) = matches.firstObject() else {
            continue; // marker didn't survive into the text layer; skip entry
        };
        let Some(page) = selection.pages().firstObject() else {
            continue;
        };
        let bounds = selection.boundsForPage(&page);
        // PDF y-coordinates grow upward; anchor a little above the marker so
        // the heading itself is visible after jumping.
        let point = NSPoint {
            x: 0.0,
            y: bounds.origin.y + bounds.size.height + 12.0,
        };
        let dest = PDFDestination::initWithPage_atPoint(PDFDestination::alloc(), &page, point);

        let node = PDFOutline::init(PDFOutline::alloc());
        node.setLabel(Some(&NSString::from_str(&entry.title)));
        node.setDestination(Some(&dest));

        while stack.len() > 1 && stack.last().is_some_and(|(l, _)| *l >= entry.level) {
            stack.pop();
        }
        let parent = &stack.last().expect("stack always holds the root").1;
        parent.insertChild_atIndex(&node, parent.numberOfChildren());
        stack.push((entry.level, node));
        added = true;
    }

    if !added {
        return Ok(()); // nothing located, leave the PDF untouched
    }
    doc.setOutlineRoot(Some(&root));
    if !doc.writeToFile(&NSString::from_str(path)) {
        return Err("PDFKit 回写文件失败".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn start_export(
    webview: tauri::webview::PlatformWebview,
    path: String,
    done: Sender<ExportResult>,
) {
    if let Err(e) = unsafe { start_export_macos(&webview, &path) } {
        let _ = done.send(Err(e));
        return;
    }
    // NSPrintSaveJob spools asynchronously and we run the operation without a
    // delegate, so completion is detected by watching the output file: done
    // once it exists, is non-empty and its size stopped growing.
    std::thread::spawn(move || {
        let target = std::path::PathBuf::from(&path);
        let deadline = std::time::Instant::now() + Duration::from_secs(80);
        let mut last_len = 0u64;
        loop {
            std::thread::sleep(Duration::from_millis(300));
            let len = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
            if len > 0 && len == last_len {
                let _ = done.send(Ok(()));
                return;
            }
            last_len = len;
            if std::time::Instant::now() > deadline {
                let _ = done.send(Err("导出 PDF 超时".into()));
                return;
            }
        }
    });
}

#[cfg(target_os = "macos")]
unsafe fn start_export_macos(
    webview: &tauri::webview::PlatformWebview,
    path: &str,
) -> ExportResult {
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2_app_kit::{
        NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob, NSPrintingPaginationMode,
    };
    use objc2_foundation::{NSCopying, NSObjectProtocol, NSString, NSURL};
    use objc2_web_kit::WKWebView;

    let wk = &*webview.inner().cast::<WKWebView>();
    // printOperationWithPrintInfo: needs macOS 11+.
    if !wk.respondsToSelector(objc2::sel!(printOperationWithPrintInfo:)) {
        return Err("导出 PDF 需要 macOS 11 或更高版本".into());
    }

    let info = NSPrintInfo::sharedPrintInfo().copy();
    // WebKit ignores CSS @page margins, so mirror print.css's 16mm (≈45.35pt).
    let margin = 45.35;
    info.setTopMargin(margin);
    info.setBottomMargin(margin);
    info.setLeftMargin(margin);
    info.setRightMargin(margin);
    info.setHorizontallyCentered(false);
    info.setVerticallyCentered(false);
    info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
    info.setJobDisposition(NSPrintSaveJob);
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let url_obj: &AnyObject = &url;
    info.dictionary()
        .setObject_forKey(url_obj, ProtocolObject::from_ref(NSPrintJobSavingURL));

    let op = wk.printOperationWithPrintInfo(&info);
    op.setShowsPrintPanel(false);
    op.setShowsProgressPanel(false);
    op.setCanSpawnSeparateThread(true);

    let window = wk.window().ok_or("webview 不在窗口中")?;
    op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
        &window,
        None,
        None,
        std::ptr::null_mut(),
    );
    Ok(())
}

#[cfg(target_os = "windows")]
fn start_export(
    webview: tauri::webview::PlatformWebview,
    path: String,
    done: Sender<ExportResult>,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING};

    let done_cb = done.clone();
    let result = (|| -> ExportResult {
        let core = unsafe { webview.controller().CoreWebView2() }
            .map_err(|e| format!("CoreWebView2: {e}"))?;
        // PrintToPdf needs WebView2 Runtime 1.0.992+ (ICoreWebView2_7).
        let wv7: ICoreWebView2_7 = core
            .cast()
            .map_err(|e| format!("需要更新 WebView2 Runtime: {e}"))?;
        let env6: ICoreWebView2Environment6 = webview
            .environment()
            .cast()
            .map_err(|e| format!("需要更新 WebView2 Runtime: {e}"))?;
        let settings = unsafe { env6.CreatePrintSettings() }.map_err(|e| e.to_string())?;
        unsafe {
            settings
                .SetShouldPrintBackgrounds(true)
                .map_err(|e| e.to_string())?;
            settings
                .SetShouldPrintHeaderAndFooter(false)
                .map_err(|e| e.to_string())?;
            // Blink applies print.css's @page 16mm margins itself; zero the
            // printer margins so the two don't stack.
            settings.SetMarginTop(0.0).map_err(|e| e.to_string())?;
            settings.SetMarginBottom(0.0).map_err(|e| e.to_string())?;
            settings.SetMarginLeft(0.0).map_err(|e| e.to_string())?;
            settings.SetMarginRight(0.0).map_err(|e| e.to_string())?;
        }
        let handler =
            PrintToPdfCompletedHandler::create(Box::new(move |error_code, is_successful| {
                let outcome = match error_code {
                    Ok(()) if is_successful => Ok(()),
                    Ok(()) => Err("PrintToPdf 失败".to_string()),
                    Err(e) => Err(e.to_string()),
                };
                let _ = done_cb.send(outcome);
                Ok(())
            }));
        unsafe { wv7.PrintToPdf(&HSTRING::from(path.as_str()), &settings, &handler) }
            .map_err(|e| e.to_string())
    })();
    if let Err(e) = result {
        let _ = done.send(Err(e));
    }
}

#[cfg(target_os = "linux")]
fn start_export(
    webview: tauri::webview::PlatformWebview,
    path: String,
    done: Sender<ExportResult>,
) {
    use gtk::prelude::*;
    use webkit2gtk::PrintOperationExt;

    let result = (|| -> ExportResult {
        let uri = gtk::glib::filename_to_uri(&path, None).map_err(|e| e.to_string())?;
        let op = webkit2gtk::PrintOperation::new(&webview.inner());

        let settings = gtk::PrintSettings::new();
        settings.set_printer("Print to File");
        settings.set("output-file-format", Some("pdf"));
        settings.set("output-uri", Some(uri.as_str()));
        op.set_print_settings(&settings);

        // WebKit ignores CSS @page margins, so mirror print.css's 16mm here.
        let setup = gtk::PageSetup::new();
        setup.set_top_margin(16.0, gtk::Unit::Mm);
        setup.set_bottom_margin(16.0, gtk::Unit::Mm);
        setup.set_left_margin(16.0, gtk::Unit::Mm);
        setup.set_right_margin(16.0, gtk::Unit::Mm);
        op.set_page_setup(&setup);

        // "failed" fires before "finished" on error, so the receiver (which
        // takes the first message) reports the real failure.
        let done_err = done.clone();
        op.connect_failed(move |_, err| {
            let _ = done_err.send(Err(err.to_string()));
        });
        let done_ok = done.clone();
        op.connect_finished(move |_| {
            let _ = done_ok.send(Ok(()));
        });
        op.print();
        Ok(())
    })();
    if let Err(e) = result {
        let _ = done.send(Err(e));
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn start_export(
    _webview: tauri::webview::PlatformWebview,
    _path: String,
    done: Sender<ExportResult>,
) {
    let _ = done.send(Err("当前平台暂不支持导出 PDF".into()));
}
