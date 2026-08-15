use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FallbackCandidate {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(default)]
    pub health_score: Option<f64>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub line_key: Option<String>,
    #[serde(default)]
    pub parse_attempt: Option<u32>,
    #[serde(default)]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackFallbackState {
    pub mode: String,
    pub status: String,
    pub trigger: Option<String>,
    pub reason: Option<String>,
    pub current: Option<FallbackCandidate>,
    pub next: Option<FallbackCandidate>,
    pub attempts: u32,
    pub max_attempts: u32,
    pub tried: Vec<String>,
    pub started_at: Option<i64>,
    pub deadline_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackFallbackDecision {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<FallbackCandidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackFallbackResult {
    pub state: PlaybackFallbackState,
    pub decision: PlaybackFallbackDecision,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackFallbackPayload {
    pub action: String,
    pub session_id: String,
    #[serde(default)]
    pub candidates: Vec<FallbackCandidate>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub trigger: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(default)]
    pub max_attempts: Option<u32>,
    #[serde(default)]
    pub total_timeout_ms: Option<i64>,
    #[serde(default)]
    pub at: Option<i64>,
}

struct Coordinator {
    candidates: Vec<FallbackCandidate>,
    tried: Vec<String>,
    state: PlaybackFallbackState,
}

#[derive(Default)]
pub struct PlaybackFallbackRegistry {
    sessions: Mutex<HashMap<String, Coordinator>>,
}

impl PlaybackFallbackRegistry {
    pub fn handle(
        &self,
        payload: PlaybackFallbackPayload,
    ) -> Result<PlaybackFallbackResult, String> {
        let session_id = payload.session_id.trim();
        if session_id.is_empty() {
            return Err("PLAYBACK_FALLBACK_SESSION_ID_EMPTY".to_string());
        }
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "PLAYBACK_FALLBACK_STATE_POISONED".to_string())?;
        let at = payload.at.unwrap_or_else(now_millis);

        if payload.action == "begin" {
            let mode = valid_mode(payload.mode.as_deref().unwrap_or("prompt"))?;
            let max_attempts = payload.max_attempts.unwrap_or(4).max(1);
            let total_timeout_ms = payload.total_timeout_ms.unwrap_or(30_000).max(1);
            let candidates = prepare_candidates(payload.candidates);
            let state = initial_state(&mode, max_attempts);
            let state = PlaybackFallbackState {
                started_at: Some(at),
                deadline_at: Some(at.saturating_add(total_timeout_ms)),
                ..state
            };
            sessions.insert(
                session_id.to_string(),
                Coordinator {
                    candidates,
                    tried: Vec::new(),
                    state: state.clone(),
                },
            );
            return Ok(result(state, none_decision()));
        }

        if payload.action == "clear" {
            sessions.remove(session_id);
            return Ok(result(initial_state("prompt", 4), none_decision()));
        }

        let coordinator = sessions
            .get_mut(session_id)
            .ok_or_else(|| "PLAYBACK_FALLBACK_SESSION_NOT_FOUND".to_string())?;
        let decision = match payload.action.as_str() {
            "snapshot" => none_decision(),
            "set-mode" => {
                let mode = valid_mode(payload.mode.as_deref().unwrap_or("prompt"))?;
                coordinator.state.mode = mode.clone();
                if mode == "off" {
                    coordinator.state.status = "disabled".to_string();
                } else if coordinator.state.status == "disabled" {
                    coordinator.state.status = "idle".to_string();
                }
                none_decision()
            }
            "trigger" => trigger(
                coordinator,
                payload.trigger.as_deref().unwrap_or("player-fatal"),
                payload.reason.as_deref().unwrap_or("playback failed"),
                at,
            ),
            "approve" => {
                if coordinator.state.status != "prompt" {
                    none_decision_with_reason("no-prompt")
                } else {
                    take_next(coordinator, at)
                }
            }
            "finish" => {
                if payload.success.unwrap_or(false) {
                    coordinator.state.status = "recovered".to_string();
                    coordinator.state.current = None;
                    coordinator.state.next = None;
                } else {
                    coordinator.state.status = "idle".to_string();
                    coordinator.state.current = None;
                    coordinator.state.next = None;
                }
                none_decision()
            }
            "cancel" => {
                coordinator.state.status = "cancelled".to_string();
                coordinator.state.reason = Some(safe_reason(
                    payload.reason.as_deref().unwrap_or("user cancelled"),
                ));
                coordinator.state.current = None;
                coordinator.state.next = None;
                none_decision()
            }
            "stop" => stop(
                coordinator,
                payload.reason.as_deref().unwrap_or("fallback stopped"),
                at,
            ),
            _ => {
                return Err(format!(
                    "PLAYBACK_FALLBACK_ACTION_UNSUPPORTED:{}",
                    payload.action
                ))
            }
        };
        Ok(result(coordinator.state.clone(), decision))
    }
}

fn trigger(
    coordinator: &mut Coordinator,
    trigger_name: &str,
    reason: &str,
    at: i64,
) -> PlaybackFallbackDecision {
    if matches!(
        trigger_name,
        "user-pause" | "seek" | "single-buffer" | "short-fluctuation"
    ) {
        return none_decision_with_reason("ignored-user-event");
    }
    if coordinator.state.mode == "off" {
        coordinator.state.status = "disabled".to_string();
        coordinator.state.trigger = Some(trigger_name.to_string());
        coordinator.state.reason = Some(safe_reason(reason));
        return none_decision_with_reason("fallback-disabled");
    }
    if matches!(
        coordinator.state.status.as_str(),
        "cancelled" | "stopped" | "recovered"
    ) {
        return none_decision_with_reason(&format!("fallback-{}", coordinator.state.status));
    }
    coordinator.state.trigger = Some(trigger_name.to_string());
    coordinator.state.reason = Some(safe_reason(reason));
    if coordinator.state.mode == "prompt" {
        let Some(next) = peek_next(coordinator, at) else {
            return stop(coordinator, "no fallback candidate", at);
        };
        coordinator.state.status = "prompt".to_string();
        coordinator.state.next = Some(next.clone());
        return decision("prompt", Some(next), None);
    }
    take_next(coordinator, at)
}

fn take_next(coordinator: &mut Coordinator, at: i64) -> PlaybackFallbackDecision {
    if expired(coordinator, at) {
        return stop(coordinator, "fallback timeout", at);
    }
    if coordinator.state.attempts >= coordinator.state.max_attempts {
        return stop(coordinator, "maximum fallback attempts reached", at);
    }
    let Some(next) = peek_next(coordinator, at) else {
        return stop(coordinator, "no fallback candidate", at);
    };
    coordinator.tried.push(next.id.clone());
    coordinator.state.status = "trying".to_string();
    coordinator.state.current = Some(next.clone());
    coordinator.state.next = None;
    coordinator.state.attempts = coordinator.state.attempts.saturating_add(1);
    coordinator.state.tried = coordinator.tried.clone();
    decision("attempt", Some(next), None)
}

fn peek_next(coordinator: &Coordinator, at: i64) -> Option<FallbackCandidate> {
    if expired(coordinator, at) {
        return None;
    }
    coordinator
        .candidates
        .iter()
        .find(|candidate| !coordinator.tried.iter().any(|id| id == &candidate.id))
        .cloned()
}

fn stop(coordinator: &mut Coordinator, reason: &str, _at: i64) -> PlaybackFallbackDecision {
    let safe = safe_reason(reason);
    coordinator.state.status = "stopped".to_string();
    coordinator.state.reason = Some(safe.clone());
    coordinator.state.current = None;
    coordinator.state.next = None;
    decision("stopped", None, Some(safe))
}

fn expired(coordinator: &Coordinator, at: i64) -> bool {
    coordinator
        .state
        .deadline_at
        .is_some_and(|deadline| at > deadline)
}

fn prepare_candidates(candidates: Vec<FallbackCandidate>) -> Vec<FallbackCandidate> {
    let mut candidates: Vec<(usize, FallbackCandidate)> = candidates
        .into_iter()
        .enumerate()
        .map(|(index, mut candidate)| {
            candidate.id = safe_identifier(&candidate.id, &format!("candidate-{index}"));
            candidate.label = safe_candidate_label(&candidate.label);
            (index, candidate)
        })
        .collect();
    candidates.sort_by(|left, right| {
        kind_rank(&left.1.kind)
            .cmp(&kind_rank(&right.1.kind))
            .then_with(|| score_rank(&right.1.health_score).cmp(&score_rank(&left.1.health_score)))
            .then_with(|| left.0.cmp(&right.0))
    });
    let mut seen = HashSet::new();
    let mut sources = HashSet::new();
    let mut lines: HashMap<String, HashSet<String>> = HashMap::new();
    let mut parse_attempts = 0;
    candidates
        .into_iter()
        .filter_map(|(_, candidate)| {
            if !seen.insert(candidate.id.clone()) {
                return None;
            }
            if candidate.kind == "retry-current" || candidate.kind == "reparse-current" {
                if candidate.kind == "reparse-current" {
                    parse_attempts += 1;
                    if parse_attempts > 3 {
                        return None;
                    }
                }
                return Some(candidate);
            }
            let source = candidate
                .source_id
                .clone()
                .unwrap_or_else(|| "current".to_string());
            let line = candidate
                .line_key
                .clone()
                .unwrap_or_else(|| candidate.id.clone());
            let source_lines = lines.entry(source.clone()).or_default();
            if !sources.contains(&source) && sources.len() >= 5 {
                return None;
            }
            if !source_lines.contains(&line) && source_lines.len() >= 3 {
                return None;
            }
            sources.insert(source);
            source_lines.insert(line);
            Some(candidate)
        })
        .collect()
}

fn initial_state(mode: &str, max_attempts: u32) -> PlaybackFallbackState {
    PlaybackFallbackState {
        mode: mode.to_string(),
        status: if mode == "off" { "disabled" } else { "idle" }.to_string(),
        trigger: None,
        reason: None,
        current: None,
        next: None,
        attempts: 0,
        max_attempts,
        tried: Vec::new(),
        started_at: None,
        deadline_at: None,
    }
}

fn result(
    state: PlaybackFallbackState,
    decision: PlaybackFallbackDecision,
) -> PlaybackFallbackResult {
    PlaybackFallbackResult { state, decision }
}

fn decision(
    kind: &str,
    candidate: Option<FallbackCandidate>,
    reason: Option<String>,
) -> PlaybackFallbackDecision {
    PlaybackFallbackDecision {
        kind: kind.to_string(),
        candidate,
        reason,
    }
}

fn none_decision() -> PlaybackFallbackDecision {
    decision("none", None, None)
}

fn none_decision_with_reason(reason: &str) -> PlaybackFallbackDecision {
    decision("none", None, Some(reason.to_string()))
}

fn valid_mode(mode: &str) -> Result<String, String> {
    if matches!(mode, "off" | "prompt" | "auto") {
        Ok(mode.to_string())
    } else {
        Err(format!("PLAYBACK_FALLBACK_MODE_UNSUPPORTED:{mode}"))
    }
}

fn kind_rank(kind: &str) -> u8 {
    match kind {
        "retry-current" => 0,
        "reparse-current" => 1,
        "same-content" => 2,
        "healthier" => 3,
        _ => 4,
    }
}

fn score_rank(score: &Option<f64>) -> i64 {
    score
        .map(|value| (value * 1_000_000.0) as i64)
        .unwrap_or(i64::MIN)
}

fn safe_identifier(value: &str, fallback: &str) -> String {
    let mut result = String::new();
    for character in value.trim().chars() {
        if result.len() >= 120 {
            break;
        }
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-') {
            result.push(character);
        } else {
            result.push('_');
        }
    }
    if result.is_empty() {
        fallback.to_string()
    } else {
        result
    }
}

fn safe_candidate_label(value: &str) -> String {
    let text = value.trim();
    if text.contains("http://")
        || text.contains("https://")
        || text.contains("file://")
        || text.starts_with('/')
    {
        return "[redacted route]".to_string();
    }
    text.chars().take(80).collect::<String>()
}

fn safe_reason(value: &str) -> String {
    safe_candidate_label(value).replace(['\r', '\n'], " ")
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{FallbackCandidate, PlaybackFallbackPayload, PlaybackFallbackRegistry};

    fn candidate(id: &str, kind: &str) -> FallbackCandidate {
        FallbackCandidate {
            id: id.to_string(),
            label: id.to_string(),
            kind: kind.to_string(),
            health_score: None,
            source_id: Some("source".to_string()),
            line_key: Some(id.to_string()),
            parse_attempt: None,
            error_code: None,
        }
    }

    fn payload(action: &str) -> PlaybackFallbackPayload {
        PlaybackFallbackPayload {
            action: action.to_string(),
            session_id: "test-session".to_string(),
            candidates: Vec::new(),
            mode: None,
            trigger: None,
            reason: None,
            success: None,
            max_attempts: None,
            total_timeout_ms: None,
            at: Some(1_000),
        }
    }

    #[test]
    fn prompt_mode_requires_approval_and_enforces_attempt_limit() {
        let registry = PlaybackFallbackRegistry::default();
        let mut begin = payload("begin");
        begin.candidates = vec![
            candidate("first", "same-content"),
            candidate("second", "same-content"),
        ];
        begin.max_attempts = Some(1);
        begin.total_timeout_ms = Some(100);
        registry.handle(begin).expect("begin");

        let mut trigger = payload("trigger");
        trigger.trigger = Some("player-fatal".to_string());
        trigger.reason = Some("failed".to_string());
        let prompted = registry.handle(trigger).expect("trigger");
        assert_eq!(prompted.decision.kind, "prompt");
        assert_eq!(prompted.state.attempts, 0);

        let approved = registry.handle(payload("approve")).expect("approve");
        assert_eq!(approved.decision.kind, "attempt");
        assert_eq!(approved.state.tried, vec!["first"]);

        let mut next = payload("trigger");
        next.trigger = Some("player-fatal".to_string());
        let prompted_again = registry.handle(next).expect("second trigger");
        assert_eq!(prompted_again.decision.kind, "prompt");
        let stopped = registry.handle(payload("approve")).expect("second approve");
        assert_eq!(stopped.decision.kind, "stopped");
        assert_eq!(stopped.state.status, "stopped");
    }

    #[test]
    fn ignored_user_events_do_not_change_state_and_timeout_stops() {
        let registry = PlaybackFallbackRegistry::default();
        let mut begin = payload("begin");
        begin.candidates = vec![candidate("first", "same-content")];
        begin.total_timeout_ms = Some(10);
        registry.handle(begin).expect("begin");

        let mut ignored = payload("trigger");
        ignored.trigger = Some("user-pause".to_string());
        let result = registry.handle(ignored).expect("ignored trigger");
        assert_eq!(
            result.decision.reason.as_deref(),
            Some("ignored-user-event")
        );
        assert_eq!(result.state.status, "idle");

        let mut expired = payload("trigger");
        expired.trigger = Some("startup-timeout".to_string());
        expired.at = Some(1_011);
        let result = registry.handle(expired).expect("expired trigger");
        assert_eq!(result.decision.kind, "stopped");
        assert_eq!(result.state.status, "stopped");
    }
}
