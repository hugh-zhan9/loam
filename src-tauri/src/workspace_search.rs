use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::State;

use crate::models::{
    SearchResultItem, WorkspaceError, WorkspaceSearchCancelResult, WorkspaceSearchResult,
};
use crate::path_guard::{
    canonicalize_workspace_root, is_allowed_markdown_file, is_ignored_dir, resolve_candidate_path,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchRequest {
    pub root_path: String,
    pub query: String,
    pub case_sensitive: bool,
    pub max_file_bytes: u64,
    pub max_results: usize,
    pub max_matches_per_file: usize,
    pub dirty_overrides: Vec<DirtySearchOverride>,
    pub request_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtySearchOverride {
    pub path: String,
    pub markdown: String,
}

#[derive(Default)]
pub struct WorkspaceSearchState {
    active: HashMap<String, Arc<AtomicBool>>,
}

impl WorkspaceSearchState {
    fn start(&mut self, request_id: &str) -> Result<Arc<AtomicBool>, WorkspaceError> {
        if self.active.contains_key(request_id) {
            return Err(WorkspaceError::new(
                "search_failed",
                "workspace search request is already active",
            ));
        }

        let cancel_token = Arc::new(AtomicBool::new(false));
        self.active
            .insert(request_id.to_string(), cancel_token.clone());
        Ok(cancel_token)
    }

    fn cancel(&mut self, request_id: &str) -> Result<(), WorkspaceError> {
        let Some(cancel_token) = self.active.get(request_id) else {
            return Err(WorkspaceError::new(
                "search_request_not_found",
                "workspace search request was not found",
            ));
        };

        cancel_token.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn finish(&mut self, request_id: &str) {
        self.active.remove(request_id);
    }
}

#[tauri::command]
pub async fn workspace_search(
    request: WorkspaceSearchRequest,
    state: State<'_, Mutex<WorkspaceSearchState>>,
) -> Result<WorkspaceSearchResult, WorkspaceError> {
    let request_id = request.request_id.clone();
    let cancel_token = {
        let mut state = state.lock().map_err(|_| {
            WorkspaceError::new("search_failed", "workspace search state lock poisoned")
        })?;
        state.start(&request_id)?
    };

    let join_result = tauri::async_runtime::spawn_blocking(move || {
        workspace_search_with_cancel(request, cancel_token)
    })
    .await;

    {
        let mut state = state.lock().map_err(|_| {
            WorkspaceError::new("search_failed", "workspace search state lock poisoned")
        })?;
        state.finish(&request_id);
    }

    join_result.map_err(|error| {
        WorkspaceError::new(
            "background_task_failed",
            format!("failed to join workspace search task: {error}"),
        )
    })?
}

#[tauri::command]
pub fn workspace_search_cancel(
    request_id: String,
    state: State<'_, Mutex<WorkspaceSearchState>>,
) -> Result<WorkspaceSearchCancelResult, WorkspaceError> {
    let mut state = state.lock().map_err(|_| {
        WorkspaceError::new(
            "search_cancel_failed",
            "workspace search state lock poisoned",
        )
    })?;
    state.cancel(&request_id)?;

    Ok(WorkspaceSearchCancelResult { cancelled: true })
}

#[cfg(test)]
pub(crate) fn workspace_search_sync(
    request: WorkspaceSearchRequest,
) -> Result<WorkspaceSearchResult, WorkspaceError> {
    let cancel_token = Arc::new(AtomicBool::new(false));
    workspace_search_with_cancel_and_after_scan(request, cancel_token, |_| Ok(()))
}

#[cfg(test)]
pub(crate) fn workspace_search_sync_after_scan(
    request: WorkspaceSearchRequest,
    after_scan: impl FnOnce(&BTreeSet<PathBuf>) -> Result<(), WorkspaceError>,
) -> Result<WorkspaceSearchResult, WorkspaceError> {
    let cancel_token = Arc::new(AtomicBool::new(false));
    workspace_search_with_cancel_and_after_scan(request, cancel_token, after_scan)
}

fn workspace_search_with_cancel(
    request: WorkspaceSearchRequest,
    cancel_token: Arc<AtomicBool>,
) -> Result<WorkspaceSearchResult, WorkspaceError> {
    workspace_search_with_cancel_and_after_scan(request, cancel_token, |_| Ok(()))
}

fn workspace_search_with_cancel_and_after_scan(
    request: WorkspaceSearchRequest,
    cancel_token: Arc<AtomicBool>,
    after_scan: impl FnOnce(&BTreeSet<PathBuf>) -> Result<(), WorkspaceError>,
) -> Result<WorkspaceSearchResult, WorkspaceError> {
    let root = canonicalize_workspace_root(&request.root_path)?;
    let query = request.query.trim().to_string();
    let mut result = WorkspaceSearchResult {
        request_id: request.request_id.clone(),
        results: Vec::new(),
        skipped_large_files: 0,
        skipped_unreadable_files: 0,
        truncated: false,
        searched_files: 0,
    };

    if query.is_empty() {
        return Ok(result);
    }

    if request.max_results == 0 {
        result.truncated = true;
        return Ok(result);
    }

    check_cancelled(&cancel_token)?;
    let dirty_overrides = dirty_override_map(&root, request.dirty_overrides)?;

    let mut candidates = BTreeSet::new();
    let mut visited_dirs = HashSet::new();
    visited_dirs.insert(root.clone());
    collect_markdown_candidates(
        &root,
        &root,
        &mut visited_dirs,
        &mut candidates,
        &cancel_token,
    )?;
    candidates.extend(dirty_overrides.keys().cloned());
    after_scan(&candidates)?;

    let matcher = QueryMatcher::new(query, request.case_sensitive);
    let mut accumulator = SearchAccumulator {
        result,
        matcher,
        cancel_token: cancel_token.clone(),
        max_results: request.max_results,
        max_matches_per_file: request.max_matches_per_file,
    };

    for path in candidates {
        check_cancelled(&cancel_token)?;

        if let Some(markdown) = dirty_overrides.get(&path) {
            accumulator.search_content(&path, markdown, true)?;
        } else {
            search_disk_file(&path, request.max_file_bytes, &mut accumulator)?;
        }

        if accumulator.result.truncated {
            break;
        }
    }

    Ok(accumulator.result)
}

fn dirty_override_map(
    root: &Path,
    overrides: Vec<DirtySearchOverride>,
) -> Result<BTreeMap<PathBuf, String>, WorkspaceError> {
    let mut dirty_overrides = BTreeMap::new();

    for override_item in overrides {
        let path = resolve_dirty_override_path(root, &override_item.path)?;
        dirty_overrides.insert(path, override_item.markdown);
    }

    Ok(dirty_overrides)
}

fn resolve_dirty_override_path(root: &Path, path: &str) -> Result<PathBuf, WorkspaceError> {
    let candidate = resolve_candidate_path(root, Path::new(path));
    if !is_allowed_markdown_file(&candidate) {
        return Err(invalid_dirty_override_path());
    }

    match fs::canonicalize(&candidate) {
        Ok(path) => {
            if !path.starts_with(root) || !is_allowed_markdown_file(&path) {
                return Err(invalid_dirty_override_path());
            }
            Ok(path)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = candidate.parent().ok_or_else(invalid_dirty_override_path)?;
            let parent = fs::canonicalize(parent).map_err(|error| {
                WorkspaceError::from_io(
                    "path_failed",
                    "failed to resolve dirty search override parent",
                    &error,
                )
            })?;
            if !parent.starts_with(root) {
                return Err(invalid_dirty_override_path());
            }
            let file_name = candidate
                .file_name()
                .ok_or_else(invalid_dirty_override_path)?;
            Ok(parent.join(file_name))
        }
        Err(error) => Err(WorkspaceError::from_io(
            "path_failed",
            "failed to resolve dirty search override path",
            &error,
        )),
    }
}

fn collect_markdown_candidates(
    root: &Path,
    dir: &Path,
    visited_dirs: &mut HashSet<PathBuf>,
    candidates: &mut BTreeSet<PathBuf>,
    cancel_token: &AtomicBool,
) -> Result<(), WorkspaceError> {
    check_cancelled(cancel_token)?;

    let entries = fs::read_dir(dir).map_err(|error| {
        WorkspaceError::from_io(
            "search_failed",
            "failed to read workspace directory",
            &error,
        )
    })?;

    for entry in entries {
        check_cancelled(cancel_token)?;

        let entry = entry.map_err(|error| {
            WorkspaceError::from_io("search_failed", "failed to read workspace entry", &error)
        })?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = entry.file_type().map_err(|error| {
            WorkspaceError::from_io("path_failed", "failed to inspect workspace entry", &error)
        })?;

        if file_type.is_symlink() {
            collect_symlink_candidate(root, &path, &name, visited_dirs, candidates, cancel_token)?;
        } else if file_type.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            collect_directory_candidate(root, &path, visited_dirs, candidates, cancel_token)?;
        } else if file_type.is_file() && is_allowed_markdown_file(&path) {
            let path = fs::canonicalize(&path).map_err(|error| {
                WorkspaceError::from_io("path_failed", "failed to resolve workspace file", &error)
            })?;
            if path.starts_with(root) {
                candidates.insert(path);
            }
        }
    }

    Ok(())
}

fn collect_symlink_candidate(
    root: &Path,
    path: &Path,
    name: &str,
    visited_dirs: &mut HashSet<PathBuf>,
    candidates: &mut BTreeSet<PathBuf>,
    cancel_token: &AtomicBool,
) -> Result<(), WorkspaceError> {
    if should_skip_dir(name) {
        return Ok(());
    }

    let Ok(path) = fs::canonicalize(path) else {
        return Ok(());
    };
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(()),
    };
    if !path.starts_with(root) || path_is_in_skipped_dir(root, &path, metadata.is_file()) {
        return Ok(());
    }

    if metadata.is_dir() {
        collect_directory_candidate(root, &path, visited_dirs, candidates, cancel_token)?;
    } else if metadata.is_file() && is_allowed_markdown_file(&path) {
        candidates.insert(path);
    }

    Ok(())
}

fn collect_directory_candidate(
    root: &Path,
    path: &Path,
    visited_dirs: &mut HashSet<PathBuf>,
    candidates: &mut BTreeSet<PathBuf>,
    cancel_token: &AtomicBool,
) -> Result<(), WorkspaceError> {
    let path = fs::canonicalize(path).map_err(|error| {
        WorkspaceError::from_io(
            "path_failed",
            "failed to resolve workspace directory",
            &error,
        )
    })?;
    if !path.starts_with(root) || path_is_in_skipped_dir(root, &path, false) {
        return Ok(());
    }
    if !visited_dirs.insert(path.clone()) {
        return Ok(());
    }

    collect_markdown_candidates(root, &path, visited_dirs, candidates, cancel_token)
}

fn should_skip_dir(name: &str) -> bool {
    name.starts_with('.') || is_ignored_dir(name)
}

fn path_is_in_skipped_dir(root: &Path, path: &Path, path_is_file: bool) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return true;
    };
    let mut components = relative.components().peekable();

    while let Some(component) = components.next() {
        if path_is_file && components.peek().is_none() {
            break;
        }

        let std::path::Component::Normal(name) = component else {
            continue;
        };
        if should_skip_dir(&name.to_string_lossy()) {
            return true;
        }
    }

    false
}

fn search_disk_file(
    path: &Path,
    max_file_bytes: u64,
    accumulator: &mut SearchAccumulator,
) -> Result<(), WorkspaceError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            accumulator.result.skipped_unreadable_files += 1;
            return Ok(());
        }
    };

    if !metadata.is_file() {
        return Ok(());
    }

    if metadata.len() > max_file_bytes {
        accumulator.result.skipped_large_files += 1;
        return Ok(());
    }

    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => {
            accumulator.result.skipped_unreadable_files += 1;
            return Ok(());
        }
    };

    if bytes.contains(&0) {
        return Ok(());
    }

    let Ok(markdown) = String::from_utf8(bytes) else {
        return Ok(());
    };
    accumulator.search_content(path, &markdown, false)?;
    Ok(())
}

struct SearchAccumulator {
    result: WorkspaceSearchResult,
    matcher: QueryMatcher,
    cancel_token: Arc<AtomicBool>,
    max_results: usize,
    max_matches_per_file: usize,
}

impl SearchAccumulator {
    fn search_content(
        &mut self,
        path: &Path,
        content: &str,
        dirty: bool,
    ) -> Result<(), WorkspaceError> {
        if self.result.truncated {
            return Ok(());
        }

        self.result.searched_files += 1;
        if self.max_matches_per_file == 0 {
            return Ok(());
        }

        let lines = content.lines().collect::<Vec<_>>();
        let mut matches_in_file = 0;

        'lines: for (index, line) in lines.iter().enumerate() {
            check_cancelled(&self.cancel_token)?;

            if matches_in_file >= self.max_matches_per_file {
                break;
            }

            let mut matches = self.matcher.matches(line);
            loop {
                if matches_in_file >= self.max_matches_per_file {
                    break 'lines;
                }
                if self.result.results.len() >= self.max_results {
                    self.result.truncated = true;
                    break 'lines;
                }

                let Some(span) = matches.next_match(&self.cancel_token)? else {
                    break;
                };

                self.result.results.push(SearchResultItem {
                    path: path_to_string(path),
                    line_number: index + 1,
                    column_start: span.column_start,
                    column_end: span.column_end,
                    line: (*line).to_string(),
                    before: index
                        .checked_sub(1)
                        .and_then(|previous| lines.get(previous))
                        .map(|line| (*line).to_string()),
                    after: lines.get(index + 1).map(|line| (*line).to_string()),
                    dirty,
                });
                matches_in_file += 1;

                if self.result.results.len() >= self.max_results {
                    self.result.truncated = true;
                    break 'lines;
                }
            }
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MatchSpan {
    column_start: usize,
    column_end: usize,
}

struct QueryMatcher {
    query: String,
    query_lower: String,
    case_sensitive: bool,
}

impl QueryMatcher {
    fn new(query: String, case_sensitive: bool) -> Self {
        let query_lower = query.to_lowercase();
        Self {
            query,
            query_lower,
            case_sensitive,
        }
    }

    fn matches<'a>(&'a self, line: &'a str) -> MatchCursor<'a> {
        MatchCursor {
            matcher: self,
            line,
            next_byte: 0,
            next_utf16: 0,
        }
    }

    fn match_at(
        &self,
        line: &str,
        start_byte: usize,
        start_utf16: usize,
        cancel_token: &AtomicBool,
    ) -> Result<Option<MatchAtResult>, WorkspaceError> {
        let needle = if self.case_sensitive {
            self.query.as_str()
        } else {
            self.query_lower.as_str()
        };

        let mut candidate = String::new();
        let mut utf16_end = start_utf16;
        let mut byte_end = start_byte;

        for character in line[start_byte..].chars() {
            check_cancelled(cancel_token)?;

            byte_end += character.len_utf8();
            utf16_end += character.len_utf16();
            if self.case_sensitive {
                candidate.push(character);
            } else {
                candidate.extend(character.to_lowercase());
            }

            if candidate == needle {
                return Ok(Some(MatchAtResult {
                    span: MatchSpan {
                        column_start: start_utf16,
                        column_end: utf16_end,
                    },
                    byte_end,
                    utf16_end,
                }));
            }

            if !needle.starts_with(&candidate) {
                return Ok(None);
            }
        }

        Ok(None)
    }
}

struct MatchAtResult {
    span: MatchSpan,
    byte_end: usize,
    utf16_end: usize,
}

struct MatchCursor<'a> {
    matcher: &'a QueryMatcher,
    line: &'a str,
    next_byte: usize,
    next_utf16: usize,
}

impl MatchCursor<'_> {
    fn next_match(
        &mut self,
        cancel_token: &AtomicBool,
    ) -> Result<Option<MatchSpan>, WorkspaceError> {
        while self.next_byte < self.line.len() {
            check_cancelled(cancel_token)?;

            if let Some(result) =
                self.matcher
                    .match_at(self.line, self.next_byte, self.next_utf16, cancel_token)?
            {
                self.next_byte = result.byte_end;
                self.next_utf16 = result.utf16_end;
                return Ok(Some(result.span));
            }

            let Some(character) = self.line[self.next_byte..].chars().next() else {
                break;
            };
            self.next_byte += character.len_utf8();
            self.next_utf16 += character.len_utf16();
        }

        Ok(None)
    }
}

fn check_cancelled(cancel_token: &AtomicBool) -> Result<(), WorkspaceError> {
    if cancel_token.load(Ordering::SeqCst) {
        return Err(WorkspaceError::new(
            "search_cancelled",
            "workspace search was cancelled",
        ));
    }
    Ok(())
}

fn invalid_dirty_override_path() -> WorkspaceError {
    WorkspaceError::new(
        "invalid_markdown_path",
        "dirty search override path must be a Markdown file inside the workspace root",
    )
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
