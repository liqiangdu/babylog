use std::{
    collections::HashMap,
    net::IpAddr,
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::http::HeaderMap;

/// Simple in-memory sliding-window rate limiter. Suitable for a single-process
/// deployment; swap in Redis if you later scale horizontally.
pub struct RateLimiter {
    window: Duration,
    max_hits: u32,
    lockout_after: u32,
    lockout: Duration,
    inner: Mutex<HashMap<String, Bucket>>,
}

#[derive(Default)]
struct Bucket {
    /// Timestamps of the recent failures still inside the window.
    hits: Vec<Instant>,
    /// If set, requests are rejected until this instant.
    locked_until: Option<Instant>,
}

impl RateLimiter {
    pub fn new(window: Duration, max_hits: u32, lockout_after: u32, lockout: Duration) -> Self {
        Self {
            window,
            max_hits,
            lockout_after,
            lockout,
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Returns Some(retry_after_seconds) if the caller is currently locked out.
    pub fn check(&self, key: &str) -> Option<u64> {
        let mut map = self.inner.lock().ok()?;
        let now = Instant::now();
        let entry = map.entry(key.to_string()).or_default();
        entry.hits.retain(|t| now.duration_since(*t) < self.window);
        if let Some(until) = entry.locked_until {
            if until > now {
                return Some((until - now).as_secs().max(1));
            } else {
                entry.locked_until = None;
            }
        }
        if entry.hits.len() as u32 >= self.max_hits {
            return Some(self.window.as_secs());
        }
        None
    }

    /// Record a failed attempt. Triggers a lockout once too many hits pile up.
    pub fn register_failure(&self, key: &str) {
        let Ok(mut map) = self.inner.lock() else {
            return;
        };
        let now = Instant::now();
        let entry = map.entry(key.to_string()).or_default();
        entry.hits.retain(|t| now.duration_since(*t) < self.window);
        entry.hits.push(now);
        if entry.hits.len() as u32 >= self.lockout_after {
            entry.locked_until = Some(now + self.lockout);
        }
    }

    /// Clear the bucket for a key (e.g. on successful login).
    pub fn reset(&self, key: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.remove(key);
        }
    }

    /// Drop entries that have been idle for longer than the window + lockout.
    pub fn gc(&self) {
        let Ok(mut map) = self.inner.lock() else {
            return;
        };
        let now = Instant::now();
        map.retain(|_, b| {
            b.hits.retain(|t| now.duration_since(*t) < self.window);
            let busy = !b.hits.is_empty();
            let locked = b.locked_until.map(|u| u > now).unwrap_or(false);
            busy || locked
        });
    }
}

/// Best-effort client IP: trust `X-Forwarded-For` only when `BABYLOG_TRUST_PROXY=1`
/// (so a misconfigured deployment doesn't let attackers spoof the rate-limit key).
pub fn client_ip(headers: &HeaderMap, trust_proxy: bool, fallback: Option<IpAddr>) -> String {
    if trust_proxy {
        if let Some(v) = headers.get("x-forwarded-for").and_then(|h| h.to_str().ok()) {
            if let Some(first) = v.split(',').next() {
                let ip = first.trim();
                if !ip.is_empty() {
                    return ip.to_string();
                }
            }
        }
        if let Some(v) = headers.get("x-real-ip").and_then(|h| h.to_str().ok()) {
            if !v.trim().is_empty() {
                return v.trim().to_string();
            }
        }
    }
    fallback
        .map(|ip| ip.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}
