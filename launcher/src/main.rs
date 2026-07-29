#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use anyhow::{Context, Result};
use ilab_conjure_launcher::{
    localized_menu_labels, maybe_offer_legacy_portable_migration, rabbit_icon_rgba,
    resolve_launcher_locale, verify_update_manifest_file, AppLocale, LauncherConfig, UpdateOutcome,
    WebUiService, APP_NAME, WEBUI_URL,
};
use std::path::Path;
use std::time::{Duration, Instant};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem},
    Icon, TrayIcon, TrayIconBuilder,
};
use winit::{
    event::{Event, StartCause},
    event_loop::{ControlFlow, EventLoop},
};

const MENU_OPEN_WEBUI: &str = "open-webui";
const MENU_OPEN_SETTINGS: &str = "open-settings";
const MENU_OPEN_HISTORY: &str = "open-history";
const MENU_CHECK_UPDATES: &str = "check-updates";
const MENU_ABOUT: &str = "about";
const MENU_RESTART: &str = "restart";
const MENU_QUIT: &str = "quit";
const LOCALE_SYNC_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Debug)]
enum UserEvent {
    Menu(MenuEvent),
}

struct TrayState {
    _tray_icon: TrayIcon,
    _menu: Menu,
    open_item: MenuItem,
    settings_item: MenuItem,
    history_item: MenuItem,
    update_item: MenuItem,
    about_item: MenuItem,
    restart_item: MenuItem,
    quit_item: MenuItem,
    _separators: Vec<PredefinedMenuItem>,
    locale: AppLocale,
}

impl TrayState {
    fn sync_locale(&mut self, locale: AppLocale) {
        if self.locale == locale {
            return;
        }
        let labels = localized_menu_labels(locale);
        self.open_item.set_text(labels.open_webui);
        self.settings_item.set_text(labels.open_settings);
        self.history_item.set_text(labels.open_history);
        self.update_item.set_text(labels.check_updates);
        self.about_item.set_text(labels.about);
        self.restart_item.set_text(labels.restart);
        self.quit_item.set_text(labels.quit);
        self.locale = locale;
    }
}

fn main() {
    if let Err(error) = run() {
        show_startup_error(&format!("{error:#}"));
    }
}

// winit 0.30 still supports this closure API; migrating to ApplicationHandler is a separate
// behavioral refactor. Keep the exception local so CI can reject every other warning.
#[allow(deprecated)]
fn run() -> Result<()> {
    if let Some(manifest_path) = verify_manifest_arg()? {
        verify_update_manifest_file(Path::new(&manifest_path))?;
        return Ok(());
    }

    let config = LauncherConfig::detect()?;
    maybe_offer_legacy_portable_migration(
        &config,
        resolve_launcher_locale(&config.webui_settings_path()),
    )?;
    let mut service = WebUiService::new(config.clone());

    let event_loop = EventLoop::<UserEvent>::with_user_event()
        .build()
        .context("failed to create launcher event loop")?;
    let proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = proxy.send_event(UserEvent::Menu(event));
    }));

    let mut tray_state: Option<TrayState> = None;
    let mut opened_on_startup = false;
    let mut next_locale_sync = Instant::now() + LOCALE_SYNC_INTERVAL;

    event_loop.run(move |event, target| {
        target.set_control_flow(ControlFlow::WaitUntil(next_locale_sync));

        match event {
            Event::NewEvents(StartCause::Init) => {
                if tray_state.is_none() {
                    match create_tray_state(&config) {
                        Ok(state) => tray_state = Some(state),
                        Err(error) => {
                            show_startup_error(&format!(
                                "Could not create system tray icon: {error:#}"
                            ));
                            target.exit();
                        }
                    }
                }
                if !opened_on_startup {
                    opened_on_startup = true;
                    if let Err(error) = service.ensure_running().and_then(|_| service.open_webui())
                    {
                        let _ = service.log_line(&format!("startup failed: {error:#}"));
                        show_startup_error(&format!("{error:#}"));
                    }
                }
            }
            Event::AboutToWait => {
                if Instant::now() >= next_locale_sync {
                    if let Some(state) = tray_state.as_mut() {
                        state.sync_locale(resolve_launcher_locale(&config.webui_settings_path()));
                    }
                    next_locale_sync = Instant::now() + LOCALE_SYNC_INTERVAL;
                    target.set_control_flow(ControlFlow::WaitUntil(next_locale_sync));
                }
            }
            Event::UserEvent(UserEvent::Menu(event)) => match event.id.as_ref() {
                MENU_OPEN_WEBUI => {
                    if let Err(error) = service.ensure_running().and_then(|_| service.open_webui())
                    {
                        show_startup_error(&format!("{error:#}"));
                    }
                }
                MENU_OPEN_SETTINGS => {
                    if let Err(error) = service
                        .ensure_running()
                        .and_then(|_| service.open_settings())
                    {
                        show_startup_error(&format!("{error:#}"));
                    }
                }
                MENU_OPEN_HISTORY => {
                    if let Err(error) = service
                        .ensure_running()
                        .and_then(|_| service.open_history())
                    {
                        show_startup_error(&format!("{error:#}"));
                    }
                }
                MENU_CHECK_UPDATES => {
                    let locale = tray_state
                        .as_ref()
                        .map(|state| state.locale)
                        .unwrap_or_else(|| resolve_launcher_locale(&config.webui_settings_path()));
                    match service.check_for_updates(locale) {
                        Ok(UpdateOutcome::Continue) => {}
                        Ok(UpdateOutcome::LaunchedUpdater) => {
                            service.stop_owned_service();
                            target.exit();
                        }
                        Err(error) => show_startup_error(&format!("{error:#}")),
                    }
                }
                MENU_ABOUT => {
                    let locale = tray_state
                        .as_ref()
                        .map(|state| state.locale)
                        .unwrap_or_else(|| resolve_launcher_locale(&config.webui_settings_path()));
                    match service.show_about(locale) {
                        Ok(UpdateOutcome::Continue) => {}
                        Ok(UpdateOutcome::LaunchedUpdater) => {
                            service.stop_owned_service();
                            target.exit();
                        }
                        Err(error) => show_startup_error(&format!("{error:#}")),
                    }
                }
                MENU_RESTART => {
                    if let Err(error) = service.restart_owned_service() {
                        show_startup_error(&format!("{error:#}"));
                    }
                }
                MENU_QUIT => {
                    service.stop_owned_service();
                    target.exit();
                }
                _ => {}
            },
            Event::LoopExiting => {
                service.stop_owned_service();
            }
            _ => {}
        }
    })?;

    Ok(())
}

fn verify_manifest_arg() -> Result<Option<String>> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--verify-update-manifest") => args
            .next()
            .map(Some)
            .context("--verify-update-manifest requires a manifest path"),
        _ => Ok(None),
    }
}

fn create_tray_state(config: &LauncherConfig) -> Result<TrayState> {
    let locale = resolve_launcher_locale(&config.webui_settings_path());
    let labels = localized_menu_labels(locale);
    let menu = Menu::new();
    let open_item = MenuItem::with_id(MenuId::new(MENU_OPEN_WEBUI), labels.open_webui, true, None);
    let settings_item = MenuItem::with_id(
        MenuId::new(MENU_OPEN_SETTINGS),
        labels.open_settings,
        true,
        None,
    );
    let history_item = MenuItem::with_id(
        MenuId::new(MENU_OPEN_HISTORY),
        labels.open_history,
        true,
        None,
    );
    let update_item = MenuItem::with_id(
        MenuId::new(MENU_CHECK_UPDATES),
        labels.check_updates,
        true,
        None,
    );
    let about_item = MenuItem::with_id(MenuId::new(MENU_ABOUT), labels.about, true, None);
    let restart_item = MenuItem::with_id(MenuId::new(MENU_RESTART), labels.restart, true, None);
    let quit_item = MenuItem::with_id(MenuId::new(MENU_QUIT), labels.quit, true, None);
    let separator_one = PredefinedMenuItem::separator();
    let separator_two = PredefinedMenuItem::separator();

    menu.append_items(&[
        &open_item,
        &settings_item,
        &history_item,
        &update_item,
        &about_item,
        &separator_one,
        &restart_item,
        &separator_two,
        &quit_item,
    ])?;

    let (rgba, width, height) = rabbit_icon_rgba(32);
    let icon = Icon::from_rgba(rgba, width, height).context("failed to build rabbit tray icon")?;
    let tray_icon = TrayIconBuilder::new()
        .with_tooltip(format!("{APP_NAME} - {WEBUI_URL}"))
        .with_menu(Box::new(menu.clone()))
        .with_icon(icon)
        .with_icon_as_template(true)
        .with_menu_on_left_click(true)
        .with_menu_on_right_click(true)
        .build()
        .context("failed to create tray icon")?;

    Ok(TrayState {
        _tray_icon: tray_icon,
        _menu: menu,
        open_item,
        settings_item,
        history_item,
        update_item,
        about_item,
        restart_item,
        quit_item,
        _separators: vec![separator_one, separator_two],
        locale,
    })
}

fn show_startup_error(message: &str) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("osascript")
            .arg("-e")
            .arg(format!(
                "display dialog {:?} with title {:?} buttons {{\"OK\"}} default button \"OK\"",
                message, APP_NAME
            ))
            .status();
    }

    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show({:?}, {:?})",
                    message, APP_NAME
                ),
            ])
            .status();
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        eprintln!("{APP_NAME}: {message}");
    }
}
