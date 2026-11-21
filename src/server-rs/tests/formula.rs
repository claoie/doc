//! Holds `common/formula.rs` to the TypeScript, through
//! `fixtures/formula.json` (written by `fixtures/gen-formula.ts`), and ports
//! the cases of `src/common/formula.test.ts`.

mod support;

use doc_server::common::bases::Property;
use doc_server::common::formula::{
    affected_formulas, compile_formula, compute_formulas, function_names, is_error_value, rename_in_source, FormulaSyntaxError,
};
use doc_server::jsutil::js_json;
use serde_json::{json, Map, Value};
use support::{assert_none, dec_value, decode, fixture, use_utc};

/// A property from the fixture's `[id, name, type, options]`.
fn property(compact: &Value) -> Property {
    Property {
        id: compact[0].as_str().unwrap().to_owned(),
        name: compact[1].as_str().unwrap().to_owned(),
        type_: compact[2].as_str().unwrap().to_owned(),
        options: compact[3].as_object().unwrap().clone(),
        is_primary: false,
        position: compact[0].as_str().unwrap().to_owned(),
    }
}

fn properties(list: &Value) -> Vec<Property> {
    list.as_array().unwrap().iter().map(property).collect()
}

fn prop(id: &str, name: &str, type_: &str, options: Value) -> Property {
    property(&json!([id, name, type_, options]))
}

struct Row {
    cells: Map<String, Value>,
    created_at: String,
    updated_at: String,
}

struct Fixture {
    json: Value,
    outcomes: Vec<String>,
    base: Vec<Property>,
    rows: Vec<Row>,
    now: f64,
}

/// How the generator writes a compilation: `<resultType>|<dependencies>` or `!<message>[@start,end]`.
fn compile_outcome(source: &str, props: &[Property], self_id: Option<&str>) -> (String, Value) {
    match compile_formula(source, props, self_id) {
        Ok(compiled) => (
            format!("{}|{}", compiled.result_type, compiled.dependencies.join(",")),
            json!({ "source": source, "resultType": compiled.result_type, "dependencies": compiled.dependencies }),
        ),
        Err(error) => {
            (format!("!{}{}", error.message, error.span.map_or(String::new(), |(start, end)| format!("@{start},{end}"))), json!({ "source": source }))
        }
    }
}

/// Compiles `source` as formula `f` over `props` and computes it for a row: the two outcomes.
fn evaluate(source: &str, props: &[Property], cells: &Map<String, Value>, created_at: &str, updated_at: &str, now: f64) -> (String, String) {
    let (compiled, options) = compile_outcome(source, props, Some("f"));
    let mut all = props.to_vec();
    all.push(prop("f", "F", "formula", options));
    let out = compute_formulas(&all, cells, created_at, updated_at, Some(&["f".to_owned()]), now);
    assert_eq!(out.len(), 1, "{source}");
    (compiled, js_json(&out["f"]))
}

/// Outcomes the port cannot reproduce: JavaScript cut a surrogate pair in half.
const HALF_CHARACTER: &str = "~";

#[derive(Default)]
struct Tally {
    compared: usize,
    half_characters: usize,
    mismatches: Vec<String>,
}

impl Tally {
    fn check(&mut self, what: impl FnOnce() -> String, expected: &str, actual: &str) {
        if expected == HALF_CHARACTER {
            self.half_characters += 1;
            return;
        }
        self.compared += 1;
        if expected != actual {
            self.mismatches.push(format!("{}: expected {expected}, got {actual}", what()));
        }
    }

    fn finish(self, what: &str, at_least: usize) {
        println!("{what}: {} compared, {} skipped for half characters, {} differ", self.compared, self.half_characters, self.mismatches.len());
        assert!(self.compared >= at_least, "only {} {what}", self.compared);
        assert_none(what, &self.mismatches);
    }
}

impl Fixture {
    fn load() -> Self {
        Self::from(fixture("formula.json"))
    }

    fn from(json: Value) -> Self {
        use_utc();
        let outcomes = json["outcomes"].as_array().unwrap().iter().map(|o| o.as_str().unwrap().to_owned()).collect();
        let base = properties(&json["base"]);
        let rows = json["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| Row {
                cells: decode(&row["cells"]).as_object().unwrap().clone(),
                created_at: row["createdAt"].as_str().unwrap().to_owned(),
                updated_at: row["updatedAt"].as_str().unwrap().to_owned(),
            })
            .collect();
        let now = dec_value(&json["now"]);
        Fixture { json, outcomes, base, rows, now }
    }

    fn outcome(&self, index: &Value) -> &str {
        &self.outcomes[index.as_u64().unwrap() as usize]
    }

    /// Checks one `source` over one row of the base against two outcome indexes.
    fn check_source(&self, tally: &mut Tally, source: &str, row: usize, compiled: &Value, value: &Value) {
        let row_data = &self.rows[row];
        let (actual_compiled, actual_value) = evaluate(source, &self.base, &row_data.cells, &row_data.created_at, &row_data.updated_at, self.now);
        tally.check(|| format!("compiling {source:?}"), self.outcome(compiled), &actual_compiled);
        tally.check(|| format!("{source:?} on row {row}"), self.outcome(value), &actual_value);
    }
}

#[test]
fn function_names_match() {
    let fixture = Fixture::load();
    assert_eq!(json!(function_names()), fixture.json["functions"]);
}

#[test]
fn written_cases_match() {
    let fixture = Fixture::load();
    let mut tally = Tally::default();
    for case in fixture.json["cases"].as_array().unwrap() {
        fixture.check_source(&mut tally, case[0].as_str().unwrap(), case[1].as_u64().unwrap() as usize, &case[2], &case[3]);
    }
    tally.finish("written cases", 4_000);
}

#[test]
fn calls_and_operators_match() {
    let fixture = Fixture::load();
    let pool: Vec<&str> = fixture.json["pool"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
    let mut tally = Tally::default();
    let mut names = Vec::new();
    for group in fixture.json["calls"].as_array().unwrap() {
        let (kind, name) = (group[0].as_str().unwrap(), group[1].as_str().unwrap());
        if kind == "call" {
            names.push(name);
        }
        for case in group[2].as_array().unwrap() {
            let case = case.as_array().unwrap();
            let (args, outcomes) = case.split_at(case.len() - 2);
            let args: Vec<&str> = args.iter().map(|i| pool[i.as_u64().unwrap() as usize]).collect();
            let source = match kind {
                "call" => format!("{name}({})", args.join(", ")),
                "binary" => format!("{} {name} {}", args[0], args[1]),
                "unary" => format!("{name}{}{}", args[0], if name.ends_with('(') { ")" } else { "" }),
                other => panic!("{other}"),
            };
            fixture.check_source(&mut tally, &source, 0, &outcomes[0], &outcomes[1]);
        }
    }
    // Every function is called, with every number of arguments from none to one too many.
    assert_eq!(names, function_names());
    tally.finish("calls and operators", 25_000);
}

#[test]
fn templates_match() {
    let fixture = Fixture::load();
    let templates = &fixture.json["templates"];
    let props = properties(&templates["props"]);
    let mut tally = Tally::default();
    for kind in ["numbers", "dates", "texts"] {
        let tuples: Vec<Value> = templates[kind]["tuples"].as_array().unwrap().iter().map(decode).collect();
        for result in templates[kind]["results"].as_array().unwrap() {
            let source = result[0].as_str().unwrap();
            let (compiled, options) = compile_outcome(source, &props, Some("f"));
            tally.check(|| format!("compiling {source:?}"), fixture.outcome(&result[1]), &compiled);
            let mut all = props.clone();
            all.push(prop("f", "F", "formula", options));
            for (cells, expected) in tuples.iter().zip(result[2].as_array().unwrap()) {
                let out = compute_formulas(
                    &all,
                    cells.as_object().unwrap(),
                    "2026-01-05T10:00:00.000Z",
                    "2026-01-06T10:00:00.000Z",
                    Some(&["f".to_owned()]),
                    fixture.now,
                );
                tally.check(|| format!("{source:?} over {cells}"), fixture.outcome(expected), &js_json(&out["f"]));
            }
        }
    }
    tally.finish("template values", 12_000);
}

/// Random expressions over random rows: the seeded fuzz. The port is held
/// to every one of them; the tally prints the rate.
#[test]
fn random_expressions_match() {
    let fixture = Fixture::load();
    let mut tally = Tally::default();
    let cases = fixture.json["fuzz"].as_array().unwrap();
    let (mut compiled, mut errors) = (0, 0);
    for case in cases {
        fixture.check_source(&mut tally, case[0].as_str().unwrap(), case[1].as_u64().unwrap() as usize, &case[2], &case[3]);
        compiled += usize::from(!fixture.outcome(&case[2]).starts_with('!'));
        errors += usize::from(fixture.outcome(&case[3]).starts_with("{\"error\""));
    }
    // The generator aims for mostly well-typed sources, so evaluation is exercised, not only the checker.
    assert!(compiled > cases.len() / 3, "{compiled} of {} compile", cases.len());
    assert!(errors > cases.len() / 10 && errors < cases.len() * 9 / 10, "{errors} error values");
    tally.finish("random expressions", 6_000);
}

/// A longer run of random expressions than the repository carries: see `fixtures/gen-formula.ts`.
#[test]
#[ignore = "needs FORMULA_EXTRA, the file a `gen-formula.ts --extra` run wrote"]
fn random_expressions_match_on_an_extra_corpus() {
    let path = std::env::var("FORMULA_EXTRA").expect("FORMULA_EXTRA");
    let fixture = Fixture::from(serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap());
    let mut tally = Tally::default();
    for case in fixture.json["fuzz"].as_array().unwrap() {
        fixture.check_source(&mut tally, case[0].as_str().unwrap(), case[1].as_u64().unwrap() as usize, &case[2], &case[3]);
    }
    tally.finish("random expressions", 1);
}

#[test]
fn scenarios_match() {
    let fixture = Fixture::load();
    let mut tally = Tally::default();
    for scenario in fixture.json["scenarios"].as_array().unwrap() {
        let props = properties(&scenario["props"]);
        let cells = decode(&scenario["cells"]);
        let only: Option<Vec<String>> = scenario["only"].as_array().map(|ids| ids.iter().map(|id| id.as_str().unwrap().to_owned()).collect());
        let out = compute_formulas(
            &props,
            cells.as_object().unwrap(),
            scenario["createdAt"].as_str().unwrap(),
            scenario["updatedAt"].as_str().unwrap(),
            only.as_deref(),
            dec_value(&scenario["now"]),
        );
        tally.check(|| scenario["label"].as_str().unwrap().to_owned(), scenario["out"].as_str().unwrap(), &js_json(&Value::Object(out)));
    }
    tally.finish("scenarios", 60);
}

#[test]
fn compilations_match() {
    let fixture = Fixture::load();
    let sets = fixture.json["templates"]["sets"].as_object().unwrap();
    let mut tally = Tally::default();
    for case in fixture.json["compiles"].as_array().unwrap() {
        let props = properties(&sets[case[1].as_str().unwrap()]);
        let (source, self_id) = (case[0].as_str().unwrap(), case[2].as_str());
        let (compiled, _) = compile_outcome(source, &props, self_id);
        tally.check(|| format!("compiling {source:?} as {self_id:?} in {}", case[1]), fixture.outcome(&case[3]), &compiled);
    }
    tally.finish("compilations", 100);
}

#[test]
fn renames_match() {
    let fixture = Fixture::load();
    let cases = fixture.json["renames"].as_array().unwrap();
    assert!(cases.len() > 30);
    for case in cases {
        let text = |i: usize| case[i].as_str().unwrap();
        assert_eq!(rename_in_source(text(0), text(1), text(2)), text(3), "renameInSource({}, {}, {})", case[0], case[1], case[2]);
    }
}

#[test]
fn affected_formulas_match() {
    let fixture = Fixture::load();
    let graphs = fixture.json["graphs"].as_object().unwrap();
    let cases = fixture.json["affected"].as_array().unwrap();
    assert!(cases.len() > 100);
    for case in cases {
        let props = properties(&graphs[case[0].as_str().unwrap()]);
        let changed: Vec<String> = case[1].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_owned()).collect();
        assert_eq!(json!(affected_formulas(&props, &changed)), case[2], "affectedFormulas({}, {})", case[0], case[1]);
    }
}

/// `UPPER`, `LOWER` and the folding of names rest on the case mappings of
/// single characters, which come from the Unicode tables of the two
/// runtimes. Every character is checked against what Bun maps it to.
#[test]
fn case_mappings_match() {
    let fixture = Fixture::load();
    let table = |name: &str| -> std::collections::HashMap<u32, String> {
        fixture.json[name].as_array().unwrap().iter().map(|pair| (pair[0].as_u64().unwrap() as u32, pair[1].as_str().unwrap().to_owned())).collect()
    };
    let (upper, lower) = (table("upper"), table("lower"));
    assert!(upper.len() > 1_000 && lower.len() > 1_000);
    let mut mismatches = Vec::new();
    for ch in (0..=0x10FFFF).filter_map(char::from_u32) {
        let expected_upper = upper.get(&(ch as u32)).cloned().unwrap_or_else(|| ch.to_string());
        let expected_lower = lower.get(&(ch as u32)).cloned().unwrap_or_else(|| ch.to_string());
        if ch.to_string().to_uppercase() != expected_upper {
            mismatches.push(format!("U+{:04X} toUpperCase: expected {expected_upper:?}, got {:?}", ch as u32, ch.to_string().to_uppercase()));
        }
        if ch.to_string().to_lowercase() != expected_lower {
            mismatches.push(format!("U+{:04X} toLowerCase: expected {expected_lower:?}, got {:?}", ch as u32, ch.to_string().to_lowercase()));
        }
    }
    println!("case mappings (Bun has Unicode {}): {} differ", fixture.json["unicode"], mismatches.len());
    assert_none("case mappings", &mismatches);
}

#[test]
fn error_values_match() {
    let fixture = Fixture::load();
    for case in fixture.json["errorValues"].as_array().unwrap() {
        assert_eq!(json!(is_error_value(&case[0])), case[1], "{}", case[0]);
    }
}

// ---------------------------------------------------------------------------
// Where JavaScript cuts a surrogate pair in half, so does the port: the half
// rides in a carrier (see `jsutil`) and is written as JavaScript writes it.
// The fixture marks these cases `~`; the values here were read off Bun.

#[test]
fn half_characters_are_cut_as_javascript_cuts_them() {
    use_utc();
    let run = |source: &str| evaluate(source, &[], &Map::new(), "", "", 0.0);
    assert_eq!(run("LEFT(\"😀abc\", 1)").1, r#""\ud83d""#);
    assert_eq!(run("LEFT(\"a😀bc\", 2)").1, r#""a\ud83d""#);
    assert_eq!(run("RIGHT(\"abc😀\", 1)").1, r#""\ude00""#);
    assert_eq!(run("MID(\"a😀b\", 2, 1)").1, r#""\ud83d""#);
    assert_eq!(run("MID(\"a😀b\", 3, 1)").1, r#""\ude00""#);
    assert_eq!(run("REPLACE(\"a😀b\", 2, 1, \"X\")").1, r#""aX\ude00b""#);
    assert_eq!(run("SPLITPART(\"a😀b\", \"\", 2)").1, r#""\ud83d""#);
    assert_eq!(run("SPLITPART(\"a😀b\", \"\", 3)").1, r#""\ude00""#);
    // Two halves put back together are the character again.
    assert_eq!(run("LEFT(\"😀\", 1) & RIGHT(\"😀\", 1)").1, "\"😀\"");
    assert_eq!(run("LEN(LEFT(\"😀\", 1))").1, "1");
    // The message names the whole character (JavaScript names its first half); the span is the one code unit JavaScript reports.
    assert_eq!(run("1 + 😀").0, "!Unexpected character \"😀\"@4,5");
}

/// JavaScript refuses to build a string of 2^31 code units ("Out of
/// memory", a RangeError, which is stored as the "too deeply nested" error).
/// The port answers the same, at a quarter of a gigabyte already and before
/// allocating anything.
#[test]
fn text_that_grows_too_long_is_an_error() {
    use_utc();
    let joined = |name: &str| vec![format!("prop(\"{name}\")"); 900].join("&");
    let props = [
        prop("a", "A", "formula", json!({ "source": "REPEAT(\"x\", 10000)" })),
        prop("b", "B", "formula", json!({ "source": joined("A") })),
        prop("c", "C", "formula", json!({ "source": joined("B") })),
        prop("d", "D", "formula", json!({ "source": "LEN(prop(\"B\"))" })),
        prop("e", "E", "formula", json!({ "source": "IFERROR(LEN(prop(\"C\")), \"caught\")" })),
        prop("g", "G", "formula", json!({ "source": "LEN(SUBSTITUTE(prop(\"A\"), \"x\", prop(\"B\")))" })),
    ];
    let started = std::time::Instant::now();
    let out = compute_formulas(&props, &Map::new(), CREATED, UPDATED, None, NOW);
    let too_long = json!({ "error": "DEPTH", "message": "Formula is too deeply nested" });
    assert_eq!(out["a"].as_str().map(str::len), Some(10_000));
    assert_eq!(out["b"].as_str().map(str::len), Some(9_000_000));
    assert_eq!(out["c"], too_long);
    assert_eq!(out["d"], json!(9_000_000));
    // Not an error a formula can catch.
    assert_eq!(out["e"], too_long);
    assert_eq!(out["g"], too_long);
    // A long chain of `&` costs its length, not the square of it.
    assert!(started.elapsed() < std::time::Duration::from_secs(30), "{:?}", started.elapsed());
}

// ---------------------------------------------------------------------------
// The cases of src/common/formula.test.ts

const CREATED: &str = "2026-01-05T10:00:00.000Z";
const UPDATED: &str = "2026-01-06T10:00:00.000Z";
/// `Date.parse("2026-03-10T12:00:00Z")`
const NOW: f64 = 1_773_144_000_000.0;

fn test_props() -> Vec<Property> {
    vec![
        prop("n", "Amount", "number", json!({})),
        prop("t", "Name", "text", json!({})),
        prop("d", "Due", "date", json!({})),
        prop("c", "Done", "checkbox", json!({})),
        prop("s", "Stage", "select", json!({ "choices": [{ "id": "x", "name": "X", "color": "gray" }] })),
        prop("ca", "Created", "createdAt", json!({})),
    ]
}

/// Compiles `source` as formula `f` over `others` and evaluates it for one row.
fn run(source: &str, cells: Value, others: &[Property]) -> Value {
    use_utc();
    let compiled = compile_formula(source, others, Some("f")).unwrap_or_else(|e| panic!("{source}: {e}"));
    let mut props = others.to_vec();
    props.push(prop("f", "F", "formula", json!({ "source": source, "resultType": compiled.result_type, "dependencies": compiled.dependencies })));
    compute_formulas(&props, cells.as_object().unwrap(), CREATED, UPDATED, None, NOW)["f"].clone()
}

fn value(source: &str) -> Value {
    run(source, json!({}), &[])
}

fn compile_error(source: &str, props: &[Property]) -> FormulaSyntaxError {
    compile_formula(source, props, Some("f")).expect_err(source)
}

#[test]
fn operator_precedence() {
    assert_eq!(value("1 + 2 * 3"), json!(7));
    assert_eq!(value("-2^2"), json!(-4));
    assert_eq!(value("(-2)^2"), json!(4));
    assert_eq!(value("2^3^2"), json!(512));
    assert_eq!(value("2^-1"), json!(0.5));
    assert_eq!(value("1 < 2 and not false"), json!(true));
    assert_eq!(value("1 = 2 or 2 <> 3"), json!(true));
}

#[test]
fn float_results_are_snapped() {
    assert_eq!(value("0.1 + 0.2"), json!(0.3));
}

#[test]
fn names_are_case_insensitive_and_literals_have_aliases() {
    assert_eq!(value("if(TRUE, \"a\", \"b\")"), json!("a"));
    assert_eq!(value("isblank(blank)"), json!(true));
    assert_eq!(value("isBlank(Empty)"), json!(true));
}

#[test]
fn strings_support_both_quotes_and_escapes() {
    assert_eq!(value(r#"'it\'s' & "\"q\"""#), json!("it's\"q\""));
}

#[test]
fn errors_name_the_problem() {
    let props = test_props();
    assert_eq!(compile_error("", &props).message, "Formula is empty");
    assert_eq!(compile_error("1 +", &props).message, "The formula ended unexpectedly");
    assert_eq!(compile_error("1 + @", &props).message, "Unexpected character \"@\"");
    assert!(compile_error("Amount", &props).message.starts_with("Unknown name \"Amount\""));
    assert!(compile_error("prop(Amount)", &props).message.starts_with("prop() takes a property name in quotes"));
    assert_eq!(compile_error("prop(\"Nope\")", &props).message, "No property named \"Nope\"");
    assert_eq!(compile_error("FOO(1)", &props).message, "Unknown function \"FOO\"");
    assert_eq!(compile_error("ROUND()", &props).message, "ROUND takes between 1 and 2 arguments, but got 0");
    assert_eq!(compile_error("prop(\"Name\") + 1", &props).message, "The left side of \"+\" must be a number, not text");
    assert_eq!(compile_error("prop(\"Due\") < 3", &props).message, "Cannot compare a date with a number");
    // Spans are in UTF-16 code units of the source.
    assert_eq!(compile_error("1 + @", &props).span, Some((4, 5)));
    assert_eq!(compile_error("\"😀\" & prop(\"Nope\")", &props).span, Some((7, 19)));
    assert_eq!(compile_error("", &props).span, None);
}

#[test]
fn reads_typed_property_values() {
    let props = test_props();
    assert_eq!(run("prop(\"Amount\") * 2", json!({ "n": 21 }), &props), json!(42));
    assert_eq!(run("prop(\"name\") & \"!\"", json!({ "t": "hi" }), &props), json!("hi!"));
    assert_eq!(run("prop(\"Done\")", json!({}), &props), json!(false));
    assert_eq!(run("prop(\"Stage\") & \"\"", json!({ "s": "x" }), &props), json!(""));
}

#[test]
fn created_time_reads_from_row_metadata() {
    assert_eq!(run("YEAR(prop(\"Created\"))", json!({}), &test_props()), json!(2026));
}

#[test]
fn runtime_errors_become_error_values() {
    assert_eq!(value("1 / 0"), json!({ "error": "DIV_BY_ZERO", "message": "Cannot divide by zero" }));
    assert_eq!(value("TONUMBER(\"abc\")"), json!({ "error": "VALUE", "message": "\"abc\" is not a number" }));
    assert_eq!(value("IFERROR(1 / 0, \"none\")"), json!("none"));
    assert_eq!(value("ISERROR(1 / 0)"), json!(true));
    assert_eq!(value("false and (1 / 0) > 0"), json!(false));
    assert!(is_error_value(&value("1 / 0")));
}

#[test]
fn equality_coerces_like_a_spreadsheet() {
    assert_eq!(value("\"1\" = 1"), json!(true));
    assert_eq!(value("true = \"yes\""), json!(true));
    assert_eq!(value("\"a\" = \"A\""), json!(false));
    assert_eq!(value("\"10\" < \"9\""), json!(true));
}

#[test]
fn math_and_text_functions() {
    assert_eq!(value("ROUND(-2.5)"), json!(-3));
    assert_eq!(value("ROUND(2.345, 2)"), json!(2.35));
    assert_eq!(value("ROUNDDOWN(2.99, 1)"), json!(2.9));
    assert_eq!(value("MOD(-7, 3)"), json!(-1));
    assert_eq!(value("SUM(1, 2, 3) / AVERAGE(2, 4)"), json!(2));
    assert_eq!(value("MID(\"abcdef\", 2, 3)"), json!("bcd"));
    assert_eq!(value("SUBSTITUTE(\"a-b-c\", \"-\", \"+\")"), json!("a+b+c"));
    assert_eq!(value("REPLACE(\"abcdef\", 2, 0, \"X\")"), json!("aXbcdef"));
    assert_eq!(value("SPLITPART(\"a,b,c\", \",\", 2)"), json!("b"));
    assert_eq!(value("FIND(\"hello\", \"l\")"), json!(3));
    assert_eq!(value("JOIN(\"-\", 1, \"b\", true)"), json!("1-b-true"));
    assert_eq!(value("IFS(false, 1, true, 2)"), json!(2));
    assert_eq!(value("SWITCH(\"b\", \"a\", 1, \"b\", 2, 0)"), json!(2));
}

#[test]
fn date_functions() {
    assert_eq!(value("DATEADD(\"2026-01-31\", 1, \"month\")"), json!("2026-02-28"));
    assert_eq!(value("DATEADD(\"2026-01-31\", 1, \"day\")"), json!("2026-02-01"));
    assert_eq!(value("DATEDIFF(\"2026-01-20\", \"2026-03-15\", \"months\")"), json!(1));
    assert_eq!(value("DATEDIFF(\"2026-03-15\", \"2026-03-10\")"), json!(-5));
    assert_eq!(value("TODAY()"), json!("2026-03-10"));
    assert_eq!(value("FORMATDATE(\"2026-07-04\", \"DD/MM/YYYY\")"), json!("04/07/2026"));
    assert_eq!(value("WEEKDAY(\"2026-03-08\")"), json!(1));
    assert_eq!(value("DATEADD(\"2026-01-01\", 1, \"fortnight\")")["error"], json!("VALUE"));
    assert_eq!(value("YEAR(\"\")"), json!({ "error": "TYPE", "message": "YEAR expects a date" }));
}

#[test]
fn formulas_can_use_other_formulas_but_not_loop() {
    let mut props = test_props();
    props.push(prop("a", "A", "formula", json!({ "source": "prop(\"Amount\") + 1", "dependencies": ["n"], "resultType": "number" })));
    assert_eq!(run("prop(\"A\") * 10", json!({ "n": 1 }), &props), json!(20));
    let mut props = test_props();
    props.push(prop("b", "B", "formula", json!({ "source": "prop(\"F\")", "dependencies": ["f"], "resultType": "null" })));
    assert!(compile_error("prop(\"B\")", &props).message.contains("circular reference"));
}

#[test]
fn a_deleted_dependency_yields_an_error_value() {
    use_utc();
    let f = prop("f", "F", "formula", json!({ "source": "prop(\"Gone\") + 1", "dependencies": ["g"], "resultType": "number" }));
    let out = compute_formulas(&[f], &Map::new(), CREATED, UPDATED, None, NOW);
    assert_eq!(out["f"]["error"], json!("MISSING_PROP"));
}

#[test]
fn rewrites_only_matching_references() {
    assert_eq!(
        rename_in_source("prop(\"Amount\") + prop( \"amount\" ) & \"Amount\"", "Amount", "Total \"net\""),
        "prop(\"Total \\\"net\\\"\") + prop( \"Total \\\"net\\\"\" ) & \"Amount\""
    );
}
