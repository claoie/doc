//! Port of `src/common/editor/doc-schema.ts`: the node and mark types of a document.

use std::sync::OnceLock;

use serde_json::{json, Value};

use super::schema::{MarkSpec, NodeSpec, Schema};

const CELL_CONTENT: &str =
    "(paragraph | heading | bulletList | orderedList | taskList | blockquote | callout | image | video | audio | subpages | attachment | mathBlock | details | codeBlock)+";

const SYNCED_CONTENT: &str =
    "(paragraph | heading | blockquote | codeBlock | horizontalRule | bulletList | orderedList | taskList | image | video | audio | attachment | callout | details | embed | mathBlock | table | drawio | excalidraw | pdf | subpages | columns | youtube)+";

fn spec() -> NodeSpec {
    NodeSpec::default()
}

fn block() -> NodeSpec {
    NodeSpec { group: "block", ..spec() }
}

fn media(attrs: Value) -> NodeSpec {
    NodeSpec { group: "block", isolating: true, selectable: true, attrs: Some(attrs), ..spec() }
}

fn inline(attrs: Option<Value>) -> NodeSpec {
    NodeSpec { group: "inline", inline: true, attrs, ..spec() }
}

fn nodes() -> Vec<(&'static str, NodeSpec)> {
    let cell_attrs = || json!({ "colspan": 1, "rowspan": 1, "colwidth": null, "backgroundColor": null, "backgroundColorName": null });
    let drawing_attrs = || {
        json!({
            "src": "", "title": null, "alt": null, "width": null, "height": null, "size": null,
            "aspectRatio": null, "align": "center", "attachmentId": null
        })
    };
    vec![
        ("doc", NodeSpec { content: Some("block+ footnotes?"), ..spec() }),
        (
            "paragraph",
            NodeSpec { content: Some("inline*"), attrs: Some(json!({ "id": null, "textAlign": null, "indent": 0 })), ..block() },
        ),
        (
            "heading",
            NodeSpec { content: Some("inline*"), attrs: Some(json!({ "id": null, "level": 1, "textAlign": null, "indent": 0 })), ..block() },
        ),
        ("blockquote", NodeSpec { content: Some("block+"), ..block() }),
        ("bulletList", NodeSpec { group: "block list", content: Some("listItem+"), ..spec() }),
        (
            "orderedList",
            NodeSpec { group: "block list", content: Some("listItem+"), attrs: Some(json!({ "start": 1, "type": null })), ..spec() },
        ),
        ("listItem", NodeSpec { content: Some("paragraph block*"), ..spec() }),
        ("taskList", NodeSpec { group: "block list", content: Some("taskItem+"), ..spec() }),
        ("taskItem", NodeSpec { content: Some("paragraph block*"), attrs: Some(json!({ "checked": false })), ..spec() }),
        (
            "codeBlock",
            NodeSpec {
                content: Some("text*"),
                marks: Some(""),
                code: true,
                isolating: true,
                attrs: Some(json!({ "language": null })),
                ..block()
            },
        ),
        ("horizontalRule", NodeSpec { selectable: true, ..block() }),
        ("pageBreak", NodeSpec { selectable: true, ..block() }),
        ("hardBreak", inline(None)),
        ("text", NodeSpec { group: "inline", ..spec() }),
        (
            "image",
            media(json!({
                "src": "", "width": null, "height": null, "align": "center", "alt": null,
                "attachmentId": null, "size": null, "aspectRatio": null
            })),
        ),
        (
            "video",
            media(json!({
                "src": "", "alt": null, "attachmentId": null, "width": null, "height": null,
                "size": null, "align": "center", "aspectRatio": null
            })),
        ),
        ("audio", media(json!({ "src": "", "attachmentId": null, "size": null }))),
        ("attachment", media(json!({ "url": "", "name": null, "mime": null, "size": null, "attachmentId": null }))),
        ("pdf", media(json!({ "src": "", "name": null, "attachmentId": null, "size": null, "width": 800, "height": 600 }))),
        ("drawio", media(drawing_attrs())),
        ("excalidraw", media(drawing_attrs())),
        ("table", NodeSpec { content: Some("tableRow+"), isolating: true, ..block() }),
        ("tableRow", NodeSpec { content: Some("(tableCell | tableHeader)*"), ..spec() }),
        ("tableCell", NodeSpec { content: Some(CELL_CONTENT), isolating: true, attrs: Some(cell_attrs()), ..spec() }),
        ("tableHeader", NodeSpec { content: Some(CELL_CONTENT), isolating: true, attrs: Some(cell_attrs()), ..spec() }),
        (
            "callout",
            NodeSpec { content: Some("block+"), isolating: true, attrs: Some(json!({ "type": "info", "icon": null })), ..block() },
        ),
        (
            "details",
            NodeSpec { content: Some("detailsSummary detailsContent"), isolating: true, attrs: Some(json!({ "open": false })), ..block() },
        ),
        ("detailsSummary", NodeSpec { content: Some("inline*"), isolating: true, ..spec() }),
        ("detailsContent", NodeSpec { content: Some("block*"), ..spec() }),
        (
            "columns",
            NodeSpec {
                content: Some("column+"),
                isolating: true,
                attrs: Some(json!({ "layout": "two_equal", "widthMode": "normal" })),
                ..block()
            },
        ),
        ("column", NodeSpec { content: Some("block+"), isolating: true, attrs: Some(json!({ "width": null })), ..spec() }),
        (
            "transclusionSource",
            NodeSpec { content: Some(SYNCED_CONTENT), isolating: true, attrs: Some(json!({ "id": null })), ..block() },
        ),
        (
            "transclusionReference",
            NodeSpec { selectable: true, attrs: Some(json!({ "sourcePageId": null, "transclusionId": null })), ..block() },
        ),
        ("footnotes", NodeSpec { content: Some("footnote*"), isolating: true, attrs: Some(json!({ "class": "footnotes" })), ..spec() }),
        (
            "footnote",
            NodeSpec { content: Some("paragraph+"), isolating: true, attrs: Some(json!({ "id": null, "data-id": null })), ..spec() },
        ),
        ("mathInline", inline(Some(json!({ "text": "" })))),
        ("mathBlock", NodeSpec { selectable: true, attrs: Some(json!({ "text": "" })), ..block() }),
        (
            "mention",
            inline(Some(json!({
                "id": null, "label": null, "entityType": null, "entityId": null,
                "slugId": null, "creatorId": null, "anchorId": null
            }))),
        ),
        ("status", inline(Some(json!({ "text": "", "color": "gray" })))),
        (
            "footnoteReference",
            inline(Some(json!({ "class": "footnote-ref", "data-id": null, "referenceNumber": null, "href": null }))),
        ),
        ("embed", media(json!({ "src": "", "provider": "", "align": "center", "width": 800, "height": 600 }))),
        ("youtube", media(json!({ "src": null, "start": 0, "width": 640, "height": 480 }))),
        ("subpages", NodeSpec { selectable: true, ..block() }),
        ("base", NodeSpec { selectable: true, attrs: Some(json!({ "pageId": null })), ..block() }),
    ]
}

fn marks() -> Vec<(&'static str, MarkSpec)> {
    let plain = MarkSpec::default;
    vec![
        (
            "link",
            MarkSpec {
                inclusive: Some(false),
                attrs: Some(json!({
                    "href": null, "target": "_blank", "rel": "noopener noreferrer nofollow", "class": null, "internal": false
                })),
                ..plain()
            },
        ),
        ("bold", plain()),
        ("italic", plain()),
        ("underline", plain()),
        ("strike", plain()),
        ("code", MarkSpec { inclusive: Some(false), ..plain() }),
        ("highlight", MarkSpec { attrs: Some(json!({ "color": null, "colorName": null })), ..plain() }),
        ("textStyle", MarkSpec { attrs: Some(json!({ "color": null })), ..plain() }),
        ("subscript", plain()),
        ("superscript", plain()),
        (
            "comment",
            MarkSpec { inclusive: Some(false), stackable: true, attrs: Some(json!({ "commentId": null, "resolved": false })) },
        ),
    ]
}

/// The document schema.
pub fn schema() -> &'static Schema {
    static SCHEMA: OnceLock<Schema> = OnceLock::new();
    SCHEMA.get_or_init(|| Schema::new(nodes(), marks()))
}

/// `emptyDoc()`: a document with one empty paragraph.
pub fn empty_doc() -> Value {
    json!({
        "type": "doc",
        "content": [{ "type": "paragraph", "attrs": { "id": null, "textAlign": null, "indent": 0 } }]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_the_document_types() {
        let s = schema();
        assert_eq!(s.mark_names().collect::<Vec<_>>().join(" "), "link bold italic underline strike code highlight textStyle subscript superscript comment");
        assert!(s.is_leaf("image") && s.is_leaf("hardBreak") && s.is_leaf("subpages") && s.is_leaf("nonsense"));
        assert!(!s.is_leaf("text") && !s.is_leaf("paragraph") && !s.is_leaf("detailsContent"));
        assert!(s.is_inline("text") && s.is_inline("mention") && !s.is_inline("paragraph"));
        assert!(s.is_textblock("paragraph") && s.is_textblock("codeBlock") && s.is_textblock("detailsSummary"));
        assert!(!s.is_textblock("blockquote") && !s.is_textblock("doc"));
        assert!(s.allows_mark("paragraph", "bold") && !s.allows_mark("codeBlock", "bold") && !s.allows_mark("doc", "bold"));
        assert_eq!(s.mark_rank("link"), 0);
        assert_eq!(s.mark_rank("comment"), 10);
        assert_eq!(s.mark_rank("unknown"), 11);
        assert_eq!(s.group_members("list"), ["bulletList", "orderedList", "taskList"]);
    }

    #[test]
    fn checks_content() {
        let s = schema();
        assert_eq!(s.check(&empty_doc()), None);
        assert_eq!(s.check(&json!({ "type": "doc", "content": [] })), Some(vec![]));
        let nested = json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": "a" }] },
            { "type": "bulletList", "content": [{ "type": "listItem", "content": [{ "type": "heading" }] }] },
        ]});
        assert_eq!(s.check(&nested), Some(vec![1, 0]));
        let marked = json!({ "type": "doc", "content": [
            { "type": "codeBlock", "content": [{ "type": "text", "text": "a", "marks": [{ "type": "bold" }] }] },
        ]});
        assert_eq!(s.check(&marked), Some(vec![0, 0]));
        let footnotes = json!({ "type": "doc", "content": [{ "type": "paragraph" }, { "type": "footnotes", "content": [] }] });
        assert_eq!(s.check(&footnotes), None);
        let empty_text = json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "" }] }] });
        assert_eq!(s.check(&empty_text), Some(vec![0, 0]));
        assert!(s.valid_content("tableRow", &[]));
        assert!(!s.valid_content("image", &[json!({ "type": "text", "text": "a" })]));
    }
}
