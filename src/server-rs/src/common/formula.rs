//! Port of `src/common/formula.ts`.
//!
//! Formula language for base properties.
//!
//! Expressions combine literals, `prop("Name")` references and function calls
//! with `or`, `and`, `not`, comparisons, `&` (join text), `+ - * / %` and `^`.
//! Names are case-insensitive. Compilation resolves property names to ids and
//! infers a result type; evaluation never fails for a formula problem and
//! stores an error value instead.
//!
//! # How this differs in shape from the TypeScript
//!
//! The TypeScript parser, type checker and evaluator are recursive functions
//! over a tree of objects. A source may be 10,000 characters of `(` or `-`,
//! and sixteen formulas may be chained, so the same recursion here could
//! exhaust the stack of a server thread. This port therefore keeps the syntax
//! tree in a flat arena and walks it with explicit stacks: the parser is an
//! operator-precedence parser that produces the same tree and the same errors
//! as the recursive descent, and the evaluator is a small stack machine that
//! evaluates in the same order. Nothing in this file recurses on the depth of
//! an expression, so every source of up to 10,000 characters parses and
//! evaluates. (Bun is not consistent there: past roughly 2,800 nested
//! parentheses its parser sometimes overflows the JavaScript stack and
//! sometimes does not, depending on how warm the code is. Saving such a
//! formula then fails with an internal error, and computing it stores "A
//! property this formula uses was deleted".)
//!
//! Strings are measured and cut in UTF-16 code units wherever the TypeScript
//! uses `length`, `slice`, `substr` or `indexOf`. A cut that falls between
//! the two halves of a surrogate pair leaves half a character, as it does in
//! JavaScript; `jsutil` carries the half in a private-use code point.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Map, Value};

use crate::common::bases::Property;
use crate::common::jsdate::{date_parse, date_utc, set_utc_date, to_iso_string, utc_fields};
use crate::common::jsnum::{is_integer, math_max, math_min, math_round, math_sign, pow, to_integer_or_infinity, to_precision};
use crate::jsutil::{js_json, js_slice, js_trim, number_json, number_to_string, number_value, string_to_number, utf16_len};

pub const MAX_SOURCE_LENGTH: usize = 10_000;
/// How many formulas may be nested through `prop()` references.
const MAX_DEPTH: usize = 16;
/// The longest text `REPEAT` produces, in UTF-16 code units.
const MAX_TEXT: f64 = 10_000.0;
/// The longest text a formula may build, in UTF-16 code units.
///
/// JavaScriptCore refuses strings of 2^31 code units and more with a
/// RangeError, which `compute_formulas` reports as "Formula is too deeply
/// nested". JavaScript strings are ropes, so Bun gets that far cheaply; a
/// Rust string is flat memory, so the limit here is lower, 2^28 - 1. Text
/// that long could not be stored in a `jsonb` cell anyway.
const MAX_STRING_UNITS: usize = (1 << 28) - 1;

/// `(start, end)` in UTF-16 code units of the source.
pub type Span = (usize, usize);

/// What is wrong with a formula's source, in words meant for the person who
/// wrote it, and where (when the problem has a place).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormulaSyntaxError {
    pub message: String,
    pub span: Option<Span>,
}

impl FormulaSyntaxError {
    fn new(message: impl Into<String>, span: Option<Span>) -> Self {
        FormulaSyntaxError { message: message.into(), span }
    }
}

impl std::fmt::Display for FormulaSyntaxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FormulaSyntaxError {}

/// `isErrorValue`: a failed evaluation, stored in the cell in place of a
/// value, is an object with string `error` and `message`.
pub fn is_error_value(value: &Value) -> bool {
    value.as_object().is_some_and(|fields| fields.get("error").is_some_and(Value::is_string) && fields.get("message").is_some_and(Value::is_string))
}

/// What evaluation can throw.
#[derive(Debug, Clone, PartialEq)]
enum Thrown {
    /// The TypeScript `EvalError`: a formula problem with a code (`TYPE`,
    /// `VALUE`, `DIV_BY_ZERO`, `DEPTH`, `CYCLE`, `MISSING_PROP`). `ISERROR`
    /// and `IFERROR` catch these.
    Eval { code: &'static str, message: String },
    /// A JavaScript `RangeError` from a built-in: `toISOString` on a date
    /// outside the valid range, `"".repeat(Infinity)`, a string too long.
    /// Nothing in a formula catches it.
    Range,
}

fn eval_error(code: &'static str, message: impl Into<String>) -> Thrown {
    Thrown::Eval { code, message: message.into() }
}

fn value_error(message: impl Into<String>) -> Thrown {
    eval_error("VALUE", message)
}

// ---------------------------------------------------------------------------
// Tokens

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TokenKind {
    Number,
    String,
    Ident,
    Op,
    LParen,
    RParen,
    Comma,
    Eof,
}

#[derive(Debug, Clone)]
struct Token<'a> {
    kind: TokenKind,
    /// The token as written.
    text: &'a str,
    /// The value of a number token.
    number: f64,
    /// The value of a string token, escapes resolved.
    string: String,
    span: Span,
    /// The token's place in the source in bytes, for cutting the source.
    bytes: (usize, usize),
}

/// Longest first, so `<=` is not read as `<` then `=`.
const OPERATORS: [&str; 15] = ["!=", "<>", "<=", ">=", "==", "+", "-", "*", "/", "%", "^", "&", "=", "<", ">"];

fn tokenize(src: &str) -> Result<Vec<Token<'_>>, FormulaSyntaxError> {
    let bytes = src.as_bytes();
    let mut tokens = Vec::new();
    // `i` is a byte offset and `units` the same place in UTF-16 code units.
    let mut i = 0;
    let mut units = 0;
    let digit_at = |at: usize| bytes.get(at).is_some_and(u8::is_ascii_digit);
    while i < bytes.len() {
        let c = bytes[i];
        if matches!(c, b' ' | b'\t' | b'\n' | b'\r') {
            i += 1;
            units += 1;
            continue;
        }
        let (start, start_units) = (i, units);
        let mut token = Token { kind: TokenKind::Op, text: "", number: 0.0, string: String::new(), span: (0, 0), bytes: (0, 0) };
        if matches!(c, b'(' | b')' | b',') {
            token.kind = match c {
                b'(' => TokenKind::LParen,
                b')' => TokenKind::RParen,
                _ => TokenKind::Comma,
            };
            i += 1;
        } else if c == b'"' || c == b'\'' {
            let quote = char::from(c);
            i += 1;
            loop {
                let Some(ch) = src[i..].chars().next() else {
                    return Err(FormulaSyntaxError::new("Unterminated text value", Some((start_units, utf16_len(src)))));
                };
                i += ch.len_utf8();
                if ch == quote {
                    break;
                }
                if ch == '\\' {
                    // A backslash at the very end of the source is an ordinary character.
                    if let Some(next) = src[i..].chars().next() {
                        token.string.push(match next {
                            'n' => '\n',
                            't' => '\t',
                            other => other,
                        });
                        i += next.len_utf8();
                        continue;
                    }
                }
                token.string.push(ch);
            }
            token.kind = TokenKind::String;
        } else if c.is_ascii_digit() || (c == b'.' && digit_at(i + 1)) {
            while digit_at(i) {
                i += 1;
            }
            if bytes.get(i) == Some(&b'.') {
                i += 1;
                while digit_at(i) {
                    i += 1;
                }
            }
            if matches!(bytes.get(i), Some(b'e' | b'E')) {
                // An exponent only when digits follow; otherwise the `e` starts a name.
                let mut j = i + 1;
                if matches!(bytes.get(j), Some(b'+' | b'-')) {
                    j += 1;
                }
                if digit_at(j) {
                    while digit_at(j) {
                        j += 1;
                    }
                    i = j;
                }
            }
            token.kind = TokenKind::Number;
            token.number = string_to_number(&src[start..i]);
        } else if c.is_ascii_alphabetic() || c == b'_' {
            while bytes.get(i).is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_') {
                i += 1;
            }
            token.kind = TokenKind::Ident;
        } else if let Some(op) = OPERATORS.iter().find(|op| src[i..].starts_with(**op)) {
            i += op.len();
        } else {
            // JavaScript reports one UTF-16 code unit here, which for a character outside the
            // basic plane is half of it; the whole character is named instead.
            let ch = src[i..].chars().next().expect("a character");
            return Err(FormulaSyntaxError::new(format!("Unexpected character \"{ch}\""), Some((start_units, start_units + 1))));
        }
        // Every token but a string is ASCII, so its bytes are its code units.
        if token.kind == TokenKind::String {
            units = start_units + src[start..i].chars().map(char::len_utf16).sum::<usize>();
        } else {
            units = start_units + (i - start);
        }
        token.text = &src[start..i];
        token.span = (start_units, units);
        token.bytes = (start, i);
        tokens.push(token);
    }
    tokens.push(Token { kind: TokenKind::Eof, text: "", number: 0.0, string: String::new(), span: (units, units), bytes: (src.len(), src.len()) });
    Ok(tokens)
}

// ---------------------------------------------------------------------------
// Syntax tree

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Pow,
    Concat,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
}

impl BinOp {
    /// The operator as the type checker's messages show it.
    fn symbol(self) -> &'static str {
        match self {
            BinOp::Add => "+",
            BinOp::Sub => "-",
            BinOp::Mul => "*",
            BinOp::Div => "/",
            BinOp::Rem => "%",
            BinOp::Pow => "^",
            BinOp::Concat => "&",
            BinOp::Eq => "=",
            BinOp::Ne => "!=",
            BinOp::Lt => "<",
            BinOp::Le => "<=",
            BinOp::Gt => ">",
            BinOp::Ge => ">=",
            BinOp::And => "and",
            BinOp::Or => "or",
        }
    }
}

type NodeId = u32;

#[derive(Debug, Clone)]
enum Node {
    Lit(Val),
    /// A `prop("Name")` reference; `id` is filled in by compilation.
    Prop {
        name: String,
        id: Option<String>,
        span: Span,
    },
    /// `function` is `None` for a name that is not a function, which compilation reports.
    Call {
        name: String,
        function: Option<&'static Function>,
        args: Vec<NodeId>,
        span: Span,
    },
    Neg(NodeId),
    Not(NodeId),
    Bin {
        op: BinOp,
        l: NodeId,
        r: NodeId,
    },
}

/// A syntax tree as a flat list: children come before their parents and
/// refer to each other by index, so building, checking, evaluating and
/// dropping a tree never recurses.
#[derive(Debug, Clone)]
struct Ast {
    nodes: Vec<Node>,
    root: NodeId,
}

impl Ast {
    fn node(&self, id: NodeId) -> &Node {
        &self.nodes[id as usize]
    }
}

/// What the parser has started and not finished, innermost last.
enum Pending {
    /// `(` of a parenthesized expression.
    Paren,
    /// `name(` and the arguments read so far.
    Call {
        name: String,
        function: Option<&'static Function>,
        start: usize,
        args: Vec<NodeId>,
    },
    /// A prefix `not`, `-` or `+` waiting for its operand.
    Not,
    Neg,
    Plus,
    /// A binary operator with its left operand, waiting for the right one.
    Bin {
        op: BinOp,
        left: NodeId,
    },
}

/// How tightly an operator holds its operands; a pending operator is applied
/// before a following one that binds no tighter.
fn precedence(op: BinOp) -> u8 {
    match op {
        BinOp::Or => 1,
        BinOp::And => 2,
        BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => 4,
        BinOp::Concat => 5,
        BinOp::Add | BinOp::Sub => 6,
        BinOp::Mul | BinOp::Div | BinOp::Rem => 7,
        BinOp::Pow => 9,
    }
}
const NOT_PRECEDENCE: u8 = 3;
const SIGN_PRECEDENCE: u8 = 8;

fn unexpected(token: &Token) -> FormulaSyntaxError {
    if token.kind == TokenKind::Eof {
        FormulaSyntaxError::new("The formula ended unexpectedly", Some(token.span))
    } else {
        FormulaSyntaxError::new(format!("Unexpected \"{}\"", token.text), Some(token.span))
    }
}

/// The binary operator a token is, if it follows an operand.
fn binary_operator(token: &Token) -> Option<BinOp> {
    match token.kind {
        TokenKind::Ident if token.text.eq_ignore_ascii_case("or") => Some(BinOp::Or),
        TokenKind::Ident if token.text.eq_ignore_ascii_case("and") => Some(BinOp::And),
        TokenKind::Op => Some(match token.text {
            "=" | "==" => BinOp::Eq,
            "!=" | "<>" => BinOp::Ne,
            "<" => BinOp::Lt,
            "<=" => BinOp::Le,
            ">" => BinOp::Gt,
            ">=" => BinOp::Ge,
            "&" => BinOp::Concat,
            "+" => BinOp::Add,
            "-" => BinOp::Sub,
            "*" => BinOp::Mul,
            "/" => BinOp::Div,
            "%" => BinOp::Rem,
            _ => BinOp::Pow,
        }),
        _ => None,
    }
}

fn add(nodes: &mut Vec<Node>, node: Node) -> NodeId {
    nodes.push(node);
    (nodes.len() - 1) as NodeId
}

/// Parses a source into a tree.
///
/// The grammar, loosest first: `or`; `and`; prefix `not`; comparisons; `&`;
/// `+ -`; `* / %`; prefix `- +`; `^` (right-associative, and its right side
/// may carry a sign: `2^-1`); then literals, parentheses, `prop("Name")` and
/// calls. `not` is a prefix operator only where a whole condition may start
/// (at the beginning, after `(`, `,`, `and`, `or` or another `not`) and not
/// when a parenthesis follows it, which makes it the function `NOT(...)`.
fn parse(src: &str) -> Result<Ast, FormulaSyntaxError> {
    if js_trim(src).is_empty() {
        return Err(FormulaSyntaxError::new("Formula is empty", None));
    }
    if utf16_len(src) > MAX_SOURCE_LENGTH {
        return Err(FormulaSyntaxError::new("Formula is too long", None));
    }
    let tokens = tokenize(src)?;
    let mut nodes: Vec<Node> = Vec::new();
    let mut pos = 0;
    let mut pending: Vec<Pending> = Vec::new();
    // Whether the operand about to be read may start with a prefix `not`.
    let mut condition_start = true;

    'operand: loop {
        // Prefix operators.
        loop {
            let token = &tokens[pos];
            if condition_start
                && token.kind == TokenKind::Ident
                && token.text.eq_ignore_ascii_case("not")
                && tokens[pos + 1].kind != TokenKind::LParen
            {
                pending.push(Pending::Not);
            } else if token.kind == TokenKind::Op && token.text == "-" {
                pending.push(Pending::Neg);
                condition_start = false;
            } else if token.kind == TokenKind::Op && token.text == "+" {
                pending.push(Pending::Plus);
                condition_start = false;
            } else {
                break;
            }
            pos += 1;
        }

        // A primary expression.
        let token = &tokens[pos];
        pos += 1;
        let mut operand = match token.kind {
            TokenKind::Number => add(&mut nodes, Node::Lit(Val::Num(token.number))),
            TokenKind::String => add(&mut nodes, Node::Lit(Val::Str(token.string.clone()))),
            TokenKind::LParen => {
                pending.push(Pending::Paren);
                condition_start = true;
                continue 'operand;
            }
            TokenKind::Ident => {
                let lower = token.text.to_ascii_lowercase();
                if tokens[pos].kind != TokenKind::LParen {
                    match lower.as_str() {
                        "true" => add(&mut nodes, Node::Lit(Val::Bool(true))),
                        "false" => add(&mut nodes, Node::Lit(Val::Bool(false))),
                        "null" | "blank" | "empty" => add(&mut nodes, Node::Lit(Val::Null)),
                        _ => {
                            let name = token.text;
                            return Err(FormulaSyntaxError::new(
                                format!("Unknown name \"{name}\". Reference a property with prop(\"{name}\")."),
                                Some(token.span),
                            ));
                        }
                    }
                } else {
                    pos += 1;
                    if lower == "prop" {
                        let arg = &tokens[pos];
                        pos += 1;
                        if arg.kind != TokenKind::String {
                            return Err(FormulaSyntaxError::new("prop() takes a property name in quotes, like prop(\"Status\")", Some(arg.span)));
                        }
                        let close = &tokens[pos];
                        pos += 1;
                        if close.kind != TokenKind::RParen {
                            return Err(unexpected(close));
                        }
                        if js_trim(&arg.string).is_empty() {
                            return Err(FormulaSyntaxError::new("prop() needs a property name", Some(arg.span)));
                        }
                        add(&mut nodes, Node::Prop { name: arg.string.clone(), id: None, span: (token.span.0, close.span.1) })
                    } else {
                        let name = token.text.to_ascii_uppercase();
                        let function = lookup_function(&name);
                        if tokens[pos].kind == TokenKind::RParen {
                            let close = &tokens[pos];
                            pos += 1;
                            add(&mut nodes, Node::Call { name, function, args: Vec::new(), span: (token.span.0, close.span.1) })
                        } else {
                            pending.push(Pending::Call { name, function, start: token.span.0, args: Vec::new() });
                            condition_start = true;
                            continue 'operand;
                        }
                    }
                }
            }
            _ => return Err(unexpected(token)),
        };

        // What follows an operand: a binary operator, or the end of a group.
        loop {
            let token = &tokens[pos];
            let incoming = binary_operator(token);
            // Apply the pending operators that bind at least as tightly as the incoming one;
            // without an incoming operator, all of them up to the enclosing group.
            while let Some(top) = pending.last() {
                let binds = match top {
                    Pending::Paren | Pending::Call { .. } => break,
                    Pending::Not => NOT_PRECEDENCE,
                    Pending::Neg | Pending::Plus => SIGN_PRECEDENCE,
                    Pending::Bin { op, .. } => precedence(*op),
                };
                let apply = match incoming {
                    None => true,
                    // `^` groups to the right and takes a signed operand: -2^2 is -(2^2), 2^3^2 is 2^(3^2).
                    Some(BinOp::Pow) => binds > precedence(BinOp::Pow),
                    Some(op) => binds >= precedence(op),
                };
                if !apply {
                    break;
                }
                operand = match pending.pop().expect("a pending operator") {
                    Pending::Not => add(&mut nodes, Node::Not(operand)),
                    Pending::Neg => add(&mut nodes, Node::Neg(operand)),
                    Pending::Plus => operand,
                    Pending::Bin { op, left } => add(&mut nodes, Node::Bin { op, l: left, r: operand }),
                    Pending::Paren | Pending::Call { .. } => unreachable!("groups are not applied"),
                };
            }
            if let Some(op) = incoming {
                pos += 1;
                pending.push(Pending::Bin { op, left: operand });
                condition_start = matches!(op, BinOp::And | BinOp::Or);
                continue 'operand;
            }
            match pending.last_mut() {
                None => {
                    if token.kind != TokenKind::Eof {
                        return Err(unexpected(token));
                    }
                    return Ok(Ast { nodes, root: operand });
                }
                Some(Pending::Paren) => {
                    if token.kind != TokenKind::RParen {
                        return Err(unexpected(token));
                    }
                    pos += 1;
                    pending.pop();
                }
                Some(Pending::Call { args, .. }) => {
                    args.push(operand);
                    pos += 1;
                    if token.kind == TokenKind::Comma {
                        condition_start = true;
                        continue 'operand;
                    }
                    if token.kind != TokenKind::RParen {
                        return Err(unexpected(token));
                    }
                    let Some(Pending::Call { name, function, start, args }) = pending.pop() else {
                        unreachable!("the call was just seen");
                    };
                    operand = add(&mut nodes, Node::Call { name, function, args, span: (start, token.span.1) });
                }
                Some(_) => unreachable!("operators were applied"),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Values

/// A value during evaluation. A date is a time value in milliseconds and
/// whether it stands for a whole day (and prints as `YYYY-MM-DD`).
#[derive(Debug, Clone, PartialEq)]
enum Val {
    Null,
    Num(f64),
    Str(String),
    Bool(bool),
    Date { ms: f64, date_only: bool },
}

fn is_blank(v: &Val) -> bool {
    match v {
        Val::Null => true,
        Val::Str(s) => s.is_empty(),
        _ => false,
    }
}

/// Removes float noise: `0.1 + 0.2` becomes `0.3`.
fn snap(n: f64) -> f64 {
    if n.is_finite() && !is_integer(n) {
        string_to_number(&to_precision(n, 12))
    } else {
        n
    }
}

fn format_number(n: f64) -> String {
    if is_integer(n) {
        return number_to_string(n);
    }
    // Very large, very small and not-a-number values print as they are.
    if (1e-7..1e21).contains(&n.abs()) {
        number_to_string(string_to_number(&to_precision(n, 12)))
    } else {
        number_to_string(n)
    }
}

/// `String(n).padStart(2, "0")`.
fn pad2(n: f64) -> String {
    let text = number_to_string(n);
    if text.len() < 2 {
        format!("0{text}")
    } else {
        text
    }
}

/// A UTC getter of `new Date(ms)` as a number: NaN for an invalid date.
fn field(ms: f64, get: fn(&crate::common::jsdate::DateFields) -> i64) -> f64 {
    utc_fields(ms).map_or(f64::NAN, |fields| get(&fields) as f64)
}

fn date_text(ms: f64, date_only: bool) -> Result<String, Thrown> {
    if !ms.is_finite() {
        return Ok(String::new());
    }
    if date_only {
        // The year is not padded, and an out-of-range date prints its NaN fields.
        return Ok(match utc_fields(ms) {
            Some(f) => format!("{}-{:02}-{:02}", f.year, f.month + 1, f.date),
            None => "NaN-NaN-NaN".to_owned(),
        });
    }
    to_iso_string(ms).ok_or(Thrown::Range)
}

/// `/^\d{4}-\d{2}-\d{2}$/`.
fn is_plain_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

/// Reads a value as a date: `(ms, date_only)`. Numbers are milliseconds;
/// text is parsed, a bare `YYYY-MM-DD` as a whole day in UTC.
fn to_date(v: &Val) -> Option<(f64, bool)> {
    match v {
        Val::Date { ms, date_only } => Some((*ms, *date_only)),
        Val::Num(n) => Some((*n, false)),
        Val::Str(text) => {
            let s = js_trim(text);
            let (ms, date_only) = if is_plain_date(s) { (date_parse(&format!("{s}T00:00:00.000Z")), true) } else { (date_parse(s), false) };
            (!ms.is_nan()).then_some((ms, date_only))
        }
        _ => None,
    }
}

fn to_number(v: &Val) -> Result<f64, Thrown> {
    match v {
        Val::Num(n) => Ok(*n),
        Val::Null => Ok(0.0),
        Val::Bool(b) => Ok(f64::from(u8::from(*b))),
        Val::Date { ms, .. } => Ok(*ms),
        Val::Str(text) => {
            let s: String = js_trim(text).chars().filter(|c| *c != ',').collect();
            if s.is_empty() {
                return Ok(0.0);
            }
            let n = string_to_number(&s);
            if n.is_nan() {
                return Err(value_error(format!("\"{text}\" is not a number")));
            }
            Ok(n)
        }
    }
}

fn to_text(v: &Val) -> Result<String, Thrown> {
    Ok(match v {
        Val::Null => String::new(),
        Val::Date { ms, date_only } => date_text(*ms, *date_only)?,
        Val::Num(n) => format_number(*n),
        Val::Bool(b) => b.to_string(),
        Val::Str(s) => s.clone(),
    })
}

fn to_boolean(v: &Val) -> bool {
    match v {
        Val::Bool(b) => *b,
        Val::Null => false,
        Val::Num(n) => *n != 0.0,
        Val::Date { .. } => true,
        Val::Str(text) => !matches!(js_trim(text).to_lowercase().as_str(), "false" | "no" | "0" | ""),
    }
}

fn is_date(v: &Val) -> bool {
    matches!(v, Val::Date { .. })
}

/// `=`: equality that coerces like a spreadsheet. Comparing a number with
/// text that is not a number is an error, as in TypeScript.
fn values_equal(a: &Val, b: &Val) -> Result<bool, Thrown> {
    if is_blank(a) && is_blank(b) {
        return Ok(true);
    }
    if is_blank(a) || is_blank(b) {
        return Ok(false);
    }
    if is_date(a) || is_date(b) {
        return Ok(match (to_date(a), to_date(b)) {
            (Some((x, _)), Some((y, _))) => x == y,
            _ => false,
        });
    }
    if matches!(a, Val::Bool(_)) || matches!(b, Val::Bool(_)) {
        return Ok(to_boolean(a) == to_boolean(b));
    }
    if matches!(a, Val::Num(_)) || matches!(b, Val::Num(_)) {
        return Ok(to_number(a)? == to_number(b)?);
    }
    Ok(a == b)
}

/// `a < b` on JavaScript strings: by UTF-16 code unit, not by code point.
fn compare_strings(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Negative, zero or positive as `a` sorts before, with or after `b`; NaN
/// when they cannot be ordered (every comparison with it is false).
fn compare(a: &Val, b: &Val) -> Result<f64, Thrown> {
    if is_date(a) || is_date(b) {
        return match (to_date(a), to_date(b)) {
            (Some((x, _)), Some((y, _))) => Ok(x - y),
            _ => Err(eval_error("TYPE", "These values cannot be compared")),
        };
    }
    if let (Val::Str(x), Val::Str(y)) = (a, b) {
        if !x.is_empty() && !y.is_empty() {
            return Ok(match compare_strings(x, y) {
                Ordering::Less => -1.0,
                Ordering::Equal => 0.0,
                Ordering::Greater => 1.0,
            });
        }
    }
    if is_blank(a) && is_blank(b) {
        return Ok(0.0);
    }
    Ok(to_number(a)? - to_number(b)?)
}

/// Final value stored in a cell.
fn to_stored(v: &Val) -> Result<Value, Thrown> {
    Ok(match v {
        Val::Date { ms, date_only } => {
            let text = date_text(*ms, *date_only)?;
            if text.is_empty() {
                Value::Null
            } else {
                Value::String(text)
            }
        }
        Val::Num(n) => number_json(snap(*n)),
        Val::Str(s) => Value::String(s.clone()),
        Val::Bool(b) => Value::Bool(*b),
        Val::Null => Value::Null,
    })
}

// ---------------------------------------------------------------------------
// Text helpers

/// Fails like JavaScript's "Out of memory" RangeError when a text of this
/// many UTF-8 bytes or, counted exactly on demand, UTF-16 units is too long.
fn check_length(bytes: usize, units: impl FnOnce() -> usize) -> Result<(), Thrown> {
    // A string has at least as many bytes as code units, so short ones need no count.
    if bytes > MAX_STRING_UNITS && units() > MAX_STRING_UNITS {
        return Err(Thrown::Range);
    }
    Ok(())
}

/// `s.length` of a text that may be very long. ASCII, the usual case, needs
/// no counting; otherwise every character is one code unit, or two when it
/// takes four bytes.
fn units(s: &str) -> usize {
    if s.is_ascii() {
        return s.len();
    }
    s.bytes().filter(|byte| byte & 0xC0 != 0x80).count() + s.bytes().filter(|byte| *byte >= 0xF0).count()
}

fn join_texts(parts: &[String], separator: &str) -> Result<String, Thrown> {
    let bytes = parts.iter().map(String::len).sum::<usize>() + separator.len() * parts.len().saturating_sub(1);
    check_length(bytes, || parts.iter().map(|p| units(p)).sum::<usize>() + units(separator) * parts.len().saturating_sub(1))?;
    Ok(parts.join(separator))
}

/// An index argument of `slice`: `ToIntegerOrInfinity`, the infinities as the largest integers.
fn index(x: f64) -> i64 {
    to_integer_or_infinity(x) as i64
}

/// `s.slice(start, end)` with number arguments.
fn slice(s: &str, start: f64, end: Option<f64>) -> String {
    js_slice(s, index(start), end.map(index))
}

/// `s.substr(start, length)` with number arguments.
fn substr(s: &str, start: f64, length: f64) -> String {
    let size = utf16_len(s) as f64;
    let start = to_integer_or_infinity(start);
    let start = if start < 0.0 { (size + start).max(0.0) } else { start.min(size) };
    let length = to_integer_or_infinity(length).clamp(0.0, size);
    let end = (start + length).min(size);
    js_slice(s, start as i64, Some(end as i64))
}

/// `s.indexOf(search)`, in UTF-16 code units.
fn index_of(s: &str, search: &str) -> f64 {
    s.find(search).map_or(-1.0, |at| utf16_len(&s[..at]) as f64)
}

/// `s.toUpperCase()` / `s.toLowerCase()`, refusing a result that would be too long.
fn map_case(s: &str, upper: bool) -> Result<String, Thrown> {
    // Case mapping at most triples a text.
    if s.len() > MAX_STRING_UNITS / 3 {
        let units: usize = if upper {
            s.chars().flat_map(char::to_uppercase).map(char::len_utf16).sum()
        } else {
            s.chars().flat_map(char::to_lowercase).map(char::len_utf16).sum()
        };
        if units > MAX_STRING_UNITS {
            return Err(Thrown::Range);
        }
    }
    Ok(if upper { s.to_uppercase() } else { s.to_lowercase() })
}

// ---------------------------------------------------------------------------
// Functions

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Param {
    Any,
    Number,
    String,
    Boolean,
    Date,
}

/// The inferred type of an expression: `number`, `string`, `boolean`, `date`
/// or `null`. A formula property contributes whatever its stored
/// `resultType` says, so a value outside those five is carried along as it is.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Static {
    Number,
    String,
    Boolean,
    Date,
    Null,
    Other(String),
}

impl Static {
    fn as_str(&self) -> &str {
        match self {
            Static::Number => "number",
            Static::String => "string",
            Static::Boolean => "boolean",
            Static::Date => "date",
            Static::Null => "null",
            Static::Other(name) => name,
        }
    }

    /// `TYPE_NAMES[type]`, as it reads in a message.
    fn label(&self) -> &'static str {
        match self {
            Static::Number => "a number",
            Static::String => "text",
            Static::Boolean => "a true/false value",
            Static::Date => "a date",
            Static::Null => "empty",
            Static::Other(_) => "undefined",
        }
    }
}

/// How a function's result type follows from its arguments' types.
#[derive(Debug, Clone, Copy)]
enum ResultType {
    Number,
    String,
    Boolean,
    Date,
    Null,
    /// The common type of all arguments.
    Unify,
    /// `IF`: of the second and third argument.
    If,
    /// `IFS`: of the values (every second argument) and a trailing default.
    Ifs,
    /// `SWITCH`: of the results and a trailing default.
    Switch,
}

/// A function that gets all its arguments evaluated; the second parameter is "now".
type Strict = fn(&[Val], f64) -> Result<Val, Thrown>;

#[derive(Clone, Copy)]
enum Body {
    Strict(Strict),
    /// The functions that choose which arguments to evaluate.
    If,
    Ifs,
    Switch,
    And,
    Or,
    IsError,
    IfError,
    Coalesce,
}

struct Function {
    name: &'static str,
    min: usize,
    /// `None` for any number of arguments.
    max: Option<usize>,
    /// The types of the parameters; the last one repeats.
    params: &'static [Param],
    result: ResultType,
    body: Body,
}

impl std::fmt::Debug for Function {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name)
    }
}

fn unify(types: &[Static]) -> Static {
    let mut known = types.iter().filter(|t| **t != Static::Null);
    match known.next() {
        None => Static::Null,
        Some(first) => {
            if known.all(|t| t == first) {
                first.clone()
            } else {
                Static::String
            }
        }
    }
}

fn result_type(result: ResultType, types: &[Static]) -> Static {
    let pick = |keep: &dyn Fn(usize) -> bool| -> Vec<Static> { types.iter().enumerate().filter(|(i, _)| keep(*i)).map(|(_, t)| t.clone()).collect() };
    let n = types.len();
    match result {
        ResultType::Number => Static::Number,
        ResultType::String => Static::String,
        ResultType::Boolean => Static::Boolean,
        ResultType::Date => Static::Date,
        ResultType::Null => Static::Null,
        ResultType::Unify => unify(types),
        ResultType::If => unify(&pick(&|i| i == 1 || i == 2)),
        ResultType::Ifs => unify(&pick(&|i| i % 2 == 1 || (n % 2 == 1 && i == n - 1))),
        ResultType::Switch => unify(&pick(&|i| (i > 0 && i % 2 == 0) || (n.is_multiple_of(2) && i == n - 1))),
    }
}

/// A whole number of digits for the rounding functions; blank is 0.
fn digits_arg(v: Option<&Val>) -> Result<f64, Thrown> {
    match v {
        None => Ok(0.0),
        Some(v) if is_blank(v) => Ok(0.0),
        Some(v) => {
            let d = to_number(v)?;
            if !is_integer(d) {
                return Err(value_error("Digits must be a whole number"));
            }
            Ok(d)
        }
    }
}

#[derive(Clone, Copy)]
enum Rounding {
    Half,
    Up,
    Down,
}

fn round_with(args: &[Val], mode: Rounding) -> Result<Val, Thrown> {
    let n = to_number(&args[0])?;
    let factor = pow(10.0, digits_arg(args.get(1))?);
    let scaled = snap(n.abs() * factor);
    let rounded = match mode {
        Rounding::Half => math_round(scaled),
        Rounding::Up => scaled.ceil(),
        Rounding::Down => scaled.floor(),
    };
    Ok(Val::Num(snap(math_sign(n) * rounded / factor)))
}

/// A length argument: truncated, not negative; blank is the fallback. NaN
/// and Infinity pass through, as in TypeScript.
fn count(v: Option<&Val>, fallback: f64) -> Result<f64, Thrown> {
    match v {
        None => Ok(fallback),
        Some(v) if is_blank(v) => Ok(fallback),
        Some(v) => {
            let n = to_number(v)?.trunc();
            if n < 0.0 {
                return Err(value_error("Length cannot be negative"));
            }
            Ok(n)
        }
    }
}

fn date_arg(function: &str, v: &Val) -> Result<(f64, bool), Thrown> {
    let date = if is_blank(v) { None } else { to_date(v) };
    date.ok_or_else(|| eval_error("TYPE", format!("{function} expects a date")))
}

#[derive(Clone, Copy, PartialEq)]
enum Unit {
    /// A unit of fixed length, in milliseconds.
    Fixed(f64),
    Month,
    Year,
    /// `constructor` and `__proto__`. The TypeScript looks the unit up in a
    /// plain object, where these two names find something inherited instead
    /// of nothing; no error is raised and the arithmetic then yields NaN.
    Inherited,
}

fn unit_name(function: &str, v: Option<&Val>) -> Result<Unit, Thrown> {
    let text = match v {
        None | Some(Val::Null) => "day".to_owned(),
        Some(v) => to_text(v)?,
    };
    let s = js_trim(&text).to_lowercase();
    Ok(match s.as_str() {
        "s" | "sec" | "second" | "seconds" => Unit::Fixed(1_000.0),
        "m" | "min" | "minute" | "minutes" => Unit::Fixed(60_000.0),
        "h" | "hour" | "hours" => Unit::Fixed(3_600_000.0),
        "d" | "day" | "days" => Unit::Fixed(86_400_000.0),
        "w" | "week" | "weeks" => Unit::Fixed(604_800_000.0),
        "mo" | "month" | "months" => Unit::Month,
        "y" | "year" | "years" => Unit::Year,
        "constructor" | "__proto__" => Unit::Inherited,
        _ => {
            return Err(value_error(format!("{function} does not know the unit \"{s}\". Use days, weeks, months, years, hours, minutes or seconds.")))
        }
    })
}

/// The same day of the month `months` later, or that month's last day when
/// it is shorter. Written with the same `Date` calls as the TypeScript, so
/// it shares their quirks: an invalid date stays NaN, and a year from 0 to
/// 99 passes through `Date.UTC`, which reads it as 1900 to 1999.
fn add_months(ms: f64, months: f64) -> f64 {
    let target = date_utc(&[
        field(ms, |f| f.year),
        field(ms, |f| f.month) + months,
        1.0,
        field(ms, |f| f.hours),
        field(ms, |f| f.minutes),
        field(ms, |f| f.seconds),
        field(ms, |f| f.milliseconds),
    ]);
    let last_day = field(date_utc(&[field(target, |f| f.year), field(target, |f| f.month) + 1.0, 0.0]), |f| f.date);
    set_utc_date(target, math_min(&[field(ms, |f| f.date), last_day]))
}

fn date_add(function: &str, args: &[Val], sign: f64) -> Result<Val, Thrown> {
    let (ms, date_only) = date_arg(function, &args[0])?;
    let amount = to_number(&args[1])? * sign;
    let ms = match unit_name(function, args.get(2))? {
        Unit::Month => add_months(ms, amount.trunc()),
        Unit::Year => add_months(ms, amount.trunc() * 12.0),
        Unit::Fixed(length) => ms + amount * length,
        Unit::Inherited => f64::NAN,
    };
    Ok(Val::Date { ms, date_only })
}

fn months_between(from: f64, to: f64) -> f64 {
    let mut months = (field(to, |f| f.year) - field(from, |f| f.year)) * 12.0 + (field(to, |f| f.month) - field(from, |f| f.month));
    if months > 0.0 && add_months(from, months) > to {
        months -= 1.0;
    }
    if months < 0.0 && add_months(from, months) < to {
        months += 1.0;
    }
    months
}

fn numbers(args: &[Val]) -> Result<Vec<f64>, Thrown> {
    args.iter().map(to_number).collect()
}

fn text(s: impl Into<String>) -> Result<Val, Thrown> {
    Ok(Val::Str(s.into()))
}

fn number(n: f64) -> Result<Val, Thrown> {
    Ok(Val::Num(n))
}

fn date_field(function: &str, args: &[Val], get: fn(&crate::common::jsdate::DateFields) -> i64, plus: f64) -> Result<Val, Thrown> {
    number(field(date_arg(function, &args[0])?.0, get) + plus)
}

/// `FORMATDATE`: replaces `YYYY`, `YY`, `MM`, `DD`, `HH`, `mm` and `ss`,
/// leftmost first and `YYYY` before `YY`; everything else is kept.
fn format_date(ms: f64, pattern: &str) -> String {
    let year = field(ms, |f| f.year);
    let parts: [(&str, String); 7] = [
        ("YYYY", number_to_string(year)),
        ("YY", pad2(year % 100.0)),
        ("MM", pad2(field(ms, |f| f.month) + 1.0)),
        ("DD", pad2(field(ms, |f| f.date))),
        ("HH", pad2(field(ms, |f| f.hours))),
        ("mm", pad2(field(ms, |f| f.minutes))),
        ("ss", pad2(field(ms, |f| f.seconds))),
    ];
    let mut out = String::with_capacity(pattern.len());
    let mut rest = pattern;
    'scan: while let Some(ch) = rest.chars().next() {
        for (key, value) in &parts {
            if rest.starts_with(key) {
                out.push_str(value);
                rest = &rest[key.len()..];
                continue 'scan;
            }
        }
        out.push(ch);
        rest = &rest[ch.len_utf8()..];
    }
    out
}

const fn strict(name: &'static str, min: usize, max: Option<usize>, params: &'static [Param], result: ResultType, body: Strict) -> Function {
    Function { name, min, max, params, result, body: Body::Strict(body) }
}

const fn lazy(name: &'static str, min: usize, max: Option<usize>, params: &'static [Param], result: ResultType, body: Body) -> Function {
    Function { name, min, max, params, result, body }
}

use Param::{Any, Boolean as Flag, Date as Day, Number as Num, String as Text};

/// Every function of the language. The comments are the TypeScript `doc` strings.
static FUNCTIONS: &[Function] = &[
    // Returns the second argument when the condition is true, otherwise the third.
    lazy("IF", 2, Some(3), &[Flag, Any, Any], ResultType::If, Body::If),
    // Checks condition/value pairs in order and returns the value of the first true condition; an extra last argument is the default.
    lazy("IFS", 2, None, &[Any], ResultType::Ifs, Body::Ifs),
    // Compares a value with each case and returns the matching result; an extra last argument is the default.
    lazy("SWITCH", 3, None, &[Any], ResultType::Switch, Body::Switch),
    // True when every argument is true.
    lazy("AND", 1, None, &[Flag], ResultType::Boolean, Body::And),
    // True when any argument is true.
    lazy("OR", 1, None, &[Flag], ResultType::Boolean, Body::Or),
    // Flips true and false.
    strict("NOT", 1, Some(1), &[Flag], ResultType::Boolean, |a, _| Ok(Val::Bool(!to_boolean(&a[0])))),
    // True when the value is empty.
    strict("ISBLANK", 1, Some(1), &[Any], ResultType::Boolean, |a, _| Ok(Val::Bool(is_blank(&a[0])))),
    // True when evaluating the value fails.
    lazy("ISERROR", 1, Some(1), &[Any], ResultType::Boolean, Body::IsError),
    // Returns the value, or the fallback when evaluating the value fails.
    lazy("IFERROR", 2, Some(2), &[Any, Any], ResultType::Unify, Body::IfError),
    // The first argument that is not empty.
    lazy("COALESCE", 1, None, &[Any], ResultType::Unify, Body::Coalesce),
    // Fails with the given message.
    strict("ERROR", 0, Some(1), &[Text], ResultType::Null, |a, _| {
        Err(value_error(match a.first() {
            Some(v) if !is_blank(v) => to_text(v)?,
            _ => "Formula raised an error".to_owned(),
        }))
    }),
    // Adds numbers.
    strict("SUM", 1, None, &[Num], ResultType::Number, |a, _| number(snap(numbers(a)?.into_iter().fold(0.0, |x, y| x + y)))),
    // The mean of the numbers.
    strict("AVERAGE", 1, None, &[Num], ResultType::Number, |a, _| number(snap(numbers(a)?.into_iter().fold(0.0, |x, y| x + y) / a.len() as f64))),
    // The smallest number.
    strict("MIN", 1, None, &[Num], ResultType::Number, |a, _| number(math_min(&numbers(a)?))),
    // The largest number.
    strict("MAX", 1, None, &[Num], ResultType::Number, |a, _| number(math_max(&numbers(a)?))),
    // The number without its sign.
    strict("ABS", 1, Some(1), &[Num], ResultType::Number, |a, _| number(snap(to_number(&a[0])?.abs()))),
    // Rounds to the given digits, halves away from zero.
    strict("ROUND", 1, Some(2), &[Num, Num], ResultType::Number, |a, _| round_with(a, Rounding::Half)),
    // Rounds away from zero.
    strict("ROUNDUP", 1, Some(2), &[Num, Num], ResultType::Number, |a, _| round_with(a, Rounding::Up)),
    // Rounds toward zero.
    strict("ROUNDDOWN", 1, Some(2), &[Num, Num], ResultType::Number, |a, _| round_with(a, Rounding::Down)),
    // Rounds down to a whole number.
    strict("FLOOR", 1, Some(1), &[Num], ResultType::Number, |a, _| number(snap(to_number(&a[0])?.floor()))),
    // Rounds up to a whole number.
    strict("CEILING", 1, Some(1), &[Num], ResultType::Number, |a, _| number(snap(to_number(&a[0])?.ceil()))),
    // Drops the fractional part.
    strict("TRUNC", 1, Some(1), &[Num], ResultType::Number, |a, _| number(snap(to_number(&a[0])?.trunc()))),
    // The remainder of a division.
    strict("MOD", 2, Some(2), &[Num, Num], ResultType::Number, |a, _| {
        let d = to_number(&a[1])?;
        if d == 0.0 {
            return Err(eval_error("DIV_BY_ZERO", "Cannot take a remainder by zero"));
        }
        number(snap(to_number(&a[0])? % d))
    }),
    // A number raised to a power.
    strict("POWER", 2, Some(2), &[Num, Num], ResultType::Number, |a, _| number(snap(pow(to_number(&a[0])?, to_number(&a[1])?)))),
    // The square root.
    strict("SQRT", 1, Some(1), &[Num], ResultType::Number, |a, _| {
        let n = to_number(&a[0])?;
        if n < 0.0 {
            return Err(value_error("SQRT needs a number that is not negative"));
        }
        number(snap(n.sqrt()))
    }),
    // -1, 0 or 1 by the sign of the number.
    strict("SIGN", 1, Some(1), &[Num], ResultType::Number, |a, _| number(snap(math_sign(to_number(&a[0])?)))),
    // e raised to the number.
    strict("EXP", 1, Some(1), &[Num], ResultType::Number, |a, _| number(snap(to_number(&a[0])?.exp()))),
    // The natural logarithm.
    strict("LN", 1, Some(1), &[Num], ResultType::Number, |a, _| {
        let n = to_number(&a[0])?;
        if n <= 0.0 {
            return Err(value_error("LN needs a positive number"));
        }
        number(snap(n.ln()))
    }),
    // The base-10 logarithm.
    strict("LOG10", 1, Some(1), &[Num], ResultType::Number, |a, _| {
        let n = to_number(&a[0])?;
        if n <= 0.0 {
            return Err(value_error("LOG10 needs a positive number"));
        }
        number(snap(n.log10()))
    }),
    // Joins values into one text.
    strict("CONCAT", 1, None, &[Any], ResultType::String, |a, _| text(join_texts(&a.iter().map(to_text).collect::<Result<Vec<_>, _>>()?, "")?)),
    // Joins values with a separator.
    strict("JOIN", 2, None, &[Text, Any], ResultType::String, |a, _| {
        let parts = a[1..].iter().map(to_text).collect::<Result<Vec<_>, _>>()?;
        text(join_texts(&parts, &to_text(&a[0])?)?)
    }),
    // The number of characters.
    strict("LEN", 1, Some(1), &[Text], ResultType::Number, |a, _| number(utf16_len(&to_text(&a[0])?) as f64)),
    // Lower-cases text.
    strict("LOWER", 1, Some(1), &[Text], ResultType::String, |a, _| text(map_case(&to_text(&a[0])?, false)?)),
    // Upper-cases text.
    strict("UPPER", 1, Some(1), &[Text], ResultType::String, |a, _| text(map_case(&to_text(&a[0])?, true)?)),
    // Removes surrounding spaces.
    strict("TRIM", 1, Some(1), &[Text], ResultType::String, |a, _| text(js_trim(&to_text(&a[0])?))),
    // The first characters of a text.
    strict("LEFT", 1, Some(2), &[Text, Num], ResultType::String, |a, _| {
        let s = to_text(&a[0])?;
        text(slice(&s, 0.0, Some(count(a.get(1), 1.0)?)))
    }),
    // The last characters of a text.
    strict("RIGHT", 1, Some(2), &[Text, Num], ResultType::String, |a, _| {
        let s = to_text(&a[0])?;
        let n = count(a.get(1), 1.0)?;
        text(if n == 0.0 { String::new() } else { slice(&s, -n, None) })
    }),
    // Characters from a 1-based position.
    strict("MID", 2, Some(3), &[Text, Num, Num], ResultType::String, |a, _| {
        let s = to_text(&a[0])?;
        let start = to_number(&a[1])?.trunc();
        if start < 1.0 {
            return Err(value_error("MID starts counting at 1"));
        }
        text(substr(&s, start - 1.0, count(a.get(2), utf16_len(&s) as f64)?))
    }),
    // 1-based position of the search text, or 0.
    strict("FIND", 2, Some(2), &[Text, Text], ResultType::Number, |a, _| number(index_of(&to_text(&a[0])?, &to_text(&a[1])?) + 1.0)),
    // True when the text contains the search text.
    strict("CONTAINS", 2, Some(2), &[Text, Text], ResultType::Boolean, |a, _| Ok(Val::Bool(to_text(&a[0])?.contains(&to_text(&a[1])?)))),
    // True when the text starts with the prefix.
    strict("STARTSWITH", 2, Some(2), &[Text, Text], ResultType::Boolean, |a, _| Ok(Val::Bool(to_text(&a[0])?.starts_with(&to_text(&a[1])?)))),
    // True when the text ends with the suffix.
    strict("ENDSWITH", 2, Some(2), &[Text, Text], ResultType::Boolean, |a, _| Ok(Val::Bool(to_text(&a[0])?.ends_with(&to_text(&a[1])?)))),
    // Replaces every occurrence of a text.
    strict("SUBSTITUTE", 3, Some(3), &[Text, Text, Text], ResultType::String, |a, _| {
        let from = to_text(&a[1])?;
        let s = to_text(&a[0])?;
        if from.is_empty() {
            return text(s);
        }
        let to = to_text(&a[2])?;
        if to.len() > from.len() {
            let matches = s.matches(&from).count();
            check_length(s.len() + matches * (to.len() - from.len()), || units(&s) + matches * units(&to) - matches * units(&from))?;
        }
        text(s.replace(&from, &to))
    }),
    // Replaces characters at a 1-based position.
    strict("REPLACE", 4, Some(4), &[Text, Num, Num, Text], ResultType::String, |a, _| {
        let s = to_text(&a[0])?;
        let start = math_max(&[1.0, to_number(&a[1])?.trunc()]);
        let length = count(a.get(2), 0.0)?;
        text(join_texts(&[slice(&s, 0.0, Some(start - 1.0)), to_text(&a[3])?, slice(&s, start - 1.0 + length, None)], "")?)
    }),
    // Repeats a text.
    strict("REPEAT", 2, Some(2), &[Text, Num], ResultType::String, |a, _| {
        let s = to_text(&a[0])?;
        let n = count(a.get(1), 0.0)?;
        if utf16_len(&s) as f64 * n > MAX_TEXT {
            return Err(value_error("REPEAT would produce too much text"));
        }
        // Only an empty text gets here with an infinite count, and `"".repeat(Infinity)` is a RangeError.
        if n.is_infinite() {
            return Err(Thrown::Range);
        }
        // What is left is at most 10,000 code units, or an empty text any number of times.
        text(if s.is_empty() { s } else { s.repeat(to_integer_or_infinity(n) as usize) })
    }),
    // The 1-based part of a text split by a separator.
    strict("SPLITPART", 3, Some(3), &[Text, Text, Num], ResultType::String, |a, _| {
        let s = to_text(&a[0])?;
        let separator = to_text(&a[1])?;
        let i = to_number(&a[2])?.trunc();
        // `parts[i - 1]` exists for whole numbers from 1 to the number of parts.
        if !(i >= 1.0 && i <= u32::MAX as f64) {
            return text("");
        }
        let at = i as usize - 1;
        if separator.is_empty() {
            // Split into UTF-16 code units; half of a surrogate pair reads as the whole character.
            return text(if at < utf16_len(&s) { js_slice(&s, at as i64, Some(at as i64 + 1)) } else { String::new() });
        }
        text(s.split(separator.as_str()).nth(at).unwrap_or(""))
    }),
    // The current date and time.
    strict("NOW", 0, Some(0), &[], ResultType::Date, |_, now| Ok(Val::Date { ms: now, date_only: false })),
    // Today's date (UTC).
    strict("TODAY", 0, Some(0), &[], ResultType::Date, |_, now| {
        Ok(Val::Date { ms: date_utc(&[field(now, |f| f.year), field(now, |f| f.month), field(now, |f| f.date)]), date_only: true })
    }),
    // A date from year, month and day.
    strict("DATE", 3, Some(3), &[Num, Num, Num], ResultType::Date, |a, _| {
        Ok(Val::Date { ms: date_utc(&[to_number(&a[0])?, to_number(&a[1])? - 1.0, to_number(&a[2])?]), date_only: true })
    }),
    // Year of a date (UTC).
    strict("YEAR", 1, Some(1), &[Day], ResultType::Number, |a, _| date_field("YEAR", a, |f| f.year, 0.0)),
    // Month of a date (UTC).
    strict("MONTH", 1, Some(1), &[Day], ResultType::Number, |a, _| date_field("MONTH", a, |f| f.month, 1.0)),
    // Day of a date (UTC).
    strict("DAY", 1, Some(1), &[Day], ResultType::Number, |a, _| date_field("DAY", a, |f| f.date, 0.0)),
    // Hour of a date (UTC).
    strict("HOUR", 1, Some(1), &[Day], ResultType::Number, |a, _| date_field("HOUR", a, |f| f.hours, 0.0)),
    // Minute of a date (UTC).
    strict("MINUTE", 1, Some(1), &[Day], ResultType::Number, |a, _| date_field("MINUTE", a, |f| f.minutes, 0.0)),
    // Weekday of a date (UTC).
    strict("WEEKDAY", 1, Some(1), &[Day], ResultType::Number, |a, _| date_field("WEEKDAY", a, |f| f.weekday, 1.0)),
    // Adds an amount of a unit (days, weeks, months, years, hours, minutes, seconds).
    strict("DATEADD", 3, Some(3), &[Day, Num, Text], ResultType::Date, |a, _| date_add("DATEADD", a, 1.0)),
    // Subtracts an amount of a unit.
    strict("DATESUBTRACT", 3, Some(3), &[Day, Num, Text], ResultType::Date, |a, _| date_add("DATESUBTRACT", a, -1.0)),
    // Whole units from the first date to the second.
    strict("DATEDIFF", 2, Some(3), &[Day, Day, Text], ResultType::Number, |a, _| {
        let from = date_arg("DATEDIFF", &a[0])?.0;
        let to = date_arg("DATEDIFF", &a[1])?.0;
        number(match unit_name("DATEDIFF", a.get(2))? {
            Unit::Month => months_between(from, to),
            Unit::Year => (months_between(from, to) / 12.0).trunc(),
            Unit::Fixed(length) => ((to - from) / length).trunc(),
            Unit::Inherited => f64::NAN,
        })
    }),
    // Formats a date with YYYY, YY, MM, DD, HH, mm and ss (UTC).
    strict("FORMATDATE", 2, Some(2), &[Day, Text], ResultType::String, |a, _| {
        let ms = date_arg("FORMATDATE", &a[0])?.0;
        let formatted = format_date(ms, &to_text(&a[1])?);
        check_length(formatted.len(), || units(&formatted))?;
        text(formatted)
    }),
    // Reads a value as a number.
    strict("TONUMBER", 1, Some(1), &[Any], ResultType::Number, |a, _| number(to_number(&a[0])?)),
    // Reads a value as text.
    strict("TOTEXT", 1, Some(1), &[Any], ResultType::String, |a, _| text(to_text(&a[0])?)),
    // Reads a value as true or false.
    strict("TOBOOLEAN", 1, Some(1), &[Any], ResultType::Boolean, |a, _| Ok(Val::Bool(to_boolean(&a[0])))),
    // Reads a value as a date.
    strict("TODATE", 1, Some(1), &[Any], ResultType::Date, |a, _| {
        if is_blank(&a[0]) {
            return Ok(Val::Null);
        }
        match to_date(&a[0]) {
            Some((ms, date_only)) => Ok(Val::Date { ms, date_only }),
            None => Err(value_error(format!("Cannot read \"{}\" as a date", to_text(&a[0])?))),
        }
    }),
];

/// The function with this upper-case name.
fn lookup_function(name: &str) -> Option<&'static Function> {
    FUNCTIONS.iter().find(|function| function.name == name)
}

/// The names of all functions, in the order the TypeScript declares them.
pub fn function_names() -> Vec<&'static str> {
    FUNCTIONS.iter().map(|function| function.name).collect()
}

// ---------------------------------------------------------------------------
// Compilation: resolve names, infer types, detect cycles.

/// Static type a property contributes to a formula; choice, people, file and page values read as empty.
fn property_value_type(prop: &Property) -> Static {
    match prop.type_.as_str() {
        "number" => Static::Number,
        "text" | "longText" | "url" | "email" => Static::String,
        "checkbox" => Static::Boolean,
        "date" | "createdAt" | "lastEditedAt" => Static::Date,
        // `prop.options.resultType ?? "null"`
        "formula" => match prop.options.get("resultType") {
            None | Some(Value::Null) => Static::Null,
            Some(Value::String(name)) => match name.as_str() {
                "number" => Static::Number,
                "string" => Static::String,
                "boolean" => Static::Boolean,
                "date" => Static::Date,
                "null" => Static::Null,
                other => Static::Other(other.to_owned()),
            },
            Some(other) => Static::Other(crate::jsutil::js_string(other)),
        },
        _ => Static::Null,
    }
}

/// A checked formula: its inferred result type (`number`, `string`,
/// `boolean`, `date` or `null`), the ids of the properties it reads, in
/// order of first use, and the syntax tree with those ids resolved.
#[derive(Debug, Clone)]
pub struct Compiled {
    pub result_type: String,
    pub dependencies: Vec<String>,
    ast: Ast,
}

fn accepts(param: Param, type_: &Static) -> bool {
    if *type_ == Static::Null || param == Param::Any || param == Param::String {
        return true;
    }
    match param {
        Param::Number => matches!(type_, Static::Number | Static::Boolean),
        Param::Boolean => *type_ != Static::Date,
        _ => matches!(type_, Static::Date | Static::String),
    }
}

fn param_label(param: Param) -> &'static str {
    match param {
        Param::Any => "empty",
        Param::String => "text",
        Param::Number => "a number",
        Param::Boolean => "a true/false value",
        Param::Date => "a date",
    }
}

/// `prop.options.dependencies ?? []`, the strings in it.
fn dependencies_of(prop: &Property) -> impl Iterator<Item = &str> {
    prop.options.get("dependencies").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
}

/// Parses and checks a formula for the property `self_id` against the other
/// properties of the base. The error carries a readable message.
///
/// Errors are found in the order the TypeScript finds them: a syntax error
/// first; then, walking the expression left to right, the first unknown
/// function, wrong number of arguments or type mismatch; a reference to a
/// property that does not exist only if nothing else is wrong; and last a
/// circular reference.
pub fn compile_formula(source: &str, props: &[Property], self_id: Option<&str>) -> Result<Compiled, FormulaSyntaxError> {
    let mut ast = parse(source)?;
    let others: Vec<&Property> = props.iter().filter(|p| Some(p.id.as_str()) != self_id).collect();
    let resolve = |name: &str| -> Option<&Property> {
        let folded = js_trim(name).to_lowercase();
        others.iter().find(|p| p.name == name).or_else(|| others.iter().find(|p| js_trim(&p.name).to_lowercase() == folded)).copied()
    };
    let mut dependencies: Vec<String> = Vec::new();
    let mut missing: Option<FormulaSyntaxError> = None;

    enum Visit {
        Enter(NodeId),
        Exit(NodeId),
    }
    let mut visits = vec![Visit::Enter(ast.root)];
    let mut types: Vec<Static> = Vec::new();
    while let Some(visit) = visits.pop() {
        match visit {
            Visit::Enter(id) => match &mut ast.nodes[id as usize] {
                Node::Lit(value) => types.push(match value {
                    Val::Null => Static::Null,
                    Val::Num(_) => Static::Number,
                    Val::Bool(_) => Static::Boolean,
                    _ => Static::String,
                }),
                Node::Prop { name, id: resolved, span } => match resolve(name) {
                    None => {
                        missing.get_or_insert_with(|| FormulaSyntaxError::new(format!("No property named \"{name}\""), Some(*span)));
                        types.push(Static::Null);
                    }
                    Some(prop) => {
                        *resolved = Some(prop.id.clone());
                        if !dependencies.contains(&prop.id) {
                            dependencies.push(prop.id.clone());
                        }
                        types.push(property_value_type(prop));
                    }
                },
                Node::Neg(arg) | Node::Not(arg) => {
                    visits.push(Visit::Exit(id));
                    visits.push(Visit::Enter(*arg));
                }
                Node::Bin { l, r, .. } => {
                    visits.push(Visit::Exit(id));
                    visits.push(Visit::Enter(*r));
                    visits.push(Visit::Enter(*l));
                }
                Node::Call { name, function, args, span } => {
                    let Some(function) = function else {
                        return Err(FormulaSyntaxError::new(format!("Unknown function \"{name}\""), Some(*span)));
                    };
                    let n = args.len();
                    if n < function.min || function.max.is_some_and(|max| n > max) {
                        let plural = |k: usize| format!("{k} argument{}", if k == 1 { "" } else { "s" });
                        let expected = match function.max {
                            Some(max) if max == function.min => format!("exactly {}", plural(function.min)),
                            None => format!("at least {}", plural(function.min)),
                            Some(max) => format!("between {} and {}", function.min, plural(max)),
                        };
                        return Err(FormulaSyntaxError::new(format!("{name} takes {expected}, but got {n}"), Some(*span)));
                    }
                    visits.push(Visit::Exit(id));
                    visits.extend(args.iter().rev().map(|arg| Visit::Enter(*arg)));
                }
            },
            Visit::Exit(id) => match &ast.nodes[id as usize] {
                Node::Neg(_) => {
                    types.pop();
                    types.push(Static::Number);
                }
                Node::Not(_) => {
                    types.pop();
                    types.push(Static::Boolean);
                }
                Node::Bin { op, .. } => {
                    let r = types.pop().expect("right type");
                    let l = types.pop().expect("left type");
                    types.push(match op {
                        BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div | BinOp::Rem | BinOp::Pow => {
                            for (side, type_) in [("left", &l), ("right", &r)] {
                                if !accepts(Param::Number, type_) {
                                    return Err(FormulaSyntaxError::new(
                                        format!("The {side} side of \"{}\" must be a number, not {}", op.symbol(), type_.label()),
                                        None,
                                    ));
                                }
                            }
                            Static::Number
                        }
                        BinOp::Concat => Static::String,
                        BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => {
                            let loose = |t: &Static| matches!(t, Static::Null | Static::String);
                            if (l == Static::Date) != (r == Static::Date) && !loose(&l) && !loose(&r) {
                                return Err(FormulaSyntaxError::new(format!("Cannot compare {} with {}", l.label(), r.label()), None));
                            }
                            Static::Boolean
                        }
                        _ => Static::Boolean,
                    });
                }
                Node::Call { name, function, args, .. } => {
                    let function = function.expect("checked on entry");
                    let arg_types = types.split_off(types.len() - args.len());
                    for (i, type_) in arg_types.iter().enumerate() {
                        let param = function.params.get(i.min(function.params.len().saturating_sub(1))).copied().unwrap_or(Param::Any);
                        if !accepts(param, type_) {
                            return Err(FormulaSyntaxError::new(
                                format!("{name} argument {} must be {}, not {}", i + 1, param_label(param), type_.label()),
                                None,
                            ));
                        }
                    }
                    types.push(result_type(function.result, &arg_types));
                }
                Node::Lit(_) | Node::Prop { .. } => unreachable!("leaves are not revisited"),
            },
        }
    }
    let result = types.pop().expect("the type of the formula");
    if let Some(error) = missing {
        return Err(error);
    }

    // A formula may not reach itself through other formulas. (An empty id is
    // "no id" to the TypeScript, which skips the check for it.)
    if let Some(self_id) = self_id.filter(|id| !id.is_empty()) {
        let by_id: HashMap<&str, &Property> = props.iter().map(|p| (p.id.as_str(), p)).collect();
        let mut seen: HashSet<&str> = HashSet::new();
        let mut stack: Vec<&str> = dependencies.iter().map(String::as_str).collect();
        while let Some(id) = stack.pop() {
            if id == self_id {
                return Err(FormulaSyntaxError::new("Formula would create a circular reference", None));
            }
            if !seen.insert(id) {
                continue;
            }
            if let Some(prop) = by_id.get(id).filter(|p| p.type_ == "formula") {
                stack.extend(dependencies_of(prop));
            }
        }
    }
    Ok(Compiled { result_type: result.as_str().to_owned(), dependencies, ast })
}

/// Rewrites `prop("old")` references after a property rename so sources stay
/// readable. A source that does not tokenize is returned unchanged.
pub fn rename_in_source(source: &str, old_name: &str, new_name: &str) -> String {
    let Ok(tokens) = tokenize(source) else {
        return source.to_owned();
    };
    let quoted = js_json(&Value::String(new_name.to_owned()));
    let old = js_trim(old_name).to_lowercase();
    let mut out = String::new();
    let mut last = 0;
    for window in tokens.windows(3) {
        let (name, open, arg) = (&window[0], &window[1], &window[2]);
        if name.kind == TokenKind::Ident && name.text.eq_ignore_ascii_case("prop") && open.kind == TokenKind::LParen && arg.kind == TokenKind::String
        {
            if js_trim(&arg.string).to_lowercase() != old {
                continue;
            }
            out.push_str(&source[last..arg.bytes.0]);
            out.push_str(&quoted);
            last = arg.bytes.1;
        }
    }
    out.push_str(&source[last..]);
    out
}

// ---------------------------------------------------------------------------
// Evaluation

/// Ids of formulas that depend, directly or through other formulas, on any
/// of `changed`, in the order they are found.
pub fn affected_formulas(props: &[Property], changed: &[String]) -> Vec<String> {
    let formulas: Vec<&Property> = props.iter().filter(|p| p.type_ == "formula").collect();
    let mut result: Vec<String> = Vec::new();
    let mut found: HashSet<&str> = HashSet::new();
    let mut queue: std::collections::VecDeque<&str> = changed.iter().map(String::as_str).collect();
    while let Some(id) = queue.pop_front() {
        for formula in &formulas {
            if !found.contains(formula.id.as_str()) && dependencies_of(formula).any(|dependency| dependency == id) {
                found.insert(&formula.id);
                result.push(formula.id.clone());
                queue.push_back(&formula.id);
            }
        }
    }
    result
}

/// Compiled formulas, by everything a compilation depends on.
///
/// The TypeScript memoizes too, by the formula's id and source and the ids,
/// names and types of all properties. That key leaves out the other
/// formulas' result types and dependencies, which compilation also reads, so
/// its cache can hold an answer for a base that has since changed. This key
/// holds those as well: a hit is always what a fresh compilation would give.
static COMPILED: OnceLock<Mutex<HashMap<String, Option<Arc<Compiled>>>>> = OnceLock::new();
const CACHE_LIMIT: usize = 500;

fn compile_cached(prop: &Property, props: &[Property], props_key: &str) -> Option<Arc<Compiled>> {
    // `prop.options.source ?? ""`; a source that is not a string cannot be compiled.
    let source = match prop.options.get("source") {
        None | Some(Value::Null) => "",
        Some(Value::String(source)) => source.as_str(),
        Some(_) => return None,
    };
    let key = js_json(&json!([prop.id, source, props_key]));
    let cache = COMPILED.get_or_init(Default::default);
    if let Some(hit) = cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&key) {
        return hit.clone();
    }
    let compiled = compile_formula(source, props, Some(&prop.id)).ok().map(Arc::new);
    let mut cache = cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if cache.len() > CACHE_LIMIT {
        cache.clear();
    }
    cache.insert(key, compiled.clone());
    compiled
}

/// What the evaluator has started and not finished, innermost last.
enum Frame<'a> {
    /// Evaluate a node; its value goes on the value stack.
    Eval(NodeId),
    Neg,
    Not,
    /// Apply an operator to the two values on top.
    Bin(BinOp),
    /// The left side of `and`/`or` is on top; the right side is evaluated only if needed.
    AndRight(NodeId),
    OrRight(NodeId),
    ToBoolean,
    /// Call a function with the top `usize` values.
    Call(Strict, usize),
    /// `IF`: the condition is on top.
    If(&'a [NodeId]),
    /// `IFS`: the condition at this index is on top.
    Ifs(&'a [NodeId], usize),
    /// `SWITCH`: the case at this index is on top of the subject (index 0: only the subject).
    Switch(&'a [NodeId], usize),
    /// `SWITCH`: the result is on top of the subject.
    SwitchEnd,
    /// `AND(...)` / `OR(...)`: the argument at this index is on top.
    Every(&'a [NodeId], usize),
    Any(&'a [NodeId], usize),
    /// `COALESCE`: the argument at this index is on top.
    Coalesce(&'a [NodeId], usize),
    /// `ISERROR` / `IFERROR`: the first argument is being evaluated; the
    /// value stack was this high. An error unwinds to here.
    IsError(usize),
    IfError(NodeId, usize),
}

struct Evaluator<'a> {
    props: &'a [Property],
    by_id: HashMap<&'a str, usize>,
    cells: &'a Map<String, Value>,
    created_at: &'a str,
    updated_at: &'a str,
    now: f64,
    /// Values of formulas already computed for this row.
    memo: HashMap<&'a str, Val>,
    /// Formulas being computed, to detect loops.
    in_flight: HashSet<&'a str>,
    compiled: HashMap<usize, Option<Arc<Compiled>>>,
    props_key: String,
}

const DELETED: &str = "A property this formula uses was deleted";

impl<'a> Evaluator<'a> {
    fn read_property(&mut self, id: &str, depth: usize) -> Result<Val, Thrown> {
        let Some(&index) = self.by_id.get(id) else {
            return Err(eval_error("MISSING_PROP", DELETED));
        };
        let props = self.props;
        let prop = &props[index];
        if prop.type_ == "formula" {
            return self.evaluate_formula(index, depth + 1);
        }
        let from_meta;
        let raw = match prop.type_.as_str() {
            "createdAt" => {
                from_meta = Value::String(self.created_at.to_owned());
                Some(&from_meta)
            }
            "lastEditedAt" => {
                from_meta = Value::String(self.updated_at.to_owned());
                Some(&from_meta)
            }
            _ => self.cells.get(id),
        };
        Ok(match (prop.type_.as_str(), raw) {
            ("number", Some(Value::Number(n))) => Val::Num(number_value(n)),
            ("text" | "longText" | "url" | "email", Some(Value::String(s))) => Val::Str(s.clone()),
            ("checkbox", raw) => Val::Bool(raw == Some(&Value::Bool(true))),
            ("date" | "createdAt" | "lastEditedAt", Some(Value::String(s))) => match to_date(&Val::Str(s.clone())) {
                Some((ms, date_only)) => Val::Date { ms, date_only },
                None => Val::Null,
            },
            _ => Val::Null,
        })
    }

    fn evaluate_formula(&mut self, index: usize, depth: usize) -> Result<Val, Thrown> {
        let props = self.props;
        let prop = &props[index];
        let id = prop.id.as_str();
        if let Some(value) = self.memo.get(id) {
            return Ok(value.clone());
        }
        if self.in_flight.contains(id) {
            return Err(eval_error("CYCLE", "Formulas reference each other in a loop"));
        }
        if depth >= MAX_DEPTH {
            return Err(eval_error("DEPTH", "Formulas are nested too deeply"));
        }
        let compiled = match self.compiled.get(&index) {
            Some(compiled) => compiled.clone(),
            None => {
                let compiled = compile_cached(prop, props, &self.props_key);
                self.compiled.insert(index, compiled.clone());
                compiled
            }
        };
        let Some(compiled) = compiled else {
            return Err(eval_error("MISSING_PROP", DELETED));
        };
        self.in_flight.insert(id);
        let result = self.run(&compiled.ast, depth);
        self.in_flight.remove(id);
        if let Ok(value) = &result {
            self.memo.insert(id, value.clone());
        }
        result
    }

    /// Evaluates a tree. The control stack holds what is left to do and the
    /// value stack the results so far; arguments are evaluated left to
    /// right, and the functions that choose among their arguments evaluate
    /// only the ones the TypeScript would.
    fn run(&mut self, ast: &Ast, depth: usize) -> Result<Val, Thrown> {
        let mut frames: Vec<Frame> = vec![Frame::Eval(ast.root)];
        let mut values: Vec<Val> = Vec::new();
        while let Some(frame) = frames.pop() {
            match self.step(ast, depth, frame, &mut frames, &mut values) {
                Ok(()) => {}
                Err(Thrown::Range) => return Err(Thrown::Range),
                Err(error) => {
                    // Unwind to the nearest ISERROR or IFERROR still evaluating its first argument.
                    loop {
                        match frames.pop() {
                            None => return Err(error),
                            Some(Frame::IsError(height)) => {
                                values.truncate(height);
                                values.push(Val::Bool(true));
                                break;
                            }
                            Some(Frame::IfError(fallback, height)) => {
                                values.truncate(height);
                                frames.push(Frame::Eval(fallback));
                                break;
                            }
                            Some(_) => {}
                        }
                    }
                }
            }
        }
        Ok(values.pop().expect("the value of the formula"))
    }

    fn step<'t>(&mut self, ast: &'t Ast, depth: usize, frame: Frame<'t>, frames: &mut Vec<Frame<'t>>, values: &mut Vec<Val>) -> Result<(), Thrown> {
        let pop = |values: &mut Vec<Val>| values.pop().expect("a value");
        match frame {
            Frame::Eval(id) => match ast.node(id) {
                Node::Lit(value) => values.push(value.clone()),
                Node::Prop { id, .. } => match id.as_deref() {
                    // An empty id is as good as none to the TypeScript (`if (!e.id)`).
                    None | Some("") => return Err(eval_error("MISSING_PROP", DELETED)),
                    Some(id) => values.push(self.read_property(id, depth)?),
                },
                Node::Neg(arg) => frames.extend([Frame::Neg, Frame::Eval(*arg)]),
                Node::Not(arg) => frames.extend([Frame::Not, Frame::Eval(*arg)]),
                Node::Bin { op: BinOp::And, l, r } => frames.extend([Frame::AndRight(*r), Frame::Eval(*l)]),
                Node::Bin { op: BinOp::Or, l, r } => frames.extend([Frame::OrRight(*r), Frame::Eval(*l)]),
                Node::Bin { op, l, r } => frames.extend([Frame::Bin(*op), Frame::Eval(*r), Frame::Eval(*l)]),
                Node::Call { function, args, .. } => {
                    let function = function.expect("a compiled call");
                    match function.body {
                        Body::Strict(call) => {
                            frames.push(Frame::Call(call, args.len()));
                            frames.extend(args.iter().rev().map(|arg| Frame::Eval(*arg)));
                        }
                        Body::If => frames.extend([Frame::If(args), Frame::Eval(args[0])]),
                        Body::Ifs => frames.extend([Frame::Ifs(args, 0), Frame::Eval(args[0])]),
                        Body::Switch => frames.extend([Frame::SwitchEnd, Frame::Switch(args, 0), Frame::Eval(args[0])]),
                        Body::And => frames.extend([Frame::Every(args, 0), Frame::Eval(args[0])]),
                        Body::Or => frames.extend([Frame::Any(args, 0), Frame::Eval(args[0])]),
                        Body::IsError => frames.extend([Frame::IsError(values.len()), Frame::Eval(args[0])]),
                        Body::IfError => frames.extend([Frame::IfError(args[1], values.len()), Frame::Eval(args[0])]),
                        Body::Coalesce => frames.extend([Frame::Coalesce(args, 0), Frame::Eval(args[0])]),
                    }
                }
            },
            Frame::Neg => {
                let value = pop(values);
                values.push(Val::Num(snap(-to_number(&value)?)));
            }
            Frame::Not => {
                let value = pop(values);
                values.push(Val::Bool(!to_boolean(&value)));
            }
            Frame::AndRight(right) => {
                if to_boolean(&pop(values)) {
                    frames.extend([Frame::ToBoolean, Frame::Eval(right)]);
                } else {
                    values.push(Val::Bool(false));
                }
            }
            Frame::OrRight(right) => {
                if to_boolean(&pop(values)) {
                    values.push(Val::Bool(true));
                } else {
                    frames.extend([Frame::ToBoolean, Frame::Eval(right)]);
                }
            }
            Frame::ToBoolean => {
                let value = pop(values);
                values.push(Val::Bool(to_boolean(&value)));
            }
            Frame::Bin(op) => {
                let r = pop(values);
                let l = pop(values);
                values.push(if op == BinOp::Concat { Val::Str(concat(l, &r)?) } else { binary(op, &l, &r)? });
            }
            Frame::Call(call, arity) => {
                let args = values.split_off(values.len() - arity);
                values.push(call(&args, self.now)?);
            }
            Frame::If(args) => {
                if to_boolean(&pop(values)) {
                    frames.push(Frame::Eval(args[1]));
                } else if let Some(otherwise) = args.get(2) {
                    frames.push(Frame::Eval(*otherwise));
                } else {
                    values.push(Val::Null);
                }
            }
            Frame::Ifs(args, at) => {
                if to_boolean(&pop(values)) {
                    frames.push(Frame::Eval(args[at + 1]));
                } else if at + 3 < args.len() {
                    frames.extend([Frame::Ifs(args, at + 2), Frame::Eval(args[at + 2])]);
                } else if args.len() % 2 == 1 {
                    frames.push(Frame::Eval(args[args.len() - 1]));
                } else {
                    values.push(Val::Null);
                }
            }
            Frame::Switch(args, at) => {
                if at > 0 {
                    let case = pop(values);
                    if values_equal(values.last().expect("the subject"), &case)? {
                        frames.push(Frame::Eval(args[at + 1]));
                        return Ok(());
                    }
                }
                let next = if at == 0 { 1 } else { at + 2 };
                if next + 1 < args.len() {
                    frames.extend([Frame::Switch(args, next), Frame::Eval(args[next])]);
                } else if args.len() % 2 == 0 {
                    frames.push(Frame::Eval(args[args.len() - 1]));
                } else {
                    values.push(Val::Null);
                }
            }
            Frame::SwitchEnd => {
                let result = pop(values);
                pop(values);
                values.push(result);
            }
            Frame::Every(args, at) => {
                if !to_boolean(&pop(values)) {
                    values.push(Val::Bool(false));
                } else if at + 1 < args.len() {
                    frames.extend([Frame::Every(args, at + 1), Frame::Eval(args[at + 1])]);
                } else {
                    values.push(Val::Bool(true));
                }
            }
            Frame::Any(args, at) => {
                if to_boolean(&pop(values)) {
                    values.push(Val::Bool(true));
                } else if at + 1 < args.len() {
                    frames.extend([Frame::Any(args, at + 1), Frame::Eval(args[at + 1])]);
                } else {
                    values.push(Val::Bool(false));
                }
            }
            Frame::Coalesce(args, at) => {
                if is_blank(values.last().expect("a value")) {
                    pop(values);
                    if at + 1 < args.len() {
                        frames.extend([Frame::Coalesce(args, at + 1), Frame::Eval(args[at + 1])]);
                    } else {
                        values.push(Val::Null);
                    }
                }
            }
            // The first argument evaluated without an error.
            Frame::IsError(_) => {
                pop(values);
                values.push(Val::Bool(false));
            }
            Frame::IfError(..) => {}
        }
        Ok(())
    }
}

/// An arithmetic, text or comparison operator on two values. The operands
/// are converted in the order the TypeScript converts them, which decides
/// the error when both are wrong: the divisor of `/` and `%` comes first.
fn binary(op: BinOp, l: &Val, r: &Val) -> Result<Val, Thrown> {
    Ok(match op {
        BinOp::Add => Val::Num(snap(to_number(l)? + to_number(r)?)),
        BinOp::Sub => Val::Num(snap(to_number(l)? - to_number(r)?)),
        BinOp::Mul => Val::Num(snap(to_number(l)? * to_number(r)?)),
        BinOp::Div => {
            let d = to_number(r)?;
            if d == 0.0 {
                return Err(eval_error("DIV_BY_ZERO", "Cannot divide by zero"));
            }
            Val::Num(snap(to_number(l)? / d))
        }
        BinOp::Rem => {
            let d = to_number(r)?;
            if d == 0.0 {
                return Err(eval_error("DIV_BY_ZERO", "Cannot take a remainder by zero"));
            }
            Val::Num(snap(to_number(l)? % d))
        }
        BinOp::Pow => Val::Num(snap(pow(to_number(l)?, to_number(r)?))),
        BinOp::Eq => Val::Bool(values_equal(l, r)?),
        BinOp::Ne => Val::Bool(!values_equal(l, r)?),
        BinOp::Lt => Val::Bool(compare(l, r)? < 0.0),
        BinOp::Le => Val::Bool(compare(l, r)? <= 0.0),
        BinOp::Gt => Val::Bool(compare(l, r)? > 0.0),
        BinOp::Ge => Val::Bool(compare(l, r)? >= 0.0),
        BinOp::And | BinOp::Or | BinOp::Concat => unreachable!("evaluated by the machine itself"),
    })
}

/// `&`: the text of both values, joined. The left text is extended in place,
/// so a long chain of `&` costs its length and not the square of it (in
/// JavaScript such a chain is a rope, which costs nothing until it is read).
fn concat(l: Val, r: &Val) -> Result<String, Thrown> {
    let mut left = match l {
        Val::Str(text) => text,
        other => to_text(&other)?,
    };
    let converted;
    let right = match r {
        Val::Str(text) => text.as_str(),
        other => {
            converted = to_text(other)?;
            converted.as_str()
        }
    };
    check_length(left.len() + right.len(), || units(&left) + units(right))?;
    left.push_str(right);
    Ok(left)
}

/// Computes formula values for one row. Returns the stored value per formula
/// id in `only` (all formulas when `None`), in property order: a number,
/// text, boolean, date string, `null`, or an error value `{error, message}`.
///
/// `created_at` and `updated_at` are the row's timestamps as ISO strings,
/// read by `createdAt` and `lastEditedAt` properties; `now_ms` is what
/// `NOW()` and `TODAY()` see.
pub fn compute_formulas(
    props: &[Property],
    cells: &Map<String, Value>,
    created_at: &str,
    updated_at: &str,
    only: Option<&[String]>,
    now_ms: f64,
) -> Map<String, Value> {
    let mut out = Map::new();
    if !props.iter().any(|p| p.type_ == "formula") {
        return out;
    }
    // Everything about the properties that a compilation reads.
    let props_key = js_json(&Value::Array(
        props
            .iter()
            .map(|p| {
                if p.type_ == "formula" {
                    json!([p.id, p.name, p.type_, p.options.get("resultType"), p.options.get("dependencies")])
                } else {
                    json!([p.id, p.name, p.type_])
                }
            })
            .collect(),
    ));
    let mut evaluator = Evaluator {
        props,
        // Of two properties with one id, the later one answers `prop()` lookups.
        by_id: props.iter().enumerate().map(|(index, p)| (p.id.as_str(), index)).collect(),
        cells,
        created_at,
        updated_at,
        now: now_ms,
        memo: HashMap::new(),
        in_flight: HashSet::new(),
        compiled: HashMap::new(),
        props_key,
    };
    for (index, prop) in props.iter().enumerate() {
        if prop.type_ != "formula" || only.is_some_and(|only| !only.contains(&prop.id)) {
            continue;
        }
        let stored = match evaluator.evaluate_formula(index, 0).and_then(|value| to_stored(&value)) {
            Ok(value) => value,
            Err(Thrown::Eval { code, message }) => json!({ "error": code, "message": message }),
            Err(Thrown::Range) => json!({ "error": "DEPTH", "message": "Formula is too deeply nested" }),
        };
        out.insert(prop.id.clone(), stored);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(source: &str) -> String {
        fn show(ast: &Ast, id: NodeId) -> String {
            match ast.node(id) {
                Node::Lit(Val::Num(n)) => number_to_string(*n),
                Node::Lit(Val::Str(s)) => format!("{s:?}"),
                Node::Lit(Val::Bool(b)) => b.to_string(),
                Node::Lit(_) => "null".to_owned(),
                Node::Prop { name, .. } => format!("prop({name})"),
                Node::Call { name, args, .. } => format!("{name}({})", args.iter().map(|a| show(ast, *a)).collect::<Vec<_>>().join(", ")),
                Node::Neg(a) => format!("(-{})", show(ast, *a)),
                Node::Not(a) => format!("(not {})", show(ast, *a)),
                Node::Bin { op, l, r } => format!("({} {} {})", show(ast, *l), op.symbol(), show(ast, *r)),
            }
        }
        match parse(source) {
            Ok(ast) => show(&ast, ast.root),
            Err(error) => format!("error: {} {:?}", error.message, error.span),
        }
    }

    #[test]
    fn parses_with_the_grammar_s_precedence() {
        assert_eq!(tree("1 + 2 * 3"), "(1 + (2 * 3))");
        assert_eq!(tree("-2^2"), "(-(2 ^ 2))");
        assert_eq!(tree("2^3^2"), "(2 ^ (3 ^ 2))");
        assert_eq!(tree("2^-3*4"), "((2 ^ (-3)) * 4)");
        assert_eq!(tree("2^-3^4"), "(2 ^ (-(3 ^ 4)))");
        assert_eq!(tree("1 - 2 - 3"), "((1 - 2) - 3)");
        assert_eq!(tree("not 1 = 2 and 3"), "((not (1 = 2)) and 3)");
        assert_eq!(tree("not not true or false"), "((not (not true)) or false)");
        assert_eq!(tree("1 < 2 <> 3 & 4"), "((1 < 2) != (3 & 4))");
        assert_eq!(tree("+-+1"), "(-1)");
        assert_eq!(tree("not(1)"), "NOT(1)");
        assert_eq!(tree("a(1, b(), prop('x'))"), "A(1, B(), prop(x))");
        assert_eq!(tree("1 = not 2"), "error: Unknown name \"not\". Reference a property with prop(\"not\"). Some((4, 7))");
        assert_eq!(tree("(1"), "error: The formula ended unexpectedly Some((2, 2))");
        assert_eq!(tree("f(1,)"), "error: Unexpected \")\" Some((4, 5))");
        assert_eq!(tree("1 2"), "error: Unexpected \"2\" Some((2, 3))");
        assert_eq!(tree("'a😀' @"), "error: Unexpected character \"@\" Some((6, 7))");
    }

    #[test]
    fn counts_code_units_over_bytes() {
        for s in ["", "abc", "é", "日本語", "😀", "a😀b😀", "\u{FEFF}\u{10FFFF}\u{7FF}\u{800}\u{FFFF}\u{10000}"] {
            assert_eq!(units(s), utf16_len(s), "{s:?}");
        }
    }

    #[test]
    fn deep_nesting_does_not_exhaust_the_stack() {
        // Run on a thread with a small stack, where recursion over the depth would overflow.
        std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(|| {
                let formula = |source: String| Property {
                    id: "f".into(),
                    name: "F".into(),
                    type_: "formula".into(),
                    options: json!({ "source": source }).as_object().unwrap().clone(),
                    is_primary: false,
                    position: "a0".into(),
                };
                let value = |source: String| compute_formulas(&[formula(source)], &Map::new(), "", "", None, 0.0)["f"].clone();
                assert_eq!(value(format!("{}1{}", "(".repeat(4999), ")".repeat(4999))), json!(1));
                assert_eq!(value(format!("{}1", "-".repeat(9999))), json!(-1));
                assert_eq!(value(format!("{}true", "not ".repeat(2499))), json!(false));
                assert_eq!(value(format!("{}1{}", "ABS(".repeat(1999), ")".repeat(1999))), json!(1));
                assert_eq!(value(format!("{}1{}", "IF(1,".repeat(1666), ")".repeat(1666))), json!(1));
                assert_eq!(value(format!("1{}", "+1".repeat(4999))), json!(5000));
                assert_eq!(value(format!("{}1", "1-".repeat(4999))), json!(-4998));
            })
            .unwrap()
            .join()
            .unwrap();
    }
}
