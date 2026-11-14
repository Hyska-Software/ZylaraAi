//! Zylara — desktop AI chat harness.
//!
//! Layer map:
//! - `catalog`:   bundled model catalog (protocols + reasoning capabilities)
//! - `providers`: wire protocols (OpenAI chat/responses, Anthropic, Google)
//! - `harness`:   agent loop (system prompt, tools, streaming, persistence)
//! - `tools`:     web search, page fetch, file creation, code execution and skills
//! - `documents`: attachment text extraction (pdf, docx, xlsx, pptx, text, images)
//!                and artifact previews (docx→html, xlsx, pptx)
//! - `db`:        SQLite persistence
//! - `commands`:  Tauri command surface used by the React app
//! - `process_env`: environment hygiene for child processes (loader/AppImage/git)

mod agents;
mod catalog;
mod commands;
mod computer;
mod concurrency;
mod config;
mod db;
mod documents;
mod domain;
mod events;
mod github;
mod harness;
mod http;
mod i18n;
#[cfg(windows)]
mod installer;
mod jobs;
mod mcp;
mod oauth;
mod policy;
mod process_env;
mod providers;
mod state;
mod terminal;
mod themes;
mod tools;
mod tray;
mod update;
mod workspace;

use tauri::Manager;

pub fn run() {
    #[cfg(unix)]
    if let Some(job) = update::managed::helper_requested() {
        update::managed::run_helper(&job);
    }

    let context = tauri::generate_context!();

    #[cfg(windows)]
    if let Some(mode) = installer::requested_mode() {
        installer::run(mode, context);
        return;
    }

    // A second launch never starts another app: it wakes the running instance,
    // which is the only way back while the window is hidden in the tray.
    if crate::tray::another_instance_running() {
        if crate::tray::request_activation() {
            return;
        }
        // Never leave the user with nothing: boot a window instead. The
        // single-instance plugin still forwards and exits when it can.
        eprintln!("zylara: another instance is running but could not be signalled");
    }

    run_app(context);
}

/// Starts the app shutdown: cancel active turns, give them a short window to
/// persist partial state, then exit. Shared by window close and the tray menu.
pub(crate) fn begin_graceful_exit(app_handle: &tauri::AppHandle) {
    if app_handle.try_state::<state::AppState>().is_none() {
        return;
    }
    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let app_state = app_handle.state::<state::AppState>();
        app_state.begin_shutdown();
        crate::state::wait_until_idle(
            || app_state.active_turns().is_empty(),
            std::time::Duration::from_millis(2_000),
        )
        .await;
        app_handle.exit(0);
    });
}

fn run_app(context: tauri::Context<tauri::Wry>) {
    let app = tauri::Builder::default()
        // Must be the first plugin: a second instance focuses the existing
        // window instead of racing the rotating OAuth refresh token and the
        // secrets file.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A hidden window has no taskbar entry: bring it back instead of
            // only focusing it.
            crate::tray::show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                let app = window.app_handle();
                let Some(state) = app.try_state::<state::AppState>() else {
                    return;
                };
                // The updater setup asks the running app to close with a real
                // WM_CLOSE; that close must quit, not hide.
                if state.take_exit_on_close() {
                    return;
                }
                if crate::config::load_settings(app).close_to_tray
                    && crate::tray::is_available(app)
                {
                    api.prevent_close();
                    // Without a tray icon the hidden window would be unreachable;
                    // the close proceeds and ExitRequested quits the app.
                    if let Err(error) = window.hide() {
                        eprintln!("zylara: failed to hide the main window: {error}");
                    }
                }
            }
        })
        .setup(|app| {
            crate::state::ensure_dirs(app.handle()).expect("failed to create app dirs");
            let state = crate::state::AppState::init(app.handle())
                .expect("failed to initialize Zylara state");
            app.manage(state);
            let settings = crate::config::load_settings(app.handle());
            if let Err(error) = crate::tray::init(app.handle(), &settings) {
                // A missing notification area must not prevent the app from
                // booting; a second launch restores a hidden window.
                eprintln!("zylara: system tray unavailable: {error}");
            }
            // Independent of the tray icon and of the single-instance plugin's
            // window messages: a launch rewrites the marker and we show again.
            crate::tray::watch_activation(app.handle().clone());
            let data_dir = crate::config::data_dir(app.handle())
                .expect("failed to resolve the app data directory");
            let home = app.path().home_dir().unwrap_or_default();
            app.manage(crate::update::UpdateState::new(data_dir, home));
            // Agent routines run only while the app is open. A tick every 30s
            // keeps the schedule responsive without a cloud worker.
            let scheduler = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                crate::commands::routines::scheduler_tick(scheduler.clone()).await;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    crate::commands::routines::scheduler_tick(scheduler.clone()).await;
                }
            });
            // Event-triggered routines are drained on boot and every 5s.
            let event_scheduler = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                crate::commands::routines::event_tick(event_scheduler.clone()).await;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    crate::commands::routines::event_tick(event_scheduler.clone()).await;
                }
            });
            // Routine executions wait for their agent's primary conversation.
            // The queue is persistent; a 2s tick starts the next pending turn.
            let routine_queue = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                crate::commands::routines::routine_queue_tick(routine_queue.clone()).await;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    crate::commands::routines::routine_queue_tick(routine_queue.clone()).await;
                }
            });
            // Delegated tasks are latency-sensitive: pick them up quickly while
            // still respecting the concurrency governor.
            let task_scheduler = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    crate::commands::tasks::scheduler_tick(task_scheduler.clone()).await;
                }
            });
            // Direct messages: deliver pending inbox rows immediately after boot
            // and every 5s while the app is open.
            let inbox_scheduler = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                crate::commands::inbox::inbox_tick(inbox_scheduler.clone()).await;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    crate::commands::inbox::inbox_tick(inbox_scheduler.clone()).await;
                }
            });
            // Orphan containers and audit sessions from a previous process are
            // not live. Clean them once at boot; periodic cleanup would kill
            // legitimate terminal/run_code containers.
            let boot_cleanup = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = boot_cleanup.state::<crate::state::AppState>();
                let now = crate::domain::now_ms();
                let _ = state.db.sweep_agent_tasks(now);
                let _ = state.db.sweep_agent_routine_leases(now);
                let _ = state.db.finish_interrupted_agent_routine_runs(now);
                let _ = state
                    .db
                    .end_all_computer_sessions("stopped", now);
                let _ = state.db.reset_all_computer_controls();
                let _ = state
                    .db
                    .interrupt_pending_computer_actions(crate::domain::now_ms());
                let retention = crate::domain::now_ms() - 24 * 60 * 60 * 1000;
                let _ = crate::computer::prune_old_screenshots(
                    &state.data_dir.join("computer"),
                    retention,
                );
                let _ = crate::computer::prune_old_screenshots(
                    &state.data_dir.join("tool-images"),
                    retention,
                );
                if let Err(error) = crate::commands::docker::cleanup_containers(&state).await {
                    eprintln!("zylara: limpeza de containers no boot falhou: {error}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::turn::run_turn,
            commands::turn::cancel_turn,
            commands::turn::cancel_all_turns,
            commands::turn::cancel_conversation,
            commands::turn::list_active_turns,
            commands::turn::list_turn_events,
            commands::docker::docker_status,
            commands::docker::docker_pull_image,
            commands::docker::docker_start_daemon,
            commands::docker::docker_validate_image,
            commands::docker::docker_cleanup,
            commands::notifications::notify_desktop,
            commands::computer::list_computer_actions,
            commands::computer::list_computer_sessions,
            commands::computer::list_active_computer_sessions,
            commands::computer::stop_computer_session,
            commands::computer::stop_all_computer_sessions,
            commands::computer::computer_screenshot_preview,
            commands::computer::tool_image_preview,
            commands::computer::computer_preview,
            commands::computer::computer_open_stream,
            commands::computer::computer_control_status,
            commands::computer::computer_start_local_stream,
            commands::computer::computer_stop_local_stream,
            commands::computer::set_computer_paused,
            commands::computer::computer_take_control,
            commands::computer::release_computer_control,
            commands::browser::browser_session_status,
            commands::browser::browser_session_open,
            commands::browser::browser_session_close,
            commands::browser::browser_tabs,
            commands::browser::browser_new_tab,
            commands::browser::browser_close_tab,
            commands::browser::browser_activate_tab,
            commands::browser::browser_navigate,
            commands::browser::browser_history,
            commands::browser::browser_frame,
            commands::browser::browser_start_stream,
            commands::browser::browser_stop_stream,
            commands::browser::browser_click_at,
            commands::browser::browser_human_input,
            commands::browser::browser_press_key,
            commands::browser::browser_insert_text,
            commands::browser::browser_snapshot,
            commands::browser::browser_take_control,
            commands::diagnostics::platform_diagnostics,
            commands::models::get_catalog,
            commands::models::refresh_catalog,
            commands::models::list_remote_models,
            commands::oauth::refresh_provider_models,
            commands::oauth::openai_login_start,
            commands::oauth::openai_login_wait,
            commands::oauth::openai_login_cancel,
            commands::oauth::openai_sign_out,
            commands::oauth::openai_auth_status,
            commands::agents::list_agents,
            commands::agents::get_agent,
            commands::agents::create_agent,
            commands::agents::update_agent,
            commands::agents::set_agent_avatar,
            commands::agents::import_agent_avatar_image,
            commands::agents::set_agent_pinned,
            commands::agents::reorder_agents,
            commands::agents::archive_agent,
            commands::agents::restore_agent,
            commands::agents::delete_agent,
            commands::agents::list_agent_threads,
            commands::agents::list_agent_memories,
            commands::agents::create_agent_memory,
            commands::agents::update_agent_memory,
            commands::agents::delete_agent_memory,
            commands::agents::clear_agent_memories,
            commands::agents::list_shared_agent_memories,
            commands::agents::delete_shared_agent_memory,
            commands::agents::get_agent_usage,
            commands::agents::list_agent_usage,
            commands::agents::get_usage_stats,
            commands::agents::duplicate_agent,
            commands::agents::export_agent,
            commands::agents::import_agent,
            commands::agents::suggest_agent,
            commands::agents::revise_agent,
            commands::routines::list_agent_routines,
            commands::routines::list_all_agent_routines,
            commands::routines::list_agent_routine_runs,
            commands::routines::create_agent_routine,
            commands::routines::update_agent_routine,
            commands::routines::set_agent_routine_enabled,
            commands::routines::delete_agent_routine,
            commands::routines::run_agent_routine_now,
            commands::channels::list_agent_channels,
            commands::channels::reorder_agent_channels,
            commands::channels::create_agent_channel,
            commands::channels::update_agent_channel,
            commands::channels::delete_agent_channel,
            commands::channels::list_agent_channel_messages,
            commands::inbox::list_agent_channel_inbox_counts,
            commands::channels::post_agent_channel_message,
            commands::tasks::list_agent_tasks,
            commands::tasks::get_agent_task,
            commands::tasks::create_agent_task,
            commands::tasks::cancel_agent_task,
            commands::tasks::resume_agent_task,
            commands::tasks::reassign_agent_task,
            commands::tasks::run_agent_task_now,
            commands::conversations::list_conversations,
            commands::conversations::list_subagent_conversations,
            commands::conversations::create_conversation,
            commands::conversations::get_conversation,
            commands::cache::get_cache_stats,
            commands::conversations::rename_conversation,
            commands::conversations::delete_conversation,
            commands::conversations::set_conversation_pinned,
            commands::conversations::reorder_conversations,
            commands::conversations::set_conversation_code_linked,
            commands::conversations::set_conversation_model,
            commands::conversations::search_conversations,
            commands::conversations::truncate_conversation,
            commands::conversations::export_conversation,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::set_provider_key,
            commands::settings::app_info,
            commands::settings::open_data_dir,
            commands::settings::reset_app_data,
            commands::settings::validate_provider,
            commands::settings::get_code_environment,
            commands::settings::open_skills_dir,
            commands::themes::list_themes,
            commands::themes::install_theme,
            commands::themes::uninstall_theme,
            commands::themes::get_theme_asset,
            commands::themes::open_themes_dir,
            /* -------- atualizações -------- */
            commands::update::update_status,
            commands::update::check_for_update,
            commands::update::get_update_notes,
            commands::update::download_update,
            commands::update::cancel_update_download,
            commands::update::install_update,
            commands::update::reveal_update,
            commands::update::set_update_preferences,
            commands::update::skip_update_version,
            commands::update::mark_update_notified,
            commands::update::acknowledge_update_result,
            commands::skills::get_skills,
            commands::skills::set_skill_enabled,
            commands::skills::delete_skill,
            commands::skills::get_skill_content,
            commands::skills::save_skill,
            commands::skills::list_skill_versions,
            commands::attachments::import_attachments,
            commands::attachments::get_attachment,
            commands::attachments::delete_attachment,
            commands::attachments::import_clipboard_attachments,
            commands::attachments::get_attachment_content,
            commands::attachments::get_attachment_preview,
            commands::attachments::get_attachment_thumbnail,
            commands::artifacts::list_artifacts,
            commands::artifacts::list_library_artifacts,
            commands::artifacts::import_library_files,
            commands::artifacts::rename_artifact,
            commands::artifacts::set_artifact_favorite,
            commands::artifacts::get_artifact_thumbnail,
            commands::artifacts::get_artifact_content,
            commands::artifacts::get_artifact_preview,
            commands::artifacts::save_artifact,
            commands::artifacts::open_artifact,
            commands::artifacts::delete_artifact,
            /* -------- harness de código: workspace -------- */
            commands::workspace::pick_workspace_folder,
            commands::workspace::add_workspace,
            commands::workspace::list_workspaces,
            commands::workspace::reorder_workspaces,
            commands::workspace::get_workspace_context,
            commands::workspace::rename_workspace,
            commands::workspace::remove_workspace,
            commands::workspace::set_workspace_trusted,
            commands::workspace::set_conversation_workspace,
            commands::workspace::open_workspace_in_explorer,
            commands::workspace::list_workspace_files,
            commands::workspace::refresh_workspace_tree,
            commands::workspace::watch_workspace,
            commands::workspace::unwatch_workspace,
            commands::workspace::search_workspace_files,
            commands::workspace::read_workspace_file,
            /* -------- harness de código: sessão -------- */
            commands::code::get_code_session_state,
            commands::code::set_permission_mode,
            commands::code::set_plan_mode,
            commands::code::respond_approval,
            commands::code::respond_question,
            commands::code::mcp_status,
            commands::code::list_approval_rules,
            commands::code::save_approval_rule,
            commands::code::delete_approval_rule,
            commands::code::get_workspace_changes,
            commands::code::get_file_diff,
            commands::code::get_file_diff_head,
            commands::code::get_file_diff_at,
            commands::code::revert_file,
            commands::code::revert_turn,
            commands::code::compact_session,
            /* -------- harness de código: objetivo (Goal) -------- */
            commands::code::create_goal,
            commands::code::update_goal,
            commands::code::list_goal_rounds,
            commands::code::goal_can_continue,
            /* -------- harness de código: jobs em background -------- */
            commands::code::list_jobs,
            commands::code::get_job_output,
            commands::code::kill_job,
            /* -------- harness de código: git -------- */
            commands::git::git_status,
            commands::git::git_compare,
            commands::git::git_fetch,
            commands::git::git_pull,
            commands::git::git_push,
            commands::git::git_diff,
            commands::git::git_stage,
            commands::git::git_stage_all,
            commands::git::git_unstage,
            commands::git::git_unstage_all,
            commands::git::git_discard,
            commands::git::git_commit,
            commands::git::git_branches,
            commands::git::git_create_branch,
            commands::git::git_switch_branch,
            commands::git::git_log,
            commands::git::git_commit_detail,
            commands::git::suggest_commit_message,
            /* -------- GitHub: PRs e Issues -------- */
            commands::github::github_account,
            commands::github::github_set_token,
            commands::github::github_clear_token,
            commands::github::github_connection,
            commands::github::github_list_pull_requests,
            commands::github::github_list_issues,
            commands::github::github_pull_request,
            commands::github::github_pull_request_files,
            commands::github::github_pull_request_commits,
            commands::github::github_issue,
            commands::github::github_labels,
            commands::github::github_assignable_users,
            commands::github::github_milestones,
            commands::github::github_branches,
            commands::github::github_create_pull_request,
            commands::github::github_update_pull_request,
            commands::github::github_merge_pull_request,
            commands::github::github_request_reviewers,
            commands::github::github_mark_pull_request_ready,
            commands::github::github_submit_review,
            commands::github::github_checkout_pull_request,
            commands::github::github_create_issue,
            commands::github::github_update_issue,
            commands::github::github_add_comment,
            commands::github::github_update_comment,
            commands::github::github_delete_comment,
            commands::github::github_set_labels,
            commands::github::github_set_assignees,
            /* -------- terminal PTY -------- */
            commands::terminal::open_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::kill_terminal,
            commands::terminal::close_terminal,
            commands::terminal::list_terminals,
        ])
        .build(context)
        .expect("error while building Zylara");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { code: None, api, .. } => {
            // User close (X/Alt+F4/Cmd+Q). Keep the process alive just long
            // enough for cancelled turns to persist their partial state. The
            // close-to-tray path prevents the close before reaching here.
            if app_handle.try_state::<state::AppState>().is_none() {
                return;
            }
            api.prevent_exit();
            begin_graceful_exit(app_handle);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => crate::tray::show_main_window(app_handle),
        tauri::RunEvent::Exit => {
            // PTYs use ConPTY and have no OS-level job object: kill the process
            // trees explicitly so no `npm run dev`/build survives the app.
            if let Some(state) = app_handle.try_state::<state::AppState>() {
                state.terminals.close_all();
            }
            crate::computer::browser::global().map(|browser| browser.close_all());
        }
        _ => {}
    });
}
