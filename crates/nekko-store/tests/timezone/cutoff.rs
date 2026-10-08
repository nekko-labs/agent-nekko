use super::clear_cutoff;

#[test]
fn timezone_cutoffs_match_js_date() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!("clear-cutoffs.json")).unwrap();
    for case in fixtures.as_array().unwrap() {
        let zone: chrono_tz::Tz = case["timezone"].as_str().unwrap().parse().unwrap();
        let actual = clear_cutoff(&zone, case["nowMs"].as_i64().unwrap(), case["scope"].as_str().unwrap());
        assert_eq!(actual, case["expectedMs"].as_i64().unwrap() as f64, "{}", case["name"]);
    }
}
