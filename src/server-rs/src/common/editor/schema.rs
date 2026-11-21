//! Port of `src/common/editor/schema.ts`.

use std::collections::HashMap;

use regex::Regex;
use serde_json::Value;

use super::model::{children, marks, node_type, text};

#[derive(Debug, Clone, Default)]
pub struct NodeSpec {
    /// Content expression, e.g. `"block+"`, `"inline*"`, `"(tableCell | tableHeader)+"`.
    pub content: Option<&'static str>,
    /// Space-separated groups this node belongs to, e.g. `"block"`.
    pub group: &'static str,
    pub inline: bool,
    /// Default attributes, as a JSON object.
    pub attrs: Option<Value>,
    /// Marks allowed on inline children: `"_"` for all (default for textblocks), `""` for none.
    pub marks: Option<&'static str>,
    /// Text inside is literal (code): marks are not allowed.
    pub code: bool,
    pub isolating: bool,
    pub selectable: bool,
}

#[derive(Debug, Clone, Default)]
pub struct MarkSpec {
    pub attrs: Option<Value>,
    /// Marks are exclusive by type unless this is set (e.g. comments can stack).
    pub stackable: bool,
    /// Typing at the mark's end continues it (default true).
    pub inclusive: Option<bool>,
}

/// Compiles a content expression into a regular expression over the
/// space-joined child type names.
fn compile_content(expr: &str, groups: &HashMap<&'static str, Vec<&'static str>>) -> Regex {
    let tokens = Regex::new(r"\w+|[()|*+?]").expect("token pattern");
    let mut source = String::new();
    for token in tokens.find_iter(expr) {
        let token = token.as_str();
        if token.chars().all(|c| c.is_alphanumeric() || c == '_') {
            let members = groups.get(token).map(|m| m.join("|")).unwrap_or_else(|| token.to_string());
            source.push_str(&format!("(?:(?:{members}) )"));
        } else {
            source.push_str(token);
        }
    }
    Regex::new(&format!("^(?:{source})$")).expect("content expression")
}

pub struct Schema {
    nodes: Vec<(&'static str, NodeSpec)>,
    marks: Vec<(&'static str, MarkSpec)>,
    node_index: HashMap<&'static str, usize>,
    mark_index: HashMap<&'static str, usize>,
    matchers: HashMap<&'static str, Regex>,
    groups: HashMap<&'static str, Vec<&'static str>>,
    textblocks: HashMap<&'static str, bool>,
}

impl Schema {
    pub fn new(nodes: Vec<(&'static str, NodeSpec)>, marks: Vec<(&'static str, MarkSpec)>) -> Self {
        let mut groups: HashMap<&'static str, Vec<&'static str>> = HashMap::new();
        for (name, spec) in &nodes {
            for group in spec.group.split(' ').filter(|g| !g.is_empty()) {
                groups.entry(group).or_default().push(name);
            }
        }
        let mut matchers = HashMap::new();
        let mut textblocks = HashMap::new();
        let word = Regex::new(r"\b(inline|text)\b").expect("textblock pattern");
        for (name, spec) in &nodes {
            if let Some(content) = spec.content.filter(|c| !c.is_empty()) {
                matchers.insert(*name, compile_content(content, &groups));
                textblocks.insert(*name, word.is_match(content));
            }
        }
        let node_index = nodes.iter().enumerate().map(|(i, (name, _))| (*name, i)).collect();
        let mark_index = marks.iter().enumerate().map(|(i, (name, _))| (*name, i)).collect();
        Schema { nodes, marks, node_index, mark_index, matchers, groups, textblocks }
    }

    /// `schema.nodes[type]`.
    pub fn node_spec(&self, node_type: &str) -> Option<&NodeSpec> {
        self.node_index.get(node_type).map(|i| &self.nodes[*i].1)
    }

    /// `schema.marks[type]`.
    pub fn mark_spec(&self, mark_type: &str) -> Option<&MarkSpec> {
        self.mark_index.get(mark_type).map(|i| &self.marks[*i].1)
    }

    /// Node type names in declaration order.
    pub fn node_names(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.nodes.iter().map(|(name, _)| *name)
    }

    /// Mark type names in declaration order, which is the order marks are kept in.
    pub fn mark_names(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.marks.iter().map(|(name, _)| *name)
    }

    /// Position of a mark type in declaration order; unknown types sort last.
    pub fn mark_rank(&self, mark_type: &str) -> usize {
        self.mark_index.get(mark_type).copied().unwrap_or(self.marks.len())
    }

    pub fn is_known(&self, node_type: &str) -> bool {
        self.node_index.contains_key(node_type)
    }

    pub fn is_leaf(&self, node_type: &str) -> bool {
        node_type != "text" && !self.node_spec(node_type).is_some_and(|s| s.content.is_some_and(|c| !c.is_empty()))
    }

    pub fn is_inline(&self, node_type: &str) -> bool {
        node_type == "text" || self.node_spec(node_type).is_some_and(|s| s.inline)
    }

    pub fn is_textblock(&self, node_type: &str) -> bool {
        self.textblocks.get(node_type).copied().unwrap_or(false)
    }

    pub fn is_block(&self, node_type: &str) -> bool {
        !self.is_inline(node_type)
    }

    pub fn in_group(&self, node_type: &str, group: &str) -> bool {
        self.groups.get(group).is_some_and(|members| members.contains(&node_type))
    }

    pub fn group_members(&self, group: &str) -> &[&'static str] {
        self.groups.get(group).map_or(&[], Vec::as_slice)
    }

    pub fn allows_mark(&self, parent_type: &str, mark_type: &str) -> bool {
        let Some(spec) = self.node_spec(parent_type) else { return false };
        if spec.code {
            return false;
        }
        if spec.marks.is_none() && !self.is_textblock(parent_type) {
            return false;
        }
        let marks = spec.marks.unwrap_or("_");
        marks == "_" || marks.split(' ').any(|m| m == mark_type)
    }

    /// Whether `children` is valid content for a node of `node_type`.
    pub fn valid_content(&self, node_type: &str, children: &[Value]) -> bool {
        match self.matchers.get(node_type) {
            None => children.is_empty(),
            Some(matcher) => {
                let mut types = String::new();
                for child in children {
                    types.push_str(self::node_type(child));
                    types.push(' ');
                }
                matcher.is_match(&types)
            }
        }
    }

    /// Default attrs merged with the given ones; unknown attrs are kept so foreign data survives.
    pub fn attrs(&self, node_type: &str, attrs: Option<&Value>) -> Option<Value> {
        merge_attrs(self.node_spec(node_type).and_then(|s| s.attrs.as_ref()), attrs)
    }

    pub fn mark_attrs(&self, mark_type: &str, attrs: Option<&Value>) -> Option<Value> {
        merge_attrs(self.mark_spec(mark_type).and_then(|s| s.attrs.as_ref()), attrs)
    }

    /// Checks a whole subtree. Returns the path of the first invalid node, or
    /// `None` when valid.
    pub fn check(&self, node: &Value) -> Option<Vec<usize>> {
        let mut path = Vec::new();
        if self.check_at(node, &mut path) {
            None
        } else {
            Some(path)
        }
    }

    /// True when valid; otherwise `path` is left at the first invalid node.
    fn check_at(&self, node: &Value, path: &mut Vec<usize>) -> bool {
        let ty = node_type(node);
        if ty == "text" {
            return !text(node).is_empty();
        }
        if !self.is_known(ty) {
            return false;
        }
        let kids = children(node);
        if !self.valid_content(ty, kids) {
            return false;
        }
        for (i, child) in kids.iter().enumerate() {
            path.push(i);
            for mark in marks(child) {
                let mark_type = node_type(mark);
                if self.mark_spec(mark_type).is_none() || !self.allows_mark(ty, mark_type) {
                    return false;
                }
            }
            if !self.check_at(child, path) {
                return false;
            }
            path.pop();
        }
        true
    }
}

fn merge_attrs(defaults: Option<&Value>, attrs: Option<&Value>) -> Option<Value> {
    if defaults.is_none() && attrs.is_none() {
        return None;
    }
    let mut merged = defaults.and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(given) = attrs.and_then(Value::as_object) {
        for (key, value) in given {
            merged.insert(key.clone(), value.clone());
        }
    }
    Some(Value::Object(merged))
}
