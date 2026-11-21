//! Holds `common/bases.rs` to the TypeScript, through `fixtures/bases.json`
//! (written by `fixtures/gen-bases.ts`).

mod support;

use std::collections::HashMap;

use doc_server::common::bases::{
    cell_text, column_kind, convert_cell, date_range, default_status_choices, is_choice_type, is_editable_type, is_filter_group, is_system_type,
    normalize_cell, normalize_cells, ColumnKind, Property, RowMeta, TextContext, CHOICE_COLORS, DATE_RANGES, FILTER_OPERATORS, LIMITS, NO_VALUE,
    OPERATORS_BY_KIND, PROPERTY_TYPES, RELATIVE_DAYS, SYSTEM_TYPES, VIEW_TYPES,
};
use doc_server::jsutil::same_json;
use serde_json::{json, Map, Value};
use support::{assert_none, dec_value, decode, enc, fixture, outcome_of, use_utc};

struct Fixture {
    json: Value,
    props: HashMap<String, Vec<Property>>,
    values: Vec<Value>,
}

impl Fixture {
    fn load() -> Self {
        use_utc();
        let json = fixture("bases.json");
        let props = json["props"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, list)| (name.clone(), list.as_array().unwrap().iter().map(|p| Property::from_json(p).expect("a property")).collect()))
            .collect();
        let values = json["values"].as_array().unwrap().iter().map(decode).collect();
        Fixture { json, props, values }
    }

    /// A property of the main set, by id; of two with one id the first.
    fn prop(&self, id: &str) -> &Property {
        self.props["all"].iter().find(|p| p.id == id).unwrap_or_else(|| panic!("no property {id}"))
    }

    /// The value at an index; -1 is `undefined`.
    fn value(&self, index: &Value) -> Option<&Value> {
        let index = index.as_i64().unwrap();
        (index >= 0).then(|| &self.values[index as usize])
    }

    fn row(&self, index: &Value) -> RowMeta<'_> {
        let row = &self.json["rows"][index.as_u64().unwrap() as usize];
        RowMeta {
            created_at: row["createdAt"].as_str().unwrap(),
            updated_at: row["updatedAt"].as_str().unwrap(),
            creator_id: row["creatorId"].as_str(),
            last_editor_id: row["lastEditorId"].as_str(),
        }
    }

    fn ctx(&self) -> TextContext {
        let ctx = &self.json["ctx"];
        TextContext {
            users: ctx["users"].as_object().unwrap().iter().map(|(id, name)| (id.clone(), name.as_str().unwrap().to_owned())).collect(),
            pages: ctx["pages"].as_object().unwrap().iter().map(|(id, title)| (id.clone(), title.as_str().map(str::to_owned))).collect(),
        }
    }
}

fn short(value: Option<&Value>) -> String {
    let text = value.map_or("undefined".to_owned(), |v| v.to_string());
    if text.chars().count() > 120 {
        format!("{}…", text.chars().take(120).collect::<String>())
    } else {
        text
    }
}

#[test]
fn constants_match() {
    let fixture = Fixture::load();
    let c = &fixture.json["constants"];
    assert_eq!(json!(PROPERTY_TYPES), c["PROPERTY_TYPES"]);
    assert_eq!(json!(SYSTEM_TYPES), c["SYSTEM_TYPES"]);
    assert_eq!(json!(VIEW_TYPES), c["VIEW_TYPES"]);
    assert_eq!(json!(FILTER_OPERATORS), c["FILTER_OPERATORS"]);
    assert_eq!(json!(RELATIVE_DAYS), c["RELATIVE_DAYS"]);
    assert_eq!(json!(DATE_RANGES), c["DATE_RANGES"]);
    assert_eq!(json!(CHOICE_COLORS), c["CHOICE_COLORS"]);
    assert_eq!(json!(NO_VALUE), c["NO_VALUE"]);
    assert_eq!(default_status_choices(), c["DEFAULT_STATUS_CHOICES"]);
    assert_eq!(
        json!({
            "text": LIMITS.text, "url": LIMITS.url, "email": LIMITS.email, "name": LIMITS.name, "choices": LIMITS.choices, "files": LIMITS.files,
            "rowsPerPage": LIMITS.rows_per_page, "sorts": LIMITS.sorts, "filterChildren": LIMITS.filter_children, "formula": LIMITS.formula,
        }),
        c["LIMITS"]
    );
    let by_kind = c["OPERATORS_BY_KIND"].as_object().unwrap();
    assert_eq!(by_kind.keys().map(String::as_str).collect::<Vec<_>>(), OPERATORS_BY_KIND.map(ColumnKind::as_str));
    for kind in OPERATORS_BY_KIND {
        assert_eq!(json!(kind.operators()), by_kind[kind.as_str()], "{}", kind.as_str());
    }
    for case in fixture.json["types"].as_array().unwrap() {
        let type_ = case[0].as_str().unwrap();
        assert_eq!(json!([is_system_type(type_), is_editable_type(type_), is_choice_type(type_)]), json!([case[1], case[2], case[3]]), "{type_}");
    }
    for case in fixture.json["filterGroups"].as_array().unwrap() {
        assert_eq!(json!(is_filter_group(&case[0])), case[1], "{}", case[0]);
    }
    assert!(!is_filter_group(&json!(null)) && !is_filter_group(&json!(["children"])));
}

#[test]
fn properties_round_trip() {
    let fixture = Fixture::load();
    for list in fixture.json["props"].as_object().unwrap().values() {
        for prop in list.as_array().unwrap() {
            assert!(same_json(Some(&Property::from_json(prop).unwrap().to_json()), Some(prop)), "{prop}");
        }
    }
    assert!(Property::from_json(&json!({"id": "a", "name": "A"})).is_none());
    assert!(Property::from_json(&json!("a")).is_none());
    let bare = Property::from_json(&json!({"id": "a", "name": "A", "type": "text"})).unwrap();
    assert!(bare.options.is_empty() && !bare.is_primary && bare.position.is_empty());
}

#[test]
fn normalize_cell_matches() {
    let fixture = Fixture::load();
    let cases = fixture.json["normalize"].as_array().unwrap();
    assert!(cases.len() > 3_000);
    let mut mismatches = Vec::new();
    for case in cases {
        let prop = fixture.prop(case[0].as_str().unwrap());
        let value = fixture.value(&case[1]);
        let actual = match normalize_cell(prop, value) {
            Ok(None) => "u".to_owned(),
            Ok(Some(value)) => outcome_of(&value),
            Err(error) => format!("!{error}"),
        };
        if actual != case[2].as_str().unwrap() {
            mismatches.push(format!("normalizeCell({} [{}], {}): expected {}, got {actual}", prop.id, prop.type_, short(value), case[2]));
        }
    }
    assert_none("normalizeCell calls", &mismatches);
}

#[test]
fn normalize_cells_matches() {
    let fixture = Fixture::load();
    let mut mismatches = Vec::new();
    for case in fixture.json["cells"].as_array().unwrap() {
        let props = &fixture.props[case[0].as_str().unwrap()];
        let patch = decode(&case[1]);
        let apply_defaults = case[2].as_bool().unwrap();
        let result = normalize_cells(props, patch.as_object().unwrap(), apply_defaults);
        let actual = match &result {
            Ok(cells) => outcome_of(&Value::Object(cells.clone())),
            Err(error) => format!("!{error}"),
        };
        if actual != case[3].as_str().unwrap() {
            mismatches.push(format!("normalizeCells({}, {}, {apply_defaults}): expected {}, got {actual}", case[0], short(Some(&patch)), case[3]));
        }
    }
    assert_none("normalizeCells calls", &mismatches);
}

#[test]
fn normalize_cells_keeps_javascript_key_order() {
    let fixture = Fixture::load();
    let props = &fixture.props["order"];
    let patch: Map<String, Value> = serde_json::from_str(r#"{"b":"1","10":"2","a":"3","2":"4","01":"5","1.5":"6"}"#).unwrap();
    let cells = normalize_cells(props, &patch, false).unwrap();
    assert_eq!(cells.keys().map(String::as_str).collect::<Vec<_>>(), ["2", "10", "b", "a", "01", "1.5"]);
    // Defaults follow, in property order.
    let props = &fixture.props["defaults"];
    let cells = normalize_cells(props, &Map::new(), true).unwrap();
    assert_eq!(cells.keys().map(String::as_str).collect::<Vec<_>>(), ["d1", "d2", "d4", "d6", "d8", "d11", "d12", "d14", "d17", "d21", "d22", "d23"]);
}

#[test]
fn cell_text_matches() {
    let fixture = Fixture::load();
    let (known, unknown) = (fixture.ctx(), TextContext::default());
    let mut mismatches = Vec::new();
    let mut count = 0;
    for case in fixture.json["text"].as_array().unwrap() {
        let prop = fixture.prop(case[0].as_str().unwrap());
        let value = fixture.value(&case[1]);
        let actual = outcome_of(&Value::String(cell_text(prop, value, &fixture.row(&case[2]), &known)));
        count += 1;
        if actual != case[3].as_str().unwrap() {
            mismatches.push(format!("cellText({} [{}], {}, row {}): expected {}, got {actual}", prop.id, prop.type_, short(value), case[2], case[3]));
        }
    }
    for case in fixture.json["textUnknown"].as_array().unwrap() {
        let prop = fixture.prop(case[0].as_str().unwrap());
        let value = fixture.value(&case[1]);
        let actual = outcome_of(&Value::String(cell_text(prop, value, &fixture.row(&json!(0)), &unknown)));
        count += 1;
        if actual != case[2].as_str().unwrap() {
            mismatches.push(format!("cellText({} [{}], {}) without names: expected {}, got {actual}", prop.id, prop.type_, short(value), case[2]));
        }
    }
    assert!(count > 4_000);
    assert_none("cellText calls", &mismatches);
}

#[test]
fn convert_cell_matches() {
    let fixture = Fixture::load();
    let ctx = fixture.ctx();
    let row = fixture.row(&json!(1));
    let targets = fixture.json["targets"].as_array().unwrap();
    let mut mismatches = Vec::new();
    let mut count = 0;
    for case in fixture.json["convert"].as_array().unwrap() {
        let from = fixture.prop(case[0].as_str().unwrap());
        // A case without a value is `undefined`.
        let (value, outcomes) = if case.as_array().unwrap().len() == 3 { (Some(decode(&case[1])), &case[2]) } else { (None, &case[1]) };
        for (target, expected) in targets.iter().zip(outcomes.as_array().unwrap()) {
            let to_type = target[0].as_str().unwrap();
            let actual = match convert_cell(value.as_ref(), from, to_type, target[1].as_object().unwrap(), &row, &ctx) {
                Ok(value) => outcome_of(&value),
                Err(error) => format!("!{error}"),
            };
            count += 1;
            if actual != expected.as_str().unwrap() {
                mismatches.push(format!(
                    "convertCell({}, {} [{}] -> {to_type} {}): expected {expected}, got {actual}",
                    short(value.as_ref()),
                    from.id,
                    from.type_,
                    target[1]
                ));
            }
        }
    }
    assert!(count > 4_000);
    assert_none("convertCell calls", &mismatches);
}

#[test]
fn date_range_matches() {
    let fixture = Fixture::load();
    let nows: Vec<f64> = fixture.json["nows"].as_array().unwrap().iter().map(dec_value).collect();
    let offsets: Vec<f64> = fixture.json["offsets"].as_array().unwrap().iter().map(dec_value).collect();
    let mut mismatches = Vec::new();
    let mut count = 0;
    for case in fixture.json["ranges"].as_array().unwrap() {
        // A case without a value is `undefined`.
        let (value, results) = if case.as_array().unwrap().len() == 2 { (Some(decode(&case[0])), &case[1]) } else { (None, &case[0]) };
        for result in results.as_array().unwrap() {
            let now = nows[result[0].as_u64().unwrap() as usize];
            // The TypeScript default for a missing offset is 0.
            let offset = result[1].as_u64().map_or(0.0, |index| offsets[index as usize]);
            let actual = date_range(value.as_ref(), now, offset).map(|(start, end)| format!("{},{}", enc(start), enc(end)));
            count += 1;
            if actual.as_deref() != result[2].as_str() {
                mismatches.push(format!(
                    "dateRange({}, {}, {}): expected {}, got {actual:?}",
                    short(value.as_ref()),
                    enc(now),
                    enc(offset),
                    result[2]
                ));
            }
        }
    }
    assert!(count > 5_000);
    assert_none("dateRange calls", &mismatches);
}

#[test]
fn column_kind_matches() {
    let fixture = Fixture::load();
    for case in fixture.json["kinds"].as_array().unwrap() {
        let prop = Property::from_json(&case[0]).unwrap();
        assert_eq!(column_kind(&prop).as_str(), case[1].as_str().unwrap(), "{}", case[0]);
    }
}
