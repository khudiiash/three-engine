//! Fab's Cloudflare behaviour, against the live host.
//!
//!   cargo test --test fab_cloudflare -- --ignored --nocapture
//!
//! Network-gated, so `#[ignore]`d: it is a diagnostic, not part of the build.
//! Run it when the Fab panel starts reporting "bot protection is throttling
//! this client", because it separates the three things that look identical
//! from inside the editor — our request policy regressed, Cloudflare tightened,
//! or this machine's IP is in a penalty box.
//!
//! What it pins is the finding that `fetch_fab_text` is built around: getting
//! past a managed challenge is about looking like ONE CLIENT across requests,
//! not about the User-Agent. A shared `Agent` (which carries the `__cf_bm`
//! cookie and reuses the connection) plus a retry survives a burst that
//! one-shot requests do not.

const BASE: &str =
    "https://www.fab.com/i/listings/search?listing_types=3d-model&licenses=cc-by&currency=USD";

fn is_cf_challenge(body: &str) -> bool {
    body.contains("cf_challenge") || body.contains("challenge-platform")
}

/// The exact policy `fetch_fab_text` uses.
fn fetch(agent: &ureq::Agent, url: &str) -> Result<String, String> {
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(300 * attempt as u64));
        }
        match agent
            .get(url)
            .set("User-Agent", "three-engine/0.1")
            .set("Accept", "application/json")
            .call()
        {
            Ok(r) => return r.into_string().map_err(|e| e.to_string()),
            Err(ureq::Error::Status(code, r)) => {
                let body = r.into_string().unwrap_or_default();
                if is_cf_challenge(&body) {
                    continue;
                }
                return Err(format!("status {code}"));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("challenged on every attempt".into())
}

#[test]
#[ignore = "hits the live Fab API"]
fn agent_and_retry_survive_a_burst() {
    let agent = ureq::AgentBuilder::new().build();
    let mut failures = Vec::new();
    for i in 0..40 {
        match fetch(&agent, &format!("{BASE}&q=policy{i}")) {
            Ok(body) => assert!(body.starts_with('{'), "request {i} returned non-JSON"),
            Err(e) => failures.push(format!("#{i}: {e}")),
        }
    }
    assert!(failures.is_empty(), "{} of 40 failed: {:?}", failures.len(), failures);
}

#[test]
#[ignore = "hits the live Fab API"]
fn an_honest_user_agent_beats_a_browser_one() {
    // Counter-intuitive and load-bearing: Cloudflare fingerprints the TLS
    // handshake, so a browser UA that contradicts a non-browser fingerprint is
    // exactly what its bot detection is looking for. Claiming to be Chrome gets
    // this client challenged where `three-engine/0.1` is served.
    let agent = ureq::AgentBuilder::new().build();
    let browser = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                   (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    let lying = agent.get(BASE).set("User-Agent", browser).call();
    let honest = fetch(&agent, BASE);
    assert!(honest.is_ok(), "the honest UA should be served: {honest:?}");
    if let Err(ureq::Error::Status(code, _)) = lying {
        assert_eq!(code, 403, "expected the browser UA to be challenged");
    } else {
        eprintln!("note: the browser UA was NOT challenged this run — Cloudflare may have relaxed");
    }
}
