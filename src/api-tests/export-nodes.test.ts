import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type Client, type TestServer } from "./harness";
import { apiError } from "./harness/errors";

/**
 * Every kind of node and mark of the editor's documents
 * (src/common/editor/doc-schema.ts) through both export serializers:
 * `docToMarkdown` (src/common/editor/markdown.ts) and `docToHtml`
 * (src/common/editor/html.ts), in every variant they branch on.
 *
 * Each case is a document stored with `POST /pages` (which removes unsafe URLs
 * but does not enforce the document schema, so odd attribute values and
 * misplaced nodes get through) and exported with
 * `GET /pages/:id/export?format=markdown|html`. `markdown` is the exported
 * text after the `# Title` heading, line by line; `html` is the body of the
 * exported HTML document after its `<h1>`. Both are exact.
 *
 * Links and file URLs that depend on what else is exported are in
 * export.test.ts; here pages link to nothing that exists, so page mentions
 * point at the app's root and file URLs become absolute.
 */

interface NodeCase {
  name: string;
  /** The content of the document. */
  doc: unknown[];
  markdown: string[];
  html: string;
}

let t: TestServer;
let owner: Client;
let spaceId: string;

beforeAll(async () => {
  t = await startServer();
  const setup = await t.setupOwner();
  owner = setup.owner;
  spaceId = setup.spaceId;
});

afterAll(async () => {
  await t.close();
});

const HTML_HEAD =
  '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>T</title>\n' +
  "<style>body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;line-height:1.6}img,video{max-width:100%}pre{background:#f6f8fa;padding:1rem;overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px}</style>\n" +
  "</head>\n<body>\n<h1>T</h1>\n";
const HTML_TAIL = "\n</body>\n</html>\n";

const exported = async (doc: unknown[]) => {
  const created = await owner.post("/pages", { spaceId, title: "T", content: { type: "doc", content: doc } });
  expect(created.status).toBe(200);
  const id = created.body.data.page.id as string;
  const markdown = await owner.raw("GET", `/pages/${id}/export?format=markdown`);
  const html = await owner.raw("GET", `/pages/${id}/export?format=html`);
  return { markdown: { status: markdown.status, text: await markdown.text() }, html: { status: html.status, text: await html.text() } };
};

// prettier-ignore
const CASES: Record<string, NodeCase[]> = {
  "text and its escaping": [
    {
      name: "plain text in any script is written as it is",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"Plain text, naïve café, 日本語, عربى, emoji 😀👍🏽, combining é."}]},
      ],
      markdown: [
        "Plain text, naïve café, 日本語, عربى, emoji 😀👍🏽, combining é.",
      ],
      html: "<p>Plain text, naïve café, 日本語, عربى, emoji 😀👍🏽, combining é.</p>",
    },
    {
      name: "characters with a meaning in Markdown are escaped with a backslash; HTML escapes only & < > \"",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"a*b_c[d]e<f>g~h|i\\j`k & \"q\" 'r'"}]},
      ],
      markdown: [
        "a\\*b\\_c\\[d\\]e\\<f\\>g\\~h\\|i\\\\j\\`k & \"q\" 'r'",
      ],
      html: "<p>a*b_c[d]e&lt;f&gt;g~h|i\\j`k &amp; &quot;q&quot; 'r'</p>",
    },
    {
      name: "== and a $ before a non-space are escaped",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"a == b, a = b, === $5 and $ 5 and 5$ $x$ $"}]},
      ],
      markdown: [
        "a \\== b, a = b, \\=== \\$5 and $ 5 and 5$ \\$x$ $",
      ],
      html: "<p>a == b, a = b, === $5 and $ 5 and 5$ $x$ $</p>",
    },
    {
      name: "a line that would start a block is escaped at its start",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"# not a heading"}]},
        {"type":"paragraph","content":[{"type":"text","text":"###### six"}]},
        {"type":"paragraph","content":[{"type":"text","text":"####### seven is no heading"}]},
        {"type":"paragraph","content":[{"type":"text","text":"#hashtag"}]},
        {"type":"paragraph","content":[{"type":"text","text":"- not a list"}]},
        {"type":"paragraph","content":[{"type":"text","text":"+ plus"}]},
        {"type":"paragraph","content":[{"type":"text","text":"-dash"}]},
        {"type":"paragraph","content":[{"type":"text","text":"1. not ordered"}]},
        {"type":"paragraph","content":[{"type":"text","text":"12) paren"}]},
        {"type":"paragraph","content":[{"type":"text","text":"1.5 is a number"}]},
        {"type":"paragraph","content":[{"type":"text","text":"> quote"}]},
        {"type":"paragraph","content":[{"type":"text","text":">no space"}]},
        {"type":"paragraph","content":[{"type":"text","text":"   # indented"}]},
      ],
      markdown: [
        "\\# not a heading",
        "",
        "\\###### six",
        "",
        "####### seven is no heading",
        "",
        "#hashtag",
        "",
        "\\- not a list",
        "",
        "\\+ plus",
        "",
        "-dash",
        "",
        "\\1. not ordered",
        "",
        "\\12) paren",
        "",
        "1.5 is a number",
        "",
        "\\> quote",
        "",
        "\\>no space",
        "",
        "   \\# indented",
      ],
      html: "<p># not a heading</p><p>###### six</p><p>####### seven is no heading</p><p>#hashtag</p><p>- not a list</p><p>+ plus</p><p>-dash</p><p>1. not ordered</p><p>12) paren</p><p>1.5 is a number</p><p>&gt; quote</p><p>&gt;no space</p><p>   # indented</p>",
    },
    {
      name: "every line of a paragraph with hard breaks is escaped at its start",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"first"},{"type":"hardBreak"},{"type":"text","text":"- second"},{"type":"hardBreak"},{"type":"text","text":"# third"},{"type":"hardBreak"},{"type":"text","text":"4. fourth"}]},
      ],
      markdown: [
        "first\\",
        "\\- second\\",
        "\\# third\\",
        "\\4. fourth",
      ],
      html: "<p>first<br>- second<br># third<br>4. fourth</p>",
    },
    {
      name: "a text node without text, or with an empty list of marks",
      doc: [
        {"type":"paragraph","content":[{"type":"text"},{"type":"text","text":"a"},{"type":"text","text":"b","marks":[]}]},
      ],
      markdown: [
        "ab",
      ],
      html: "<p>ab</p>",
    },
    {
      name: "paragraphs are separated by one blank line; empty ones leave no extra space in Markdown",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"one"}]},
        {"type":"paragraph","content":[]},
        {"type":"paragraph","content":[]},
        {"type":"paragraph"},
        {"type":"paragraph","content":[{"type":"text","text":"two"}]},
        {"type":"paragraph","content":[]},
      ],
      markdown: [
        "one",
        "",
        "two",
      ],
      html: "<p>one</p><p></p><p></p><p></p><p>two</p><p></p>",
    },
    {
      name: "white space inside text is kept",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"  two  spaces\tand a tab  "}]},
      ],
      markdown: [
        "two  spaces\tand a tab",
      ],
      html: "<p>  two  spaces\tand a tab  </p>",
    },
    {
      name: "a line break inside a text node is kept",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"line one\nline two\n- three"}]},
      ],
      markdown: [
        "line one",
        "line two",
        "\\- three",
      ],
      html: "<p>line one\nline two\n- three</p>",
    },
  ],
  "marks": [
    {
      name: "bold, italic, strike, highlight",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"bold","marks":[{"type":"bold"}]},{"type":"text","text":" "},{"type":"text","text":"italic","marks":[{"type":"italic"}]},{"type":"text","text":" "},{"type":"text","text":"strike","marks":[{"type":"strike"}]},{"type":"text","text":" "},{"type":"text","text":"highlight","marks":[{"type":"highlight"}]}]},
      ],
      markdown: [
        "**bold** *italic* ~~strike~~ ==highlight==",
      ],
      html: "<p><strong>bold</strong> <em>italic</em> <s>strike</s> <mark>highlight</mark></p>",
    },
    {
      name: "underline, subscript, superscript are HTML tags in Markdown too",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"under","marks":[{"type":"underline"}]},{"type":"text","text":" H"},{"type":"text","text":"2","marks":[{"type":"subscript"}]},{"type":"text","text":"O x"},{"type":"text","text":"2","marks":[{"type":"superscript"}]}]},
      ],
      markdown: [
        "<u>under</u> H<sub>2</sub>O x<sup>2</sup>",
      ],
      html: "<p><u>under</u> H<sub>2</sub>O x<sup>2</sup></p>",
    },
    {
      name: "inline code is not escaped in Markdown",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"a*b_c[d] <e> & |","marks":[{"type":"code"}]}]},
      ],
      markdown: [
        "`a*b_c[d] <e> & |`",
      ],
      html: "<p><code>a*b_c[d] &lt;e&gt; &amp; |</code></p>",
    },
    {
      name: "inline code containing a backtick uses two; at an edge it is padded",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"a`b","marks":[{"type":"code"}]},{"type":"text","text":" "},{"type":"text","text":"`start","marks":[{"type":"code"}]},{"type":"text","text":" "},{"type":"text","text":"end`","marks":[{"type":"code"}]},{"type":"text","text":" "},{"type":"text","text":"``two``","marks":[{"type":"code"}]},{"type":"text","text":" "},{"type":"text","text":"`","marks":[{"type":"code"}]}]},
      ],
      markdown: [
        "``a`b`` `` `start `` `` end` `` `` ``two`` `` `` ` ``",
      ],
      html: "<p><code>a`b</code> <code>`start</code> <code>end`</code> <code>``two``</code> <code>`</code></p>",
    },
    {
      name: "inline code with other marks",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"code","marks":[{"type":"code"},{"type":"bold"}]},{"type":"text","text":" "},{"type":"text","text":"linked","marks":[{"type":"code"},{"type":"link","attrs":{"href":"https://example.com/"}}]},{"type":"text","text":" "},{"type":"text","text":" padded ","marks":[{"type":"code"},{"type":"italic"}]}]},
      ],
      markdown: [
        "**`code`** [`linked`](https://example.com/)  *`padded`*",
      ],
      html: "<p><code><strong>code</strong></code> <code><a href=\"https://example.com/\">linked</a></code> <code><em> padded </em></code></p>",
    },
    {
      name: "a link with every attribute",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"site","marks":[{"type":"link","attrs":{"href":"https://example.com/a?b=1&c=2#d","target":"_blank","rel":"noopener noreferrer nofollow","class":"ext","internal":false}}]},{"type":"text","text":" "},{"type":"text","text":"inside","marks":[{"type":"link","attrs":{"href":"/s/x/settings","target":null,"rel":null,"class":null,"internal":true}}]}]},
      ],
      markdown: [
        "[site](https://example.com/a?b=1&c=2#d) [inside](/s/x/settings)",
      ],
      html: "<p><a href=\"https://example.com/a?b=1&amp;c=2#d\" target=\"_blank\" rel=\"noopener noreferrer nofollow\" class=\"ext\">site</a> <a href=\"/s/x/settings\" data-internal=\"true\">inside</a></p>",
    },
    {
      name: "a link whose address has spaces, parentheses and other characters",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"wiki","marks":[{"type":"link","attrs":{"href":"https://en.wikipedia.org/wiki/Foo_(bar) baz"}}]},{"type":"text","text":" "},{"type":"text","text":"tab","marks":[{"type":"link","attrs":{"href":"https://example.com/a\tb"}}]},{"type":"text","text":" "},{"type":"text","text":"angle","marks":[{"type":"link","attrs":{"href":"https://example.com/<x>?q=\"1\"&r=[2]"}}]}]},
      ],
      // Accident: parentheses are meant to be percent-encoded for Markdown and are written as they are.
      markdown: [
        "[wiki](https://en.wikipedia.org/wiki/Foo_(bar)%20baz) [tab](https://example.com/a%09b) [angle](https://example.com/<x>?q=\"1\"&r=[2])",
      ],
      html: "<p><a href=\"https://en.wikipedia.org/wiki/Foo_(bar) baz\">wiki</a> <a href=\"https://example.com/a\tb\">tab</a> <a href=\"https://example.com/&lt;x&gt;?q=&quot;1&quot;&amp;r=[2]\">angle</a></p>",
    },
    {
      name: "a link whose text has brackets and marks",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"[x] *y*","marks":[{"type":"link","attrs":{"href":"https://example.com/"}}]},{"type":"text","text":"bold","marks":[{"type":"link","attrs":{"href":"https://example.com/"}},{"type":"bold"}]},{"type":"text","text":" tail","marks":[{"type":"link","attrs":{"href":"https://example.com/"}}]}]},
      ],
      markdown: [
        "[\\[x\\] \\*y\\***bold** tail](https://example.com/)",
      ],
      html: "<p><a href=\"https://example.com/\">[x] *y*</a><a href=\"https://example.com/\"><strong>bold</strong></a><a href=\"https://example.com/\"> tail</a></p>",
    },
    {
      name: "a link without an address, or with an address the server removed",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"none","marks":[{"type":"link","attrs":{"href":null}}]},{"type":"text","text":" "},{"type":"text","text":"empty","marks":[{"type":"link","attrs":{"href":""}}]},{"type":"text","text":" "},{"type":"text","text":"script","marks":[{"type":"link","attrs":{"href":"javascript:alert(1)"}}]},{"type":"text","text":" "},{"type":"text","text":"data","marks":[{"type":"link","attrs":{"href":"data:text/html,<b>x</b>"}}]},{"type":"text","text":" "},{"type":"text","text":"mail","marks":[{"type":"link","attrs":{"href":"mailto:a@example.com"}}]},{"type":"text","text":" "},{"type":"text","text":"phone","marks":[{"type":"link","attrs":{"href":"tel:+123"}}]},{"type":"text","text":" "},{"type":"text","text":"relative","marks":[{"type":"link","attrs":{"href":"../up"}}]},{"type":"text","text":" "},{"type":"text","text":"mark without attrs","marks":[{"type":"link"}]}]},
      ],
      markdown: [
        "[none]() [empty]() [script]() [data]() [mail](mailto:a@example.com) [phone](tel:+123) [relative](../up) [mark without attrs]()",
      ],
      html: "<p><a>none</a> <a>empty</a> <a>script</a> <a>data</a> <a href=\"mailto:a@example.com\">mail</a> <a href=\"tel:+123\">phone</a> <a href=\"../up\">relative</a> <a>mark without attrs</a></p>",
    },
    {
      name: "two links side by side stay two links",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"one","marks":[{"type":"link","attrs":{"href":"https://example.com/1"}}]},{"type":"text","text":"two","marks":[{"type":"link","attrs":{"href":"https://example.com/2"}}]},{"type":"text","text":"three","marks":[{"type":"link","attrs":{"href":"https://example.com/2","target":"_self"}}]}]},
      ],
      markdown: [
        "[one](https://example.com/1)[two](https://example.com/2)[three](https://example.com/2)",
      ],
      html: "<p><a href=\"https://example.com/1\">one</a><a href=\"https://example.com/2\">two</a><a href=\"https://example.com/2\" target=\"_self\">three</a></p>",
    },
    {
      name: "highlight with a colour: only a safe colour reaches the style",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"hex","marks":[{"type":"highlight","attrs":{"color":"#ffcc00","colorName":"Yellow"}}]},{"type":"text","text":"rgb","marks":[{"type":"highlight","attrs":{"color":"rgb(255, 0, 0)"}}]},{"type":"text","text":"hsl","marks":[{"type":"highlight","attrs":{"color":"hsla(120, 50%, 50%, 0.5)"}}]},{"type":"text","text":"named","marks":[{"type":"highlight","attrs":{"color":"tomato","colorName":"RED"}}]},{"type":"text","text":"unsafe","marks":[{"type":"highlight","attrs":{"color":"red; background: url(x)"}}]},{"type":"text","text":"expr","marks":[{"type":"highlight","attrs":{"color":"expression(alert(1))"}}]},{"type":"text","text":"short","marks":[{"type":"highlight","attrs":{"color":"#ff"}}]},{"type":"text","text":"null","marks":[{"type":"highlight","attrs":{"color":null,"colorName":null}}]}]},
      ],
      markdown: [
        "==hex====rgb====hsl====named====unsafe====expr====short====null==",
      ],
      html: "<p><mark data-color=\"#ffcc00\" style=\"background-color: #ffcc00; color: inherit\" data-highlight-color-name=\"yellow\">hex</mark><mark data-color=\"rgb(255, 0, 0)\" style=\"background-color: rgb(255, 0, 0); color: inherit\">rgb</mark><mark data-color=\"hsla(120, 50%, 50%, 0.5)\" style=\"background-color: hsla(120, 50%, 50%, 0.5); color: inherit\">hsl</mark><mark data-color=\"tomato\" style=\"background-color: tomato; color: inherit\" data-highlight-color-name=\"red\">named</mark><mark data-color=\"red; background: url(x)\">unsafe</mark><mark data-color=\"expression(alert(1))\">expr</mark><mark data-color=\"#ff\">short</mark><mark>null</mark></p>",
    },
    {
      name: "text colour is written only in HTML, and only when safe",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"red","marks":[{"type":"textStyle","attrs":{"color":"#ff0000"}}]},{"type":"text","text":"named","marks":[{"type":"textStyle","attrs":{"color":"  Blue  "}}]},{"type":"text","text":"unsafe","marks":[{"type":"textStyle","attrs":{"color":"url(javascript:x)"}}]},{"type":"text","text":"none","marks":[{"type":"textStyle"}]},{"type":"text","text":"number","marks":[{"type":"textStyle","attrs":{"color":255}}]}]},
      ],
      markdown: [
        "rednamedunsafenonenumber",
      ],
      html: "<p><span style=\"color: #ff0000\">red</span><span style=\"color: Blue\">named</span><span>unsafe</span><span>none</span><span>number</span></p>",
    },
    {
      name: "comment marks are spans in HTML and invisible in Markdown",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"open","marks":[{"type":"comment","attrs":{"commentId":"c-1","resolved":false}}]},{"type":"text","text":" "},{"type":"text","text":"resolved","marks":[{"type":"comment","attrs":{"commentId":"c-2","resolved":true}}]},{"type":"text","text":" "},{"type":"text","text":"bare","marks":[{"type":"comment"}]},{"type":"text","text":" "},{"type":"text","text":"bold too","marks":[{"type":"bold"},{"type":"comment","attrs":{"commentId":"c-3"}}]}]},
      ],
      markdown: [
        "open resolved bare **bold too**",
      ],
      html: "<p><span class=\"comment-mark\" data-comment-id=\"c-1\">open</span> <span class=\"comment-mark resolved\" data-comment-id=\"c-2\" data-resolved=\"true\">resolved</span> <span class=\"comment-mark\">bare</span> <strong><span class=\"comment-mark\" data-comment-id=\"c-3\">bold too</span></strong></p>",
    },
    {
      name: "marks nest in a fixed order in Markdown and in the document's order in HTML",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"all","marks":[{"type":"superscript"},{"type":"subscript"},{"type":"underline"},{"type":"highlight"},{"type":"strike"},{"type":"italic"},{"type":"bold"},{"type":"link","attrs":{"href":"https://example.com/"}}]}]},
      ],
      markdown: [
        "[***~~==<u><sub><sup>all</sup></sub></u>==~~***](https://example.com/)",
      ],
      html: "<p><sup><sub><u><mark><s><em><strong><a href=\"https://example.com/\">all</a></strong></em></s></mark></u></sub></sup></p>",
    },
    {
      name: "marks that continue over several text nodes are opened and closed once",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"a","marks":[{"type":"bold"}]},{"type":"text","text":"b","marks":[{"type":"bold"},{"type":"italic"}]},{"type":"text","text":"c","marks":[{"type":"italic"}]},{"type":"text","text":"d"},{"type":"text","text":"e","marks":[{"type":"bold"},{"type":"italic"}]},{"type":"text","text":"f","marks":[{"type":"bold"}]},{"type":"text","text":"g","marks":[{"type":"bold"},{"type":"strike"}]}]},
      ],
      markdown: [
        "**a*b****c*d***e*f~~g~~**",
      ],
      html: "<p><strong>a</strong><strong><em>b</em></strong><em>c</em>d<strong><em>e</em></strong><strong>f</strong><strong><s>g</s></strong></p>",
    },
    {
      name: "a link continues over differently marked text",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"plain ","marks":[{"type":"link","attrs":{"href":"https://example.com/"}}]},{"type":"text","text":"bold","marks":[{"type":"link","attrs":{"href":"https://example.com/"}},{"type":"bold"}]},{"type":"text","text":" end","marks":[{"type":"link","attrs":{"href":"https://example.com/"}}]},{"type":"text","text":" out"}]},
      ],
      markdown: [
        "[plain](https://example.com/) [**bold** end](https://example.com/) out",
      ],
      html: "<p><a href=\"https://example.com/\">plain </a><a href=\"https://example.com/\"><strong>bold</strong></a><a href=\"https://example.com/\"> end</a> out</p>",
    },
    {
      name: "spaces at the edges of marked text move outside the markers",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":" bold ","marks":[{"type":"bold"}]},{"type":"text","text":"x"},{"type":"text","text":"  italic","marks":[{"type":"italic"}]},{"type":"text","text":"y"},{"type":"text","text":"strike\t","marks":[{"type":"strike"}]},{"type":"text","text":"z"}]},
      ],
      markdown: [
        "**bold** x  *italic*y~~strike~~\tz",
      ],
      html: "<p><strong> bold </strong>x<em>  italic</em>y<s>strike\t</s>z</p>",
    },
    {
      name: "marked text that is only spaces leaves empty markers",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"a"},{"type":"text","text":"   ","marks":[{"type":"bold"}]},{"type":"text","text":"b"},{"type":"text","text":" ","marks":[{"type":"italic"},{"type":"bold"}]},{"type":"text","text":"c"}]},
      ],
      // Accident: the markers are written around nothing (`****`), which Markdown does not read as bold.
      markdown: [
        "a   ****   b ****** c",
      ],
      html: "<p>a<strong>   </strong>b<em><strong> </strong></em>c</p>",
    },
    {
      name: "spaces between two bold runs",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"one ","marks":[{"type":"bold"}]},{"type":"text","text":" two","marks":[{"type":"bold"}]},{"type":"text","text":" "},{"type":"text","text":"three ","marks":[{"type":"bold"},{"type":"italic"}]},{"type":"text","text":"four","marks":[{"type":"bold"}]}]},
      ],
      markdown: [
        "**one**  **two** ***three*** **four**",
      ],
      html: "<p><strong>one </strong><strong> two</strong> <strong><em>three </em></strong><strong>four</strong></p>",
    },
    {
      name: "a hard break keeps marks open; any other inline node closes them",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"a","marks":[{"type":"bold"}]},{"type":"hardBreak"},{"type":"text","text":"b","marks":[{"type":"bold"}]},{"type":"mathInline","attrs":{"text":"x"}},{"type":"text","text":"c","marks":[{"type":"bold"}]}]},
      ],
      markdown: [
        "**a\\",
        "b**$x$**c**",
      ],
      html: "<p><strong>a</strong><br><strong>b</strong><span data-type=\"mathInline\" data-katex=\"true\">x</span><strong>c</strong></p>",
    },
    {
      name: "unknown attributes on marks are ignored",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"bold","attrs":{"weight":900}}]},{"type":"text","text":"y","marks":[{"type":"italic","attrs":{"style":"oblique"}}]},{"type":"text","text":"z","marks":[{"type":"code","attrs":{"language":"js"}}]}]},
      ],
      markdown: [
        "**x***y*`z`",
      ],
      html: "<p><strong>x</strong><em>y</em><code>z</code></p>",
    },
  ],
  "inline nodes": [
    {
      name: "a hard break",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"one"},{"type":"hardBreak"},{"type":"text","text":"two"},{"type":"hardBreak"},{"type":"hardBreak"},{"type":"text","text":"three"},{"type":"hardBreak"}]},
      ],
      markdown: [
        "one\\",
        "two\\",
        "\\",
        "three\\",
      ],
      html: "<p>one<br>two<br><br>three<br></p>",
    },
    {
      name: "inline math",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"Euler: "},{"type":"mathInline","attrs":{"text":"e^{i\\pi} + 1 = 0"}},{"type":"text","text":" and "},{"type":"mathInline","attrs":{"text":"a < b & c_d"}},{"type":"mathInline","attrs":{"text":""}},{"type":"mathInline"},{"type":"mathInline","attrs":{"text":null}},{"type":"mathInline","attrs":{"text":42}}]},
      ],
      markdown: [
        "Euler: $e^{i\\pi} + 1 = 0$ and $a < b & c_d$$$$$$$$42$",
      ],
      html: "<p>Euler: <span data-type=\"mathInline\" data-katex=\"true\">e^{i\\pi} + 1 = 0</span> and <span data-type=\"mathInline\" data-katex=\"true\">a &lt; b &amp; c_d</span><span data-type=\"mathInline\" data-katex=\"true\"></span><span data-type=\"mathInline\" data-katex=\"true\"></span><span data-type=\"mathInline\" data-katex=\"true\"></span><span data-type=\"mathInline\" data-katex=\"true\">42</span></p>",
    },
    {
      name: "a status",
      doc: [
        {"type":"paragraph","content":[{"type":"status","attrs":{"text":"In *progress*","color":"blue"}},{"type":"text","text":" "},{"type":"status","attrs":{"text":"DONE","color":"green"}},{"type":"status","attrs":{"text":"","color":"gray"}},{"type":"status"},{"type":"status","attrs":{"text":7,"color":3}},{"type":"status","attrs":{"text":"<b>&","color":"\"x\""}}]},
      ],
      markdown: [
        "In \\*progress\\* DONE7\\<b\\>&",
      ],
      html: "<p><span data-type=\"status\" data-color=\"blue\">In *progress*</span> <span data-type=\"status\" data-color=\"green\">DONE</span><span data-type=\"status\" data-color=\"gray\"></span><span data-type=\"status\"></span><span data-type=\"status\" data-color=\"3\">7</span><span data-type=\"status\" data-color=\"&quot;x&quot;\">&lt;b&gt;&amp;</span></p>",
    },
    {
      name: "a mention of a person",
      doc: [
        {"type":"paragraph","content":[{"type":"mention","attrs":{"id":"m1","label":"Ada Lovelace","entityType":"user","entityId":"5b0e7c1e-3f1a-4c57-9a52-0d7f6a3d0001","creatorId":"5b0e7c1e-3f1a-4c57-9a52-0d7f6a3d0002"}},{"type":"text","text":" "},{"type":"mention","attrs":{"id":"m2","label":"a_b*c","entityType":"user"}},{"type":"text","text":" "},{"type":"mention","attrs":{"id":"m3","entityType":"user"}},{"type":"text","text":" "},{"type":"mention","attrs":{"entityType":"user","label":null}}]},
      ],
      markdown: [
        "@Ada Lovelace @a_b*c @ @",
      ],
      html: "<p><span data-type=\"mention\" class=\"mention\" data-id=\"m1\" data-label=\"Ada Lovelace\" data-entity-type=\"user\" data-entity-id=\"5b0e7c1e-3f1a-4c57-9a52-0d7f6a3d0001\" data-creator-id=\"5b0e7c1e-3f1a-4c57-9a52-0d7f6a3d0002\">@Ada Lovelace</span> <span data-type=\"mention\" class=\"mention\" data-id=\"m2\" data-label=\"a_b*c\" data-entity-type=\"user\">@a_b*c</span> <span data-type=\"mention\" class=\"mention\" data-id=\"m3\" data-entity-type=\"user\">@m3</span> <span data-type=\"mention\" class=\"mention\" data-entity-type=\"user\">@</span></p>",
    },
    {
      name: "a mention of a page that is not in the export",
      doc: [
        {"type":"paragraph","content":[{"type":"mention","attrs":{"id":"m1","label":"Road [map]","entityType":"page","entityId":"5b0e7c1e-3f1a-4c57-9a52-0d7f6a3d0003","slugId":"nosuchpage","anchorId":null}},{"type":"text","text":" "},{"type":"mention","attrs":{"label":"with anchor","entityType":"page","slugId":"nosuchpage","anchorId":"h 1/α"}},{"type":"text","text":" "},{"type":"mention","attrs":{"label":"no slug","entityType":"page","entityId":"x"}},{"type":"text","text":" "},{"type":"mention","attrs":{"label":"numeric slug","entityType":"page","slugId":12345}}]},
      ],
      markdown: [
        "[Road \\[map\\]](http://doc.test/) [with anchor](http://doc.test/#h%201%2F%CE%B1) no slug [numeric slug](http://doc.test/)",
      ],
      html: "<p><a href=\"http://doc.test/\" data-type=\"mention\" class=\"mention\" data-id=\"m1\" data-label=\"Road [map]\" data-entity-type=\"page\" data-entity-id=\"5b0e7c1e-3f1a-4c57-9a52-0d7f6a3d0003\" data-slug-id=\"nosuchpage\">Road [map]</a> <a href=\"http://doc.test/#h%201%2F%CE%B1\" data-type=\"mention\" class=\"mention\" data-label=\"with anchor\" data-entity-type=\"page\" data-slug-id=\"nosuchpage\" data-anchor-id=\"h 1/α\">with anchor</a> <span data-type=\"mention\" class=\"mention\" data-label=\"no slug\" data-entity-type=\"page\" data-entity-id=\"x\">no slug</span> <a href=\"http://doc.test/\" data-type=\"mention\" class=\"mention\" data-label=\"numeric slug\" data-entity-type=\"page\" data-slug-id=\"12345\">numeric slug</a></p>",
    },
    {
      name: "a mention of neither kind",
      doc: [
        {"type":"paragraph","content":[{"type":"mention","attrs":{"id":"m1","label":"thing","entityType":"space","entityId":"e1"}},{"type":"text","text":" "},{"type":"mention","attrs":{"id":"only-id"}},{"type":"text","text":" "},{"type":"mention"},{"type":"text","text":" "},{"type":"mention","attrs":{"label":"<b>","slugId":"nosuchpage"}},{"type":"text","text":" "},{"type":"mention","attrs":{"label":42,"entityType":true}}]},
      ],
      markdown: [
        "thing   [\\<b\\>](http://doc.test/) 42",
      ],
      html: "<p><span data-type=\"mention\" class=\"mention\" data-id=\"m1\" data-label=\"thing\" data-entity-type=\"space\" data-entity-id=\"e1\">thing</span> <span data-type=\"mention\" class=\"mention\" data-id=\"only-id\">only-id</span> <span data-type=\"mention\" class=\"mention\"></span> <span data-type=\"mention\" class=\"mention\" data-label=\"&lt;b&gt;\" data-slug-id=\"nosuchpage\">&lt;b&gt;</span> <span data-type=\"mention\" class=\"mention\" data-label=\"42\" data-entity-type=\"true\">42</span></p>",
    },
    {
      name: "a footnote reference",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"Claim"},{"type":"footnoteReference","attrs":{"data-id":"fn-a","referenceNumber":"1","class":"footnote-ref","href":"#fn:1"}},{"type":"text","text":" more"},{"type":"footnoteReference","attrs":{"data-id":"fn-b"}},{"type":"footnoteReference","attrs":{"referenceNumber":3}},{"type":"footnoteReference"},{"type":"footnoteReference","attrs":{"data-id":"\"q\"","referenceNumber":"<2>"}}]},
      ],
      markdown: [
        "Claim[^1] more[^fn-b][^3][^][^<2>]",
      ],
      html: "<p>Claim<sup id=\"fnref:1\"><a class=\"footnote-ref\" data-id=\"fn-a\" data-reference-number=\"1\" href=\"#fn:1\">1</a></sup> more<sup id=\"fnref:\"><a class=\"footnote-ref\" data-id=\"fn-b\" data-reference-number=\"\" href=\"#fn:\"></a></sup><sup id=\"fnref:3\"><a class=\"footnote-ref\" data-id=\"\" data-reference-number=\"3\" href=\"#fn:3\">3</a></sup><sup id=\"fnref:\"><a class=\"footnote-ref\" data-id=\"\" data-reference-number=\"\" href=\"#fn:\"></a></sup><sup id=\"fnref:&lt;2&gt;\"><a class=\"footnote-ref\" data-id=\"&quot;q&quot;\" data-reference-number=\"&lt;2&gt;\" href=\"#fn:&lt;2&gt;\">&lt;2&gt;</a></sup></p>",
    },
    {
      name: "a block node inside a paragraph is left out of Markdown",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"before "},{"type":"image","attrs":{"src":"https://example.com/i.png","alt":"inline"}},{"type":"text","text":" after"},{"type":"horizontalRule"}]},
      ],
      markdown: [
        "before  after",
      ],
      html: "<p>before <img src=\"https://example.com/i.png\" alt=\"inline\"> after<hr></p>",
    },
  ],
  "paragraphs and headings": [
    {
      name: "a paragraph with an id, alignment and indent",
      doc: [
        {"type":"paragraph","attrs":{"id":"p-1","textAlign":"center","indent":2},"content":[{"type":"text","text":"centred"}]},
        {"type":"paragraph","attrs":{"id":null,"textAlign":"right","indent":0},"content":[{"type":"text","text":"right"}]},
        {"type":"paragraph","attrs":{"textAlign":"justify"},"content":[{"type":"text","text":"justified"}]},
        {"type":"paragraph","attrs":{"textAlign":"left"},"content":[{"type":"text","text":"left is the default"}]},
        {"type":"paragraph","attrs":{"textAlign":"CENTER"},"content":[{"type":"text","text":"upper case is unknown"}]},
        {"type":"paragraph","attrs":{"textAlign":"center; color: red"},"content":[{"type":"text","text":"unsafe"}]},
      ],
      markdown: [
        "centred",
        "",
        "right",
        "",
        "justified",
        "",
        "left is the default",
        "",
        "upper case is unknown",
        "",
        "unsafe",
      ],
      html: "<p data-id=\"p-1\" style=\"text-align: center\" data-indent=\"2\">centred</p><p style=\"text-align: right\">right</p><p style=\"text-align: justify\">justified</p><p>left is the default</p><p>upper case is unknown</p><p>unsafe</p>",
    },
    {
      name: "indent of unexpected types",
      doc: [
        {"type":"paragraph","attrs":{"indent":"3"},"content":[{"type":"text","text":"string"}]},
        {"type":"paragraph","attrs":{"indent":-1},"content":[{"type":"text","text":"negative"}]},
        {"type":"paragraph","attrs":{"indent":1.5},"content":[{"type":"text","text":"fraction"}]},
        {"type":"paragraph","attrs":{"indent":"x"},"content":[{"type":"text","text":"word"}]},
        {"type":"paragraph","attrs":{"indent":true},"content":[{"type":"text","text":"true"}]},
        {"type":"paragraph","attrs":{"indent":null},"content":[{"type":"text","text":"null"}]},
        {"type":"paragraph","attrs":{"indent":[4]},"content":[{"type":"text","text":"list"}]},
      ],
      markdown: [
        "string",
        "",
        "negative",
        "",
        "fraction",
        "",
        "word",
        "",
        "true",
        "",
        "null",
        "",
        "list",
      ],
      html: "<p data-indent=\"3\">string</p><p>negative</p><p data-indent=\"1.5\">fraction</p><p>word</p><p data-indent=\"1\">true</p><p>null</p><p data-indent=\"4\">list</p>",
    },
    {
      name: "an id of unexpected types",
      doc: [
        {"type":"paragraph","attrs":{"id":7},"content":[{"type":"text","text":"number"}]},
        {"type":"paragraph","attrs":{"id":true},"content":[{"type":"text","text":"true"}]},
        {"type":"paragraph","attrs":{"id":false},"content":[{"type":"text","text":"false"}]},
        {"type":"paragraph","attrs":{"id":""},"content":[{"type":"text","text":"empty"}]},
        {"type":"paragraph","attrs":{"id":"a\"b<c>"},"content":[{"type":"text","text":"quote"}]},
        {"type":"paragraph","attrs":{"id":["x","y"]},"content":[{"type":"text","text":"list"}]},
        {"type":"paragraph","attrs":{"id":{"a":1}},"content":[{"type":"text","text":"object"}]},
      ],
      markdown: [
        "number",
        "",
        "true",
        "",
        "false",
        "",
        "empty",
        "",
        "quote",
        "",
        "list",
        "",
        "object",
      ],
      html: "<p data-id=\"7\">number</p><p data-id=\"true\">true</p><p data-id=\"false\">false</p><p>empty</p><p data-id=\"a&quot;b&lt;c&gt;\">quote</p><p data-id=\"x,y\">list</p><p data-id=\"[object Object]\">object</p>",
    },
    {
      name: "headings of every level",
      doc: [
        {"type":"heading","attrs":{"level":1,"id":null,"textAlign":null,"indent":0},"content":[{"type":"text","text":"Level 1"}]},
        {"type":"heading","attrs":{"level":2,"id":null,"textAlign":null,"indent":0},"content":[{"type":"text","text":"Level 2"}]},
        {"type":"heading","attrs":{"level":3,"id":null,"textAlign":null,"indent":0},"content":[{"type":"text","text":"Level 3"}]},
        {"type":"heading","attrs":{"level":4,"id":null,"textAlign":null,"indent":0},"content":[{"type":"text","text":"Level 4"}]},
        {"type":"heading","attrs":{"level":5,"id":null,"textAlign":null,"indent":0},"content":[{"type":"text","text":"Level 5"}]},
        {"type":"heading","attrs":{"level":6,"id":null,"textAlign":null,"indent":0},"content":[{"type":"text","text":"Level 6"}]},
      ],
      markdown: [
        "# Level 1",
        "",
        "## Level 2",
        "",
        "### Level 3",
        "",
        "#### Level 4",
        "",
        "##### Level 5",
        "",
        "###### Level 6",
      ],
      html: "<h1>Level 1</h1><h2>Level 2</h2><h3>Level 3</h3><h4>Level 4</h4><h5>Level 5</h5><h6>Level 6</h6>",
    },
    {
      name: "a heading level outside 1 to 6, or not a number",
      doc: [
        {"type":"heading","attrs":{"level":0},"content":[{"type":"text","text":"zero"}]},
        {"type":"heading","attrs":{"level":7},"content":[{"type":"text","text":"seven"}]},
        {"type":"heading","attrs":{"level":-2},"content":[{"type":"text","text":"negative"}]},
        {"type":"heading","attrs":{"level":"3"},"content":[{"type":"text","text":"string three"}]},
        {"type":"heading","attrs":{"level":2.7},"content":[{"type":"text","text":"fraction"}]},
        {"type":"heading","attrs":{"level":"x"},"content":[{"type":"text","text":"word"}]},
        {"type":"heading","attrs":{"level":null},"content":[{"type":"text","text":"null"}]},
        {"type":"heading","attrs":{},"content":[{"type":"text","text":"missing"}]},
        {"type":"heading","content":[{"type":"text","text":"no attrs"}]},
        {"type":"heading","attrs":{"level":true},"content":[{"type":"text","text":"true"}]},
        {"type":"heading","attrs":{"level":[4]},"content":[{"type":"text","text":"list"}]},
      ],
      // Accident: a level with a fraction is not rounded for the HTML tag (`<h2.7>`).
      markdown: [
        "# zero",
        "",
        "###### seven",
        "",
        "# negative",
        "",
        "### string three",
        "",
        "## fraction",
        "",
        "# word",
        "",
        "# null",
        "",
        "# missing",
        "",
        "# no attrs",
        "",
        "# true",
        "",
        "#### list",
      ],
      html: "<h1>zero</h1><h6>seven</h6><h1>negative</h1><h3>string three</h3><h2.7>fraction</h2.7><h1>word</h1><h1>null</h1><h1>missing</h1><h1>no attrs</h1><h1>true</h1><h4>list</h4>",
    },
    {
      name: "a heading with an id, alignment, indent and marks",
      doc: [
        {"type":"heading","attrs":{"level":2,"id":"intro-1","textAlign":"center","indent":1},"content":[{"type":"text","text":"Intro "},{"type":"text","text":"bold","marks":[{"type":"bold"}]},{"type":"text","text":" "},{"type":"text","text":"code","marks":[{"type":"code"}]},{"type":"text","text":" "},{"type":"text","text":"link","marks":[{"type":"link","attrs":{"href":"https://example.com/"}}]}]},
      ],
      markdown: [
        "## Intro **bold** `code` [link](https://example.com/)",
      ],
      html: "<h2 id=\"intro-1\" style=\"text-align: center\" data-indent=\"1\">Intro <strong>bold</strong> <code>code</code> <a href=\"https://example.com/\">link</a></h2>",
    },
    {
      name: "a hard break in a heading becomes a space in Markdown",
      doc: [
        {"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":"first"},{"type":"hardBreak"},{"type":"text","text":"second"},{"type":"hardBreak"},{"type":"hardBreak"},{"type":"text","text":"third"}]},
      ],
      markdown: [
        "### first second  third",
      ],
      html: "<h3>first<br>second<br><br>third</h3>",
    },
    {
      name: "a heading is not escaped at its start",
      doc: [
        {"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"# hash"}]},
        {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"- dash"}]},
        {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"1. one"}]},
        {"type":"heading","attrs":{"level":2}},
        {"type":"heading","attrs":{"level":2},"content":[]},
      ],
      markdown: [
        "# # hash",
        "",
        "## - dash",
        "",
        "## 1. one",
        "",
        "## ",
        "",
        "##",
      ],
      html: "<h1># hash</h1><h2>- dash</h2><h2>1. one</h2><h2></h2><h2></h2>",
    },
  ],
  "quotes, rules and code": [
    {
      name: "a block quote",
      doc: [
        {"type":"blockquote","content":[{"type":"paragraph","content":[{"type":"text","text":"To be, or not to be."}]}]},
      ],
      markdown: [
        "> To be, or not to be.",
      ],
      html: "<blockquote><p>To be, or not to be.</p></blockquote>",
    },
    {
      name: "a block quote of several blocks, and a quote in a quote",
      doc: [
        {"type":"blockquote","content":[{"type":"paragraph","content":[{"type":"text","text":"first"}]},{"type":"paragraph","content":[{"type":"text","text":"second"},{"type":"hardBreak"},{"type":"text","text":"line"}]},{"type":"blockquote","content":[{"type":"paragraph","content":[{"type":"text","text":"inner"}]},{"type":"blockquote","content":[{"type":"paragraph","content":[{"type":"text","text":"innermost"}]}]}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"item"}]}]}]},{"type":"codeBlock","attrs":{"language":"txt"},"content":[{"type":"text","text":"code\n\nmore"}]}]},
      ],
      markdown: [
        "> first",
        ">",
        "> second\\",
        "> line",
        ">",
        "> > inner",
        "> >",
        "> > > innermost",
        ">",
        "> - item",
        ">",
        "> ```txt",
        "> code",
        ">",
        "> more",
        "> ```",
      ],
      html: "<blockquote><p>first</p><p>second<br>line</p><blockquote><p>inner</p><blockquote><p>innermost</p></blockquote></blockquote><ul><li><p>item</p></li></ul><pre><code class=\"language-txt\">code\n\nmore</code></pre></blockquote>",
    },
    {
      name: "an empty block quote",
      doc: [
        {"type":"blockquote","content":[]},
        {"type":"blockquote"},
        {"type":"blockquote","content":[{"type":"paragraph","content":[]}]},
      ],
      markdown: [
        ">",
        "",
        ">",
        "",
        ">",
      ],
      html: "<blockquote></blockquote><blockquote></blockquote><blockquote><p></p></blockquote>",
    },
    {
      name: "a horizontal rule and a page break",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"above"}]},
        {"type":"horizontalRule"},
        {"type":"paragraph","content":[{"type":"text","text":"between"}]},
        {"type":"pageBreak"},
        {"type":"paragraph","content":[{"type":"text","text":"below"}]},
      ],
      markdown: [
        "above",
        "",
        "---",
        "",
        "between",
        "",
        "<div data-type=\"pageBreak\"></div>",
        "",
        "below",
      ],
      html: "<p>above</p><hr><p>between</p><div data-type=\"pageBreak\" class=\"page-break\"></div><p>below</p>",
    },
    {
      name: "a code block with a language",
      doc: [
        {"type":"codeBlock","attrs":{"language":"typescript"},"content":[{"type":"text","text":"const a: number = 1;\nif (a < 2 && a > 0) {\n  console.log(`*not bold*`, \"x\");\n}"}]},
      ],
      markdown: [
        "```typescript",
        "const a: number = 1;",
        "if (a < 2 && a > 0) {",
        "  console.log(`*not bold*`, \"x\");",
        "}",
        "```",
      ],
      html: "<pre><code class=\"language-typescript\">const a: number = 1;\nif (a &lt; 2 &amp;&amp; a &gt; 0) {\n  console.log(`*not bold*`, &quot;x&quot;);\n}</code></pre>",
    },
    {
      name: "a code block without a language, empty, and of several text nodes",
      doc: [
        {"type":"codeBlock","attrs":{"language":null},"content":[{"type":"text","text":"plain"}]},
        {"type":"codeBlock","content":[]},
        {"type":"codeBlock"},
        {"type":"codeBlock","attrs":{},"content":[{"type":"text","text":"a"},{"type":"text","text":"b\n"},{"type":"text","text":"c"}]},
        {"type":"codeBlock","attrs":{"language":""},"content":[{"type":"text","text":"empty language"}]},
      ],
      markdown: [
        "```",
        "plain",
        "```",
        "",
        "```",
        "",
        "```",
        "",
        "```",
        "",
        "```",
        "",
        "```",
        "ab",
        "c",
        "```",
        "",
        "```",
        "empty language",
        "```",
      ],
      html: "<pre><code>plain</code></pre><pre><code></code></pre><pre><code></code></pre><pre><code>ab\nc</code></pre><pre><code>empty language</code></pre>",
    },
    {
      name: "a code block containing a fence of three backticks",
      doc: [
        {"type":"codeBlock","attrs":{"language":"md"},"content":[{"type":"text","text":"```js\ncode\n```"}]},
        {"type":"codeBlock","content":[{"type":"text","text":"````\nfour\n````"}]},
        {"type":"codeBlock","content":[{"type":"text","text":"inline ``` only"}]},
      ],
      markdown: [
        "````md",
        "```js",
        "code",
        "```",
        "````",
        "",
        "````",
        "````",
        "four",
        "````",
        "````",
        "",
        "````",
        "inline ``` only",
        "````",
      ],
      html: "<pre><code class=\"language-md\">```js\ncode\n```</code></pre><pre><code>````\nfour\n````</code></pre><pre><code>inline ``` only</code></pre>",
    },
    {
      name: "a code block's language is written as given",
      doc: [
        {"type":"codeBlock","attrs":{"language":"c++"},"content":[{"type":"text","text":"x"}]},
        {"type":"codeBlock","attrs":{"language":"objective c"},"content":[{"type":"text","text":"y"}]},
        {"type":"codeBlock","attrs":{"language":"a\"b<c>"},"content":[{"type":"text","text":"z"}]},
        {"type":"codeBlock","attrs":{"language":5},"content":[{"type":"text","text":"n"}]},
        {"type":"codeBlock","attrs":{"language":false},"content":[{"type":"text","text":"f"}]},
      ],
      markdown: [
        "```c++",
        "x",
        "```",
        "",
        "```objective c",
        "y",
        "```",
        "",
        "```a\"b<c>",
        "z",
        "```",
        "",
        "```5",
        "n",
        "```",
        "",
        "```false",
        "f",
        "```",
      ],
      html: "<pre><code class=\"language-c++\">x</code></pre><pre><code class=\"language-objective c\">y</code></pre><pre><code class=\"language-a&quot;b&lt;c&gt;\">z</code></pre><pre><code class=\"language-5\">n</code></pre><pre><code>f</code></pre>",
    },
    {
      name: "blank lines in a code block: three or more line breaks in a row become two in Markdown",
      doc: [
        {"type":"codeBlock","attrs":{"language":"py"},"content":[{"type":"text","text":"a\n\nb\n\n\nc\n\n\n\nd"}]},
      ],
      // Accident: the collapsing of blank lines between blocks also reaches into code blocks and changes the code.
      markdown: [
        "```py",
        "a",
        "",
        "b",
        "",
        "c",
        "",
        "d",
        "```",
      ],
      html: "<pre><code class=\"language-py\">a\n\nb\n\n\nc\n\n\n\nd</code></pre>",
    },
    {
      name: "white space at the edges of a code block",
      doc: [
        {"type":"codeBlock","content":[{"type":"text","text":"  indented\n\ttabbed\ntrailing  \n"}]},
      ],
      markdown: [
        "```",
        "  indented",
        "\ttabbed",
        "trailing  ",
        "",
        "```",
      ],
      html: "<pre><code>  indented\n\ttabbed\ntrailing  \n</code></pre>",
    },
    {
      name: "marks and other nodes inside a code block are ignored",
      doc: [
        {"type":"codeBlock","content":[{"type":"text","text":"bold?","marks":[{"type":"bold"}]},{"type":"hardBreak"},{"type":"mathInline","attrs":{"text":"x"}},{"type":"text","text":" end"}]},
      ],
      markdown: [
        "```",
        "bold? end",
        "```",
      ],
      html: "<pre><code>bold? end</code></pre>",
    },
    {
      name: "math as a block",
      doc: [
        {"type":"mathBlock","attrs":{"text":"\\int_0^1 x^2\\,dx = \\frac{1}{3}"}},
        {"type":"mathBlock","attrs":{"text":"a < b\n\\\\\nc & d"}},
        {"type":"mathBlock","attrs":{"text":""}},
        {"type":"mathBlock"},
        {"type":"mathBlock","attrs":{"text":12}},
      ],
      markdown: [
        "$$",
        "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
        "$$",
        "",
        "$$",
        "a < b",
        "\\\\",
        "c & d",
        "$$",
        "",
        "$$",
        "",
        "$$",
        "",
        "$$",
        "",
        "$$",
        "",
        "$$",
        "12",
        "$$",
      ],
      html: "<div data-type=\"mathBlock\" data-katex=\"true\">\\int_0^1 x^2\\,dx = \\frac{1}{3}</div><div data-type=\"mathBlock\" data-katex=\"true\">a &lt; b\n\\\\\nc &amp; d</div><div data-type=\"mathBlock\" data-katex=\"true\"></div><div data-type=\"mathBlock\" data-katex=\"true\"></div><div data-type=\"mathBlock\" data-katex=\"true\">12</div>",
    },
  ],
  "lists": [
    {
      name: "a bullet list",
      doc: [
        {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"one"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"two"},{"type":"hardBreak"},{"type":"text","text":"second line"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"- three"}]}]}]},
      ],
      markdown: [
        "- one",
        "- two\\",
        "  second line",
        "- \\- three",
      ],
      html: "<ul><li><p>one</p></li><li><p>two<br>second line</p></li><li><p>- three</p></li></ul>",
    },
    {
      name: "an ordered list starts where it says",
      doc: [
        {"type":"orderedList","attrs":{"start":1,"type":null},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"first"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"second"}]}]}]},
        {"type":"orderedList","attrs":{"start":5},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"five"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"six"}]}]}]},
        {"type":"orderedList","attrs":{"start":9},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"nine"},{"type":"hardBreak"},{"type":"text","text":"more"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"ten"},{"type":"hardBreak"},{"type":"text","text":"more"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"eleven"}]}]}]},
      ],
      markdown: [
        "1. first",
        "2. second",
        "",
        "5. five",
        "6. six",
        "",
        "9. nine\\",
        "   more",
        "10. ten\\",
        "    more",
        "11. eleven",
      ],
      html: "<ol><li><p>first</p></li><li><p>second</p></li></ol><ol start=\"5\"><li><p>five</p></li><li><p>six</p></li></ol><ol start=\"9\"><li><p>nine<br>more</p></li><li><p>ten<br>more</p></li><li><p>eleven</p></li></ol>",
    },
    {
      name: "an ordered list with a start that is no positive number, and a type",
      doc: [
        {"type":"orderedList","attrs":{"start":0},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"zero"}]}]}]},
        {"type":"orderedList","attrs":{"start":-3},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"minus"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"next"}]}]}]},
        {"type":"orderedList","attrs":{"start":"4"},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"string"}]}]}]},
        {"type":"orderedList","attrs":{"start":"x"},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"word"}]}]}]},
        {"type":"orderedList","attrs":{"start":null},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"null"}]}]}]},
        {"type":"orderedList","attrs":{"start":2.5},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"fraction"}]}]}]},
        {"type":"orderedList","attrs":{"start":1,"type":"a"},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"typed"}]}]}]},
        {"type":"orderedList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"no attrs"}]}]}]},
      ],
      // Accident: a start that is not a number is `start="NaN"` in HTML, and zero, negative and fractional starts are written as they are.
      markdown: [
        "1. zero",
        "",
        "-3. minus",
        "-2. next",
        "",
        "4. string",
        "",
        "1. word",
        "",
        "1. null",
        "",
        "2.5. fraction",
        "",
        "1. typed",
        "",
        "1. no attrs",
      ],
      html: "<ol start=\"0\"><li><p>zero</p></li></ol><ol start=\"-3\"><li><p>minus</p></li><li><p>next</p></li></ol><ol start=\"4\"><li><p>string</p></li></ol><ol start=\"NaN\"><li><p>word</p></li></ol><ol start=\"0\"><li><p>null</p></li></ol><ol start=\"2.5\"><li><p>fraction</p></li></ol><ol type=\"a\"><li><p>typed</p></li></ol><ol start=\"NaN\"><li><p>no attrs</p></li></ol>",
    },
    {
      name: "a task list",
      doc: [
        {"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"done"}]}]},{"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph","content":[{"type":"text","text":"to do"}]}]},{"type":"taskItem","content":[{"type":"paragraph","content":[{"type":"text","text":"no attrs"}]}]},{"type":"taskItem","attrs":{"checked":"false"},"content":[{"type":"paragraph","content":[{"type":"text","text":"the string false"}]}]},{"type":"taskItem","attrs":{"checked":0},"content":[{"type":"paragraph","content":[{"type":"text","text":"zero"}]}]},{"type":"taskItem","attrs":{"checked":1},"content":[{"type":"paragraph","content":[{"type":"text","text":"one"}]}]},{"type":"taskItem","attrs":{"checked":null},"content":[{"type":"paragraph","content":[{"type":"text","text":"null"}]}]}]},
      ],
      markdown: [
        "- [x] done",
        "- [ ] to do",
        "- [ ] no attrs",
        "- [x] the string false",
        "- [ ] zero",
        "- [x] one",
        "- [ ] null",
      ],
      html: "<ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"true\"><p>done</p></li><li data-type=\"taskItem\" data-checked=\"false\"><p>to do</p></li><li data-type=\"taskItem\" data-checked=\"false\"><p>no attrs</p></li><li data-type=\"taskItem\" data-checked=\"true\"><p>the string false</p></li><li data-type=\"taskItem\" data-checked=\"false\"><p>zero</p></li><li data-type=\"taskItem\" data-checked=\"true\"><p>one</p></li><li data-type=\"taskItem\" data-checked=\"false\"><p>null</p></li></ul>",
    },
    {
      name: "nested lists stay tight",
      doc: [
        {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"fruit"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"apple"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"green"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"red"}]}]}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"pear"}]}]}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"steps"}]},{"type":"orderedList","attrs":{"start":1},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"first"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"second"}]},{"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"checked"}]}]}]}]}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"last"}]}]}]},
      ],
      markdown: [
        "- fruit",
        "  - apple",
        "    - green",
        "    - red",
        "  - pear",
        "- steps",
        "  1. first",
        "  2. second",
        "     - [x] checked",
        "- last",
      ],
      html: "<ul><li><p>fruit</p><ul><li><p>apple</p><ul><li><p>green</p></li><li><p>red</p></li></ul></li><li><p>pear</p></li></ul></li><li><p>steps</p><ol><li><p>first</p></li><li><p>second</p><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"true\"><p>checked</p></li></ul></li></ol></li><li><p>last</p></li></ul>",
    },
    {
      name: "a list with an item of several blocks is loose: its items are separated by blank lines",
      doc: [
        {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"simple"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"first paragraph"}]},{"type":"paragraph","content":[{"type":"text","text":"second paragraph"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"after"}]}]}]},
      ],
      markdown: [
        "- simple",
        "",
        "- first paragraph",
        "",
        "  second paragraph",
        "",
        "- after",
      ],
      html: "<ul><li><p>simple</p></li><li><p>first paragraph</p><p>second paragraph</p></li><li><p>after</p></li></ul>",
    },
    {
      name: "items holding code, quotes and tables",
      doc: [
        {"type":"orderedList","attrs":{"start":1},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"code:"}]},{"type":"codeBlock","attrs":{"language":"sh"},"content":[{"type":"text","text":"echo one\n\necho two"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"quote:"}]},{"type":"blockquote","content":[{"type":"paragraph","content":[{"type":"text","text":"quoted"}]},{"type":"paragraph","content":[{"type":"text","text":"twice"}]}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"table:"}]},{"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"h"}]}]},{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"i"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"1"}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"2"}]}]}]}]}]}]},
      ],
      markdown: [
        "1. code:",
        "",
        "   ```sh",
        "   echo one",
        "",
        "   echo two",
        "   ```",
        "",
        "2. quote:",
        "",
        "   > quoted",
        "   >",
        "   > twice",
        "",
        "3. table:",
        "",
        "   | h | i |",
        "   | --- | --- |",
        "   | 1 | 2 |",
      ],
      html: "<ol><li><p>code:</p><pre><code class=\"language-sh\">echo one\n\necho two</code></pre></li><li><p>quote:</p><blockquote><p>quoted</p><p>twice</p></blockquote></li><li><p>table:</p><div class=\"tableWrapper\"><table><tbody><tr><th><p>h</p></th><th><p>i</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table></div></li></ol>",
    },
    {
      name: "a loose list inside a tight one, and a tight one inside a loose one",
      doc: [
        {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"outer tight"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"inner a"}]},{"type":"paragraph","content":[{"type":"text","text":"inner a2"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"inner b"}]}]}]}]}]},
        {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"outer loose"}]},{"type":"paragraph","content":[{"type":"text","text":"second"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"inner x"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"inner y"}]}]}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"outer two"}]}]}]},
      ],
      markdown: [
        "- outer tight",
        "  - inner a",
        "",
        "    inner a2",
        "",
        "  - inner b",
        "",
        "- outer loose",
        "",
        "  second",
        "",
        "  - inner x",
        "  - inner y",
        "",
        "- outer two",
      ],
      html: "<ul><li><p>outer tight</p><ul><li><p>inner a</p><p>inner a2</p></li><li><p>inner b</p></li></ul></li></ul><ul><li><p>outer loose</p><p>second</p><ul><li><p>inner x</p></li><li><p>inner y</p></li></ul></li><li><p>outer two</p></li></ul>",
    },
    {
      name: "empty items and items that do not start with a paragraph",
      doc: [
        {"type":"bulletList","content":[{"type":"listItem","content":[]},{"type":"listItem","content":[{"type":"paragraph","content":[]}]},{"type":"listItem"},{"type":"listItem","content":[{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"only a list"}]}]}]}]},{"type":"listItem","content":[{"type":"codeBlock","content":[{"type":"text","text":"only code"}]}]}]},
        {"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":true},"content":[]},{"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph","content":[]}]}]},
        {"type":"bulletList","content":[]},
        {"type":"orderedList"},
        {"type":"taskList","content":[]},
      ],
      // Accident: an ordered list without attributes gets `start="NaN"` in HTML.
      markdown: [
        "- ",
        "- ",
        "- ",
        "- - only a list",
        "- ```",
        "  only code",
        "  ```",
        "",
        "- [x] ",
        "- [ ]",
      ],
      html: "<ul><li></li><li><p></p></li><li></li><li><ul><li><p>only a list</p></li></ul></li><li><pre><code>only code</code></pre></li></ul><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"true\"></li><li data-type=\"taskItem\" data-checked=\"false\"><p></p></li></ul><ul></ul><ol start=\"NaN\"></ol><ul data-type=\"taskList\"></ul>",
    },
    {
      name: "list items of the wrong kind",
      doc: [
        {"type":"bulletList","content":[{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"task in bullets"}]}]},{"type":"paragraph","content":[{"type":"text","text":"paragraph in bullets"}]}]},
        {"type":"orderedList","attrs":{"start":3},"content":[{"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph","content":[{"type":"text","text":"task in ordered"}]}]}]},
        {"type":"taskList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"plain item in tasks"}]}]}]},
      ],
      markdown: [
        "- [x] task in bullets",
        "- ",
        "",
        "3. [ ] task in ordered",
        "",
        "- plain item in tasks",
      ],
      html: "<ul><li data-type=\"taskItem\" data-checked=\"true\"><p>task in bullets</p></li><p>paragraph in bullets</p></ul><ol start=\"3\"><li data-type=\"taskItem\" data-checked=\"false\"><p>task in ordered</p></li></ol><ul data-type=\"taskList\"><li><p>plain item in tasks</p></li></ul>",
    },
    {
      name: "a list item directly in the document",
      doc: [
        {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"stray item"}]},{"type":"paragraph","content":[{"type":"text","text":"second"}]}]},
        {"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"stray task"}]}]},
      ],
      markdown: [
        "stray item",
        "",
        "second",
        "",
        "stray task",
      ],
      html: "<li><p>stray item</p><p>second</p></li><li data-type=\"taskItem\" data-checked=\"true\"><p>stray task</p></li>",
    },
  ],
  "tables": [
    {
      name: "a simple table is a Markdown table",
      doc: [
        {"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"Name"}]}]},{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"Qty"}]}]},{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"Note"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"Apples"}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"3"}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"fresh","marks":[{"type":"bold"}]},{"type":"text","text":" & "},{"type":"text","text":"crisp","marks":[{"type":"italic"}]}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"Pears"}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"12"}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[]}]}]}]},
      ],
      markdown: [
        "| Name | Qty | Note |",
        "| --- | --- | --- |",
        "| Apples | 3 | **fresh** & *crisp* |",
        "| Pears | 12 |  |",
      ],
      html: "<div class=\"tableWrapper\"><table><tbody><tr><th><p>Name</p></th><th><p>Qty</p></th><th><p>Note</p></th></tr><tr><td><p>Apples</p></td><td><p>3</p></td><td><p><strong>fresh</strong> &amp; <em>crisp</em></p></td></tr><tr><td><p>Pears</p></td><td><p>12</p></td><td><p></p></td></tr></tbody></table></div>",
    },
    {
      name: "cells with a hard break, a pipe, a link, code and a line break",
      doc: [
        {"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"a | b"}]}]},{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"two"},{"type":"hardBreak"},{"type":"text","text":"lines"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"x|y","marks":[{"type":"code"}]}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"go","marks":[{"type":"link","attrs":{"href":"https://example.com/a|b"}}]}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"line\nbreak"}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"mathInline","attrs":{"text":"a|b"}},{"type":"status","attrs":{"text":"ok"}}]}]}]}]},
      ],
      // Accident: a pipe in a cell is escaped twice (`\\|`), which most readers take for a backslash and the end of the cell.
      markdown: [
        "| a \\\\| b | two<br>lines |",
        "| --- | --- |",
        "| `x\\|y` | [go](https://example.com/a\\|b) |",
        "| line break | $a\\|b$ok |",
      ],
      html: "<div class=\"tableWrapper\"><table><tbody><tr><th><p>a | b</p></th><th><p>two<br>lines</p></th></tr><tr><td><p><code>x|y</code></p></td><td><p><a href=\"https://example.com/a|b\">go</a></p></td></tr><tr><td><p>line\nbreak</p></td><td><p><span data-type=\"mathInline\" data-katex=\"true\">a|b</span><span data-type=\"status\">ok</span></p></td></tr></tbody></table></div>",
    },
    {
      name: "rows of different lengths are padded; a table need not have header cells",
      doc: [
        {"type":"table","content":[{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"a"}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"b"}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"c"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"d"}]}]}]},{"type":"tableRow","content":[]},{"type":"tableRow","content":[{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"e"}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"f"}]}]}]}]},
      ],
      markdown: [
        "| a | b | c |",
        "| --- | --- | --- |",
        "| d |  |  |",
        "|  |  |  |",
        "| e | f |  |",
      ],
      html: "<div class=\"tableWrapper\"><table><tbody><tr><td><p>a</p></td><td><p>b</p></td><td><p>c</p></td></tr><tr><td><p>d</p></td></tr><tr></tr><tr><th><p>e</p></th><td><p>f</p></td></tr></tbody></table></div>",
    },
    {
      name: "a table of one row, of one empty row, and cells without content",
      doc: [
        {"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"only"}]}]}]}]},
        {"type":"table","content":[{"type":"tableRow","content":[]}]},
        {"type":"table","content":[{"type":"tableRow","content":[{"type":"tableCell","content":[]},{"type":"tableCell"},{"type":"tableCell","content":[{"type":"paragraph","content":[]}]}]},{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"x"}]}]}]}]},
      ],
      markdown: [
        "| only |",
        "| --- |",
        "",
        "|  |",
        "|  |",
        "",
        "|  |  |  |",
        "| --- | --- | --- |",
        "| x |  |  |",
      ],
      html: "<div class=\"tableWrapper\"><table><tbody><tr><th><p>only</p></th></tr></tbody></table></div><div class=\"tableWrapper\"><table><tbody><tr></tr></tbody></table></div><div class=\"tableWrapper\"><table><tbody><tr><td></td><td></td><td><p></p></td></tr><tr><td><p>x</p></td></tr></tbody></table></div>",
    },
    {
      name: "cells that span one column and row keep the table simple, whatever their width and colour",
      doc: [
        {"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","attrs":{"colspan":1,"rowspan":1,"colwidth":null,"backgroundColor":null,"backgroundColorName":null},"content":[{"type":"paragraph","content":[{"type":"text","text":"h"}]}]},{"type":"tableHeader","attrs":{"colspan":"1","rowspan":"1"},"content":[{"type":"paragraph","content":[{"type":"text","text":"i"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","attrs":{"colwidth":[120],"backgroundColor":"#eee","backgroundColorName":"Gray"},"content":[{"type":"paragraph","content":[{"type":"text","text":"styled"}]}]},{"type":"tableCell","attrs":{"colspan":null,"rowspan":null},"content":[{"type":"paragraph","content":[{"type":"text","text":"nulls"}]}]}]}]},
      ],
      markdown: [
        "| h | i |",
        "| --- | --- |",
        "| styled | nulls |",
      ],
      html: "<div class=\"tableWrapper\"><table><tbody><tr><th><p>h</p></th><th><p>i</p></th></tr><tr><td colwidth=\"120\" style=\"background-color: #eee\" data-background-color=\"#eee\" data-background-color-name=\"gray\"><p>styled</p></td><td><p>nulls</p></td></tr></tbody></table></div>",
    },
    {
      name: "a span that is not 1, even 0 or a word, makes the table HTML in Markdown",
      doc: [
        {"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"h"}]}]},{"type":"tableCell","attrs":{"rowspan":0},"content":[{"type":"paragraph","content":[{"type":"text","text":"zero"}]}]}]}]},
        {"type":"table","content":[{"type":"tableRow","content":[{"type":"tableCell","attrs":{"colspan":"x"},"content":[{"type":"paragraph","content":[{"type":"text","text":"word"}]}]}]}]},
      ],
      markdown: [
        "<div class=\"tableWrapper\"><table><tbody><tr><th><p>h</p></th><td><p>zero</p></td></tr></tbody></table></div>",
        "",
        "<div class=\"tableWrapper\"><table><tbody><tr><td><p>word</p></td></tr></tbody></table></div>",
      ],
      html: "<div class=\"tableWrapper\"><table><tbody><tr><th><p>h</p></th><td><p>zero</p></td></tr></tbody></table></div><div class=\"tableWrapper\"><table><tbody><tr><td><p>word</p></td></tr></tbody></table></div>",
    },
    {
      name: "a table with a merged cell is written as HTML in Markdown",
      doc: [
        {"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","attrs":{"colspan":2,"rowspan":1},"content":[{"type":"paragraph","content":[{"type":"text","text":"wide"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","attrs":{"colspan":1,"rowspan":2},"content":[{"type":"paragraph","content":[{"type":"text","text":"tall"}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"b"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"c"}]}]}]}]},
      ],
      markdown: [
        "<div class=\"tableWrapper\"><table><tbody><tr><th colspan=\"2\"><p>wide</p></th></tr><tr><td rowspan=\"2\"><p>tall</p></td><td><p>b</p></td></tr><tr><td><p>c</p></td></tr></tbody></table></div>",
      ],
      html: "<div class=\"tableWrapper\"><table><tbody><tr><th colspan=\"2\"><p>wide</p></th></tr><tr><td rowspan=\"2\"><p>tall</p></td><td><p>b</p></td></tr><tr><td><p>c</p></td></tr></tbody></table></div>",
    },
    {
      name: "a table with a cell of several blocks is written as HTML in Markdown",
      doc: [
        {"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"h"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"one"}]},{"type":"paragraph","content":[{"type":"text","text":"two"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"item"}]}]}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"codeBlock","attrs":{"language":"js"},"content":[{"type":"text","text":"x < 1"}]}]}]}]},
      ],
      markdown: [
        "<div class=\"tableWrapper\"><table><tbody><tr><th><p>h</p></th></tr><tr><td><p>one</p><p>two</p></td></tr><tr><td><ul><li><p>item</p></li></ul></td></tr><tr><td><pre><code class=\"language-js\">x &lt; 1</code></pre></td></tr></tbody></table></div>",
      ],
      html: "<div class=\"tableWrapper\"><table><tbody><tr><th><p>h</p></th></tr><tr><td><p>one</p><p>two</p></td></tr><tr><td><ul><li><p>item</p></li></ul></td></tr><tr><td><pre><code class=\"language-js\">x &lt; 1</code></pre></td></tr></tbody></table></div>",
    },
    {
      name: "every cell attribute in HTML",
      doc: [
        {"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","attrs":{"colspan":2,"rowspan":3,"colwidth":[100,200],"backgroundColor":"#ffeeaa","backgroundColorName":"Yellow"},"content":[{"type":"paragraph","content":[{"type":"text","text":"h"}]}]},{"type":"tableHeader","attrs":{"colspan":"3","rowspan":"2","colwidth":"150","backgroundColor":"rgb(1,2,3)"},"content":[{"type":"paragraph","content":[{"type":"text","text":"i"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","attrs":{"colspan":0,"rowspan":-1,"colwidth":[],"backgroundColor":"url(x)","backgroundColorName":""},"content":[{"type":"paragraph","content":[{"type":"text","text":"c"}]}]},{"type":"tableCell","attrs":{"colspan":1.5,"rowspan":"x","colwidth":[null,80],"backgroundColor":7,"backgroundColorName":9},"content":[{"type":"paragraph","content":[{"type":"text","text":"d"}]}]}]}]},
      ],
      markdown: [
        "<div class=\"tableWrapper\"><table><tbody><tr><th colspan=\"2\" rowspan=\"3\" colwidth=\"100,200\" style=\"background-color: #ffeeaa\" data-background-color=\"#ffeeaa\" data-background-color-name=\"yellow\"><p>h</p></th><th colspan=\"3\" rowspan=\"2\" style=\"background-color: rgb(1,2,3)\" data-background-color=\"rgb(1,2,3)\"><p>i</p></th></tr><tr><td data-background-color=\"url(x)\"><p>c</p></td><td colspan=\"1.5\" colwidth=\",80\" data-background-color=\"7\" data-background-color-name=\"9\"><p>d</p></td></tr></tbody></table></div>",
      ],
      html: "<div class=\"tableWrapper\"><table><tbody><tr><th colspan=\"2\" rowspan=\"3\" colwidth=\"100,200\" style=\"background-color: #ffeeaa\" data-background-color=\"#ffeeaa\" data-background-color-name=\"yellow\"><p>h</p></th><th colspan=\"3\" rowspan=\"2\" style=\"background-color: rgb(1,2,3)\" data-background-color=\"rgb(1,2,3)\"><p>i</p></th></tr><tr><td data-background-color=\"url(x)\"><p>c</p></td><td colspan=\"1.5\" colwidth=\",80\" data-background-color=\"7\" data-background-color-name=\"9\"><p>d</p></td></tr></tbody></table></div>",
    },
    {
      name: "a table inside a quote and a callout",
      doc: [
        {"type":"blockquote","content":[{"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"q"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"1"}]}]}]}]}]},
        {"type":"callout","attrs":{"type":"info"},"content":[{"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"c"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"2"}]}]}]}]}]},
      ],
      markdown: [
        "> | q |",
        "> | --- |",
        "> | 1 |",
        "",
        ":::info",
        "| c |",
        "| --- |",
        "| 2 |",
        ":::",
      ],
      html: "<blockquote><div class=\"tableWrapper\"><table><tbody><tr><th><p>q</p></th></tr><tr><td><p>1</p></td></tr></tbody></table></div></blockquote><div data-type=\"callout\" data-callout-type=\"info\"><div class=\"tableWrapper\"><table><tbody><tr><th><p>c</p></th></tr><tr><td><p>2</p></td></tr></tbody></table></div></div>",
    },
    {
      name: "a row or a cell outside a table",
      doc: [
        {"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"stray cell"}]}]},{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"stray header"}]}]}]},
        {"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"lonely cell"}]}]},
      ],
      markdown: [
        "stray cell",
        "",
        "stray header",
        "",
        "lonely cell",
      ],
      html: "<tr><td><p>stray cell</p></td><th><p>stray header</p></th></tr><td><p>lonely cell</p></td>",
    },
  ],
  "media": [
    {
      name: "an image with every attribute",
      doc: [
        {"type":"image","attrs":{"src":"https://example.com/pic ture(1).png","alt":"A [nice] *picture*","width":640,"height":"480","align":"center","attachmentId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","size":12345,"aspectRatio":1.3333}},
      ],
      markdown: [
        "![A \\[nice\\] \\*picture\\*](https://example.com/pic%20ture(1).png)",
      ],
      html: "<img src=\"https://example.com/pic ture(1).png\" alt=\"A [nice] *picture*\" width=\"640\" height=\"480\" data-align=\"center\" data-attachment-id=\"3f2504e0-4f89-41d3-9a0c-0305e82c3301\" data-size=\"12345\" data-aspect-ratio=\"1.3333\">",
    },
    {
      name: "an image with few or odd attributes",
      doc: [
        {"type":"image","attrs":{"src":"https://example.com/a.png"}},
        {"type":"image","attrs":{"src":""}},
        {"type":"image","attrs":{"src":null,"alt":null,"width":null}},
        {"type":"image"},
        {"type":"image","attrs":{"src":"https://example.com/b.png","alt":"","width":0,"height":false,"align":true,"size":"","aspectRatio":[16,9]}},
        {"type":"image","attrs":{"src":"relative/path.png","alt":"quote\"d <alt> & more","width":"50%","align":{"a":1}}},
      ],
      markdown: [
        "![](https://example.com/a.png)",
        "",
        "![]()",
        "",
        "![]()",
        "",
        "![]()",
        "",
        "![](https://example.com/b.png)",
        "",
        "![quote\"d \\<alt\\> & more](relative/path.png)",
      ],
      html: "<img src=\"https://example.com/a.png\"><img><img><img><img src=\"https://example.com/b.png\" width=\"0\" height=\"false\" data-align=\"true\" data-aspect-ratio=\"16,9\"><img src=\"relative/path.png\" alt=\"quote&quot;d &lt;alt&gt; &amp; more\" width=\"50%\" data-align=\"[object Object]\">",
    },
    {
      name: "image sources the server keeps or removes",
      doc: [
        {"type":"image","attrs":{"src":"data:image/png;base64,iVBORw0KGgo="}},
        {"type":"image","attrs":{"src":"data:text/html;base64,PGI+"}},
        {"type":"image","attrs":{"src":"javascript:alert(1)"}},
        {"type":"image","attrs":{"src":"  https://example.com/padded.png  "}},
        {"type":"image","attrs":{"src":"//cdn.example.com/x.png"}},
        {"type":"image","attrs":{"src":42}},
      ],
      markdown: [
        "![](data:image/png;base64,iVBORw0KGgo=)",
        "",
        "![]()",
        "",
        "![]()",
        "",
        "![](https://example.com/padded.png)",
        "",
        "![](//cdn.example.com/x.png)",
        "",
        "![]()",
      ],
      html: "<img src=\"data:image/png;base64,iVBORw0KGgo=\"><img><img><img src=\"https://example.com/padded.png\"><img src=\"//cdn.example.com/x.png\"><img>",
    },
    {
      name: "an image without alt text takes a title as its Markdown label",
      doc: [
        {"type":"image","attrs":{"src":"https://example.com/t.png","title":"The title"}},
        {"type":"image","attrs":{"src":"https://example.com/u.png","alt":"","title":"unused"}},
        {"type":"image","attrs":{"src":"https://example.com/v.png","alt":null,"title":7}},
      ],
      markdown: [
        "![The title](https://example.com/t.png)",
        "",
        "![](https://example.com/u.png)",
        "",
        "![7](https://example.com/v.png)",
      ],
      html: "<img src=\"https://example.com/t.png\"><img src=\"https://example.com/u.png\"><img src=\"https://example.com/v.png\">",
    },
    {
      name: "an image of this server's files",
      doc: [
        {"type":"image","attrs":{"src":"/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/photo one.png","alt":"photo"}},
        {"type":"image","attrs":{"src":"/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/a%20b(1).png"}},
      ],
      markdown: [
        "![photo](http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/photo%20one.png)",
        "",
        "![](http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/a%20b(1).png)",
      ],
      html: "<img src=\"http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/photo one.png\" alt=\"photo\"><img src=\"http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/a%20b(1).png\">",
    },
    {
      name: "a video",
      doc: [
        {"type":"video","attrs":{"src":"https://example.com/media/clip%20one.mp4","alt":null,"attachmentId":"att-1","width":800,"height":450,"size":1048576,"align":"left","aspectRatio":"16/9"}},
        {"type":"video","attrs":{"src":"/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/screen cast.webm","alt":"Screen *cast*"}},
        {"type":"video","attrs":{"src":"https://example.com/media/100%zz.mp4"}},
        {"type":"video","attrs":{"src":""}},
        {"type":"video"},
      ],
      markdown: [
        "[clip one.mp4](https://example.com/media/clip%20one.mp4)",
        "",
        "[Screen \\*cast\\*](http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/screen%20cast.webm)",
        "",
        "[100%zz.mp4](https://example.com/media/100%zz.mp4)",
        "",
        "[]()",
        "",
        "[]()",
      ],
      html: "<video controls src=\"https://example.com/media/clip%20one.mp4\" width=\"800\" height=\"450\" data-align=\"left\" data-attachment-id=\"att-1\" data-size=\"1048576\" data-aspect-ratio=\"16/9\"></video><video controls src=\"http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/screen cast.webm\" aria-label=\"Screen *cast*\"></video><video controls src=\"https://example.com/media/100%zz.mp4\"></video><video controls></video><video controls></video>",
    },
    {
      name: "an audio clip",
      doc: [
        {"type":"audio","attrs":{"src":"https://example.com/media/song.mp3","attachmentId":"att-2","size":4096}},
        {"type":"audio","attrs":{"src":"/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/voice%20memo.m4a"}},
        {"type":"audio","attrs":{"src":"https://example.com/dir/"}},
        {"type":"audio"},
      ],
      markdown: [
        "[song.mp3](https://example.com/media/song.mp3)",
        "",
        "[voice memo.m4a](http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/voice%20memo.m4a)",
        "",
        "[](https://example.com/dir/)",
        "",
        "[]()",
      ],
      html: "<audio controls preload=\"metadata\" src=\"https://example.com/media/song.mp3\" data-attachment-id=\"att-2\" data-size=\"4096\"></audio><audio controls preload=\"metadata\" src=\"http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/voice%20memo.m4a\"></audio><audio controls preload=\"metadata\" src=\"https://example.com/dir/\"></audio><audio controls preload=\"metadata\"></audio>",
    },
    {
      name: "a PDF",
      doc: [
        {"type":"pdf","attrs":{"src":"/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/paper.pdf","name":"Paper (final).pdf","attachmentId":"att-3","size":99,"width":800,"height":600}},
        {"type":"pdf","attrs":{"src":"https://example.com/docs/spec.pdf","width":"100%","height":1200}},
        {"type":"pdf","attrs":{"src":"https://example.com/x.pdf","name":"","width":null,"height":null}},
        {"type":"pdf"},
      ],
      markdown: [
        "[Paper (final).pdf](http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/paper.pdf)",
        "",
        "[spec.pdf](https://example.com/docs/spec.pdf)",
        "",
        "[](https://example.com/x.pdf)",
        "",
        "[]()",
      ],
      html: "<div data-type=\"pdf\" data-name=\"Paper (final).pdf\" data-attachment-id=\"att-3\" data-size=\"99\"><iframe src=\"http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/paper.pdf\" width=\"800\" height=\"600\"></iframe></div><div data-type=\"pdf\"><iframe src=\"https://example.com/docs/spec.pdf\" width=\"100%\" height=\"1200\"></iframe></div><div data-type=\"pdf\"><iframe src=\"https://example.com/x.pdf\" width=\"800\" height=\"600\"></iframe></div><div data-type=\"pdf\"><iframe src=\"\" width=\"800\" height=\"600\"></iframe></div>",
    },
    {
      name: "an attachment",
      doc: [
        {"type":"attachment","attrs":{"url":"/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/report final.docx","name":"report final.docx","mime":"application/vnd.openxmlformats-officedocument.wordprocessingml.document","size":20480,"attachmentId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}},
        {"type":"attachment","attrs":{"url":"https://example.com/files/a(1).zip","name":"a [1] <x>.zip"}},
        {"type":"attachment","attrs":{"url":"https://example.com/unnamed.bin"}},
        {"type":"attachment","attrs":{"url":"","name":null}},
        {"type":"attachment"},
        {"type":"attachment","attrs":{"url":"javascript:alert(1)","name":5,"size":"big","mime":true}},
      ],
      markdown: [
        "[report final.docx](http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/report%20final.docx)",
        "",
        "[a \\[1\\] \\<x\\>.zip](https://example.com/files/a(1).zip)",
        "",
        "[file](https://example.com/unnamed.bin)",
        "",
        "[file]()",
        "",
        "[file]()",
        "",
        "[5]()",
      ],
      html: "<div data-type=\"attachment\" data-attachment-url=\"http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/report final.docx\" data-attachment-name=\"report final.docx\" data-attachment-mime=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document\" data-attachment-size=\"20480\" data-attachment-id=\"3f2504e0-4f89-41d3-9a0c-0305e82c3301\"><a href=\"http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/report final.docx\" class=\"attachment\" target=\"_blank\">report final.docx</a></div><div data-type=\"attachment\" data-attachment-url=\"https://example.com/files/a(1).zip\" data-attachment-name=\"a [1] &lt;x&gt;.zip\"><a href=\"https://example.com/files/a(1).zip\" class=\"attachment\" target=\"_blank\">a [1] &lt;x&gt;.zip</a></div><div data-type=\"attachment\" data-attachment-url=\"https://example.com/unnamed.bin\"><a href=\"https://example.com/unnamed.bin\" class=\"attachment\" target=\"_blank\">https://example.com/unnamed.bin</a></div><div data-type=\"attachment\"><a href=\"\" class=\"attachment\" target=\"_blank\"></a></div><div data-type=\"attachment\"><a href=\"\" class=\"attachment\" target=\"_blank\"></a></div><div data-type=\"attachment\" data-attachment-name=\"5\" data-attachment-mime=\"true\" data-attachment-size=\"big\"><a href=\"\" class=\"attachment\" target=\"_blank\">5</a></div>",
    },
    {
      name: "a drawio diagram and an excalidraw drawing",
      doc: [
        {"type":"drawio","attrs":{"src":"/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/diagram.drawio.svg","title":"Architecture","alt":"Arch [v2]","width":600,"height":400,"size":2048,"aspectRatio":1.5,"align":"center","attachmentId":"att-4"}},
        {"type":"drawio","attrs":{"src":"https://example.com/d.svg","title":"Only a title"}},
        {"type":"drawio","attrs":{"src":"data:image/svg+xml;base64,PHN2Zz4="}},
        {"type":"drawio"},
        {"type":"excalidraw","attrs":{"src":"/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/sketch.excalidraw.svg","title":"Sketch","width":"300"}},
        {"type":"excalidraw","attrs":{"src":"https://example.com/e.svg","alt":"","title":""}},
        {"type":"excalidraw"},
      ],
      markdown: [
        "![Arch \\[v2\\]](http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/diagram.drawio.svg)",
        "",
        "![Only a title](https://example.com/d.svg)",
        "",
        "![](data:image/svg+xml;base64,PHN2Zz4=)",
        "",
        "![]()",
        "",
        "![Sketch](http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/sketch.excalidraw.svg)",
        "",
        "![](https://example.com/e.svg)",
        "",
        "![]()",
      ],
      html: "<div data-type=\"drawio\" data-src=\"http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/diagram.drawio.svg\" data-title=\"Architecture\" data-alt=\"Arch [v2]\" data-width=\"600\" data-height=\"400\" data-size=\"2048\" data-aspect-ratio=\"1.5\" data-align=\"center\" data-attachment-id=\"att-4\"><img src=\"http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/diagram.drawio.svg\" alt=\"Arch [v2]\" width=\"600\"></div><div data-type=\"drawio\" data-src=\"https://example.com/d.svg\" data-title=\"Only a title\"><img src=\"https://example.com/d.svg\" alt=\"Only a title\"></div><div data-type=\"drawio\" data-src=\"data:image/svg+xml;base64,PHN2Zz4=\"><img src=\"data:image/svg+xml;base64,PHN2Zz4=\" alt=\"drawio\"></div><div data-type=\"drawio\"><img src=\"\" alt=\"drawio\"></div><div data-type=\"excalidraw\" data-src=\"http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/sketch.excalidraw.svg\" data-title=\"Sketch\" data-width=\"300\"><img src=\"http://doc.test/api/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301/sketch.excalidraw.svg\" alt=\"Sketch\" width=\"300\"></div><div data-type=\"excalidraw\" data-src=\"https://example.com/e.svg\"><img src=\"https://example.com/e.svg\" alt=\"\"></div><div data-type=\"excalidraw\"><img src=\"\" alt=\"excalidraw\"></div>",
    },
    {
      name: "an embed",
      doc: [
        {"type":"embed","attrs":{"src":"https://www.figma.com/embed?url=a b&x=(1)","provider":"figma","align":"center","width":800,"height":600}},
        {"type":"embed","attrs":{"src":"https://example.com/[x]_*y*","provider":"","align":null,"width":"100%","height":null}},
        {"type":"embed","attrs":{"src":"javascript:alert(1)","provider":"evil"}},
        {"type":"embed","attrs":{"src":""}},
        {"type":"embed"},
      ],
      // Accident: unlike other media, the address is not percent-encoded in the Markdown link.
      markdown: [
        "[https://www.figma.com/embed?url=a b&x=(1)](https://www.figma.com/embed?url=a b&x=(1))",
        "",
        "[https://example.com/\\[x\\]\\_\\*y\\*](https://example.com/[x]_*y*)",
        "",
        "[]()",
        "",
        "[]()",
        "",
        "[]()",
      ],
      html: "<div data-type=\"embed\" data-src=\"https://www.figma.com/embed?url=a b&amp;x=(1)\" data-provider=\"figma\" data-align=\"center\" data-width=\"800\" data-height=\"600\"><a href=\"https://www.figma.com/embed?url=a b&amp;x=(1)\" target=\"_blank\">https://www.figma.com/embed?url=a b&amp;x=(1)</a></div><div data-type=\"embed\" data-src=\"https://example.com/[x]_*y*\" data-width=\"100%\"><a href=\"https://example.com/[x]_*y*\" target=\"_blank\">https://example.com/[x]_*y*</a></div><div data-type=\"embed\" data-provider=\"evil\"><a href=\"\" target=\"_blank\"></a></div><div data-type=\"embed\"><a href=\"\" target=\"_blank\"></a></div><div data-type=\"embed\"><a href=\"\" target=\"_blank\"></a></div>",
    },
    {
      name: "a YouTube video",
      doc: [
        {"type":"youtube","attrs":{"src":"https://www.youtube.com/embed/dQw4w9WgXcQ?start=30","start":30,"width":640,"height":480}},
        {"type":"youtube","attrs":{"src":"https://youtu.be/abc_def","width":1280,"height":"720"}},
        {"type":"youtube","attrs":{"src":null,"start":0}},
        {"type":"youtube"},
      ],
      markdown: [
        "[https://www.youtube.com/embed/dQw4w9WgXcQ?start=30](https://www.youtube.com/embed/dQw4w9WgXcQ?start=30)",
        "",
        "[https://youtu.be/abc\\_def](https://youtu.be/abc_def)",
        "",
        "[]()",
        "",
        "[]()",
      ],
      html: "<div data-youtube-video><iframe src=\"https://www.youtube.com/embed/dQw4w9WgXcQ?start=30\" width=\"640\" height=\"480\" allowfullscreen></iframe></div><div data-youtube-video><iframe src=\"https://youtu.be/abc_def\" width=\"1280\" height=\"720\" allowfullscreen></iframe></div><div data-youtube-video><iframe src=\"\" width=\"640\" height=\"480\" allowfullscreen></iframe></div><div data-youtube-video><iframe src=\"\" width=\"640\" height=\"480\" allowfullscreen></iframe></div>",
    },
  ],
  "containers": [
    {
      name: "a callout of each type",
      doc: [
        {"type":"callout","attrs":{"type":"info","icon":null},"content":[{"type":"paragraph","content":[{"type":"text","text":"info"}]}]},
        {"type":"callout","attrs":{"type":"warning","icon":"⚠️"},"content":[{"type":"paragraph","content":[{"type":"text","text":"warning"}]},{"type":"paragraph","content":[{"type":"text","text":"second"}]}]},
        {"type":"callout","attrs":{"type":"danger"},"content":[{"type":"paragraph","content":[{"type":"text","text":"danger"}]}]},
        {"type":"callout","attrs":{"type":"success"},"content":[{"type":"paragraph","content":[{"type":"text","text":"success"}]}]},
        {"type":"callout","attrs":{"type":"note"},"content":[{"type":"paragraph","content":[{"type":"text","text":"note"}]}]},
        {"type":"callout","attrs":{"type":"default"},"content":[{"type":"paragraph","content":[{"type":"text","text":"default"}]}]},
      ],
      markdown: [
        ":::info",
        "info",
        ":::",
        "",
        ":::warning",
        "warning",
        "",
        "second",
        ":::",
        "",
        ":::danger",
        "danger",
        ":::",
        "",
        ":::success",
        "success",
        ":::",
        "",
        ":::note",
        "note",
        ":::",
        "",
        ":::default",
        "default",
        ":::",
      ],
      html: "<div data-type=\"callout\" data-callout-type=\"info\"><p>info</p></div><div data-type=\"callout\" data-callout-type=\"warning\" data-callout-icon=\"⚠️\"><p>warning</p><p>second</p></div><div data-type=\"callout\" data-callout-type=\"danger\"><p>danger</p></div><div data-type=\"callout\" data-callout-type=\"success\"><p>success</p></div><div data-type=\"callout\" data-callout-type=\"note\"><p>note</p></div><div data-type=\"callout\" data-callout-type=\"default\"><p>default</p></div>",
    },
    {
      name: "a callout of an unknown type, without a type, and empty",
      doc: [
        {"type":"callout","attrs":{"type":"custom type!","icon":"<i>"},"content":[{"type":"paragraph","content":[{"type":"text","text":"custom"}]}]},
        {"type":"callout","content":[{"type":"paragraph","content":[{"type":"text","text":"no attrs"}]}]},
        {"type":"callout","attrs":{"type":null},"content":[{"type":"paragraph","content":[{"type":"text","text":"null type"}]}]},
        {"type":"callout","attrs":{"type":""},"content":[{"type":"paragraph","content":[{"type":"text","text":"empty type"}]}]},
        {"type":"callout","attrs":{"type":3},"content":[{"type":"paragraph","content":[{"type":"text","text":"number"}]}]},
        {"type":"callout","attrs":{"type":"info"},"content":[]},
        {"type":"callout"},
      ],
      markdown: [
        ":::custom type!",
        "custom",
        ":::",
        "",
        ":::info",
        "no attrs",
        ":::",
        "",
        ":::info",
        "null type",
        ":::",
        "",
        ":::",
        "empty type",
        ":::",
        "",
        ":::3",
        "number",
        ":::",
        "",
        ":::info",
        "",
        ":::",
        "",
        ":::info",
        "",
        ":::",
      ],
      html: "<div data-type=\"callout\" data-callout-type=\"custom type!\" data-callout-icon=\"&lt;i&gt;\"><p>custom</p></div><div data-type=\"callout\"><p>no attrs</p></div><div data-type=\"callout\"><p>null type</p></div><div data-type=\"callout\"><p>empty type</p></div><div data-type=\"callout\" data-callout-type=\"3\"><p>number</p></div><div data-type=\"callout\" data-callout-type=\"info\"></div><div data-type=\"callout\"></div>",
    },
    {
      name: "a callout holding other blocks, and a callout in a callout",
      doc: [
        {"type":"callout","attrs":{"type":"info"},"content":[{"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":"Heads up"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"one"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"two"}]}]}]},{"type":"codeBlock","attrs":{"language":"js"},"content":[{"type":"text","text":"x()"}]},{"type":"callout","attrs":{"type":"warning"},"content":[{"type":"paragraph","content":[{"type":"text","text":"inner"}]}]}]},
      ],
      markdown: [
        ":::info",
        "### Heads up",
        "",
        "- one",
        "- two",
        "",
        "```js",
        "x()",
        "```",
        "",
        ":::warning",
        "inner",
        ":::",
        ":::",
      ],
      html: "<div data-type=\"callout\" data-callout-type=\"info\"><h3>Heads up</h3><ul><li><p>one</p></li><li><p>two</p></li></ul><pre><code class=\"language-js\">x()</code></pre><div data-type=\"callout\" data-callout-type=\"warning\"><p>inner</p></div></div>",
    },
    {
      name: "a details block, closed and open",
      doc: [
        {"type":"details","attrs":{"open":false},"content":[{"type":"detailsSummary","content":[{"type":"text","text":"Click to "},{"type":"text","text":"expand","marks":[{"type":"bold"}]}]},{"type":"detailsContent","content":[{"type":"paragraph","content":[{"type":"text","text":"Hidden text."}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"item"}]}]}]}]}]},
        {"type":"details","attrs":{"open":true},"content":[{"type":"detailsSummary","content":[{"type":"text","text":"Open"}]},{"type":"detailsContent","content":[{"type":"paragraph","content":[{"type":"text","text":"Shown."}]}]}]},
      ],
      markdown: [
        "<details>",
        "<summary>Click to **expand**</summary>",
        "",
        "Hidden text.",
        "",
        "- item",
        "",
        "</details>",
        "",
        "<details>",
        "<summary>Open</summary>",
        "",
        "Shown.",
        "",
        "</details>",
      ],
      html: "<details><summary data-type=\"detailsSummary\">Click to <strong>expand</strong></summary><div data-type=\"detailsContent\"><p>Hidden text.</p><ul><li><p>item</p></li></ul></div></details><details open><summary data-type=\"detailsSummary\">Open</summary><div data-type=\"detailsContent\"><p>Shown.</p></div></details>",
    },
    {
      name: "a details block with parts missing or odd",
      doc: [
        {"type":"details","content":[{"type":"detailsSummary","content":[{"type":"text","text":"no attrs"}]},{"type":"detailsContent","content":[{"type":"paragraph","content":[{"type":"text","text":"body"}]}]}]},
        {"type":"details","attrs":{"open":"no"},"content":[{"type":"detailsSummary"},{"type":"detailsContent"}]},
        {"type":"details","attrs":{"open":0},"content":[{"type":"detailsContent","content":[{"type":"paragraph","content":[{"type":"text","text":"content only"}]}]}]},
        {"type":"details","attrs":{"open":1},"content":[{"type":"detailsSummary","content":[{"type":"text","text":"summary only "},{"type":"text","text":"<b>"}]}]},
        {"type":"details"},
        {"type":"details","attrs":{"open":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"a stray paragraph"}]}]},
      ],
      markdown: [
        "<details>",
        "<summary>no attrs</summary>",
        "",
        "body",
        "",
        "</details>",
        "",
        "<details>",
        "<summary></summary>",
        "",
        "</details>",
        "",
        "<details>",
        "<summary></summary>",
        "",
        "content only",
        "",
        "</details>",
        "",
        "<details>",
        "<summary>summary only \\<b\\></summary>",
        "",
        "</details>",
        "",
        "<details>",
        "<summary></summary>",
        "",
        "</details>",
        "",
        "<details>",
        "<summary></summary>",
        "",
        "</details>",
      ],
      html: "<details><summary data-type=\"detailsSummary\">no attrs</summary><div data-type=\"detailsContent\"><p>body</p></div></details><details open><summary data-type=\"detailsSummary\"></summary><div data-type=\"detailsContent\"></div></details><details><div data-type=\"detailsContent\"><p>content only</p></div></details><details open><summary data-type=\"detailsSummary\">summary only &lt;b&gt;</summary></details><details></details><details open><p>a stray paragraph</p></details>",
    },
    {
      name: "a details block inside a list and a quote",
      doc: [
        {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"item"}]},{"type":"details","attrs":{"open":false},"content":[{"type":"detailsSummary","content":[{"type":"text","text":"more"}]},{"type":"detailsContent","content":[{"type":"paragraph","content":[{"type":"text","text":"inside"}]}]}]}]}]},
        {"type":"blockquote","content":[{"type":"details","attrs":{"open":false},"content":[{"type":"detailsSummary","content":[{"type":"text","text":"quoted"}]},{"type":"detailsContent","content":[{"type":"paragraph","content":[{"type":"text","text":"deep"}]}]}]}]},
      ],
      markdown: [
        "- item",
        "",
        "  <details>",
        "  <summary>more</summary>",
        "",
        "  inside",
        "",
        "  </details>",
        "",
        "> <details>",
        "> <summary>quoted</summary>",
        ">",
        "> deep",
        ">",
        "> </details>",
      ],
      html: "<ul><li><p>item</p><details><summary data-type=\"detailsSummary\">more</summary><div data-type=\"detailsContent\"><p>inside</p></div></details></li></ul><blockquote><details><summary data-type=\"detailsSummary\">quoted</summary><div data-type=\"detailsContent\"><p>deep</p></div></details></blockquote>",
    },
    {
      name: "the parts of a details block on their own",
      doc: [
        {"type":"detailsSummary","content":[{"type":"text","text":"stray summary"}]},
        {"type":"detailsContent","content":[{"type":"paragraph","content":[{"type":"text","text":"stray content"}]}]},
      ],
      markdown: [
        "stray content",
      ],
      html: "<summary data-type=\"detailsSummary\">stray summary</summary><div data-type=\"detailsContent\"><p>stray content</p></div>",
    },
    {
      name: "columns",
      doc: [
        {"type":"columns","attrs":{"layout":"two_equal","widthMode":"normal"},"content":[{"type":"column","attrs":{"width":null},"content":[{"type":"paragraph","content":[{"type":"text","text":"left"}]}]},{"type":"column","attrs":{"width":null},"content":[{"type":"paragraph","content":[{"type":"text","text":"right"}]},{"type":"paragraph","content":[{"type":"text","text":"more"}]}]}]},
        {"type":"columns","attrs":{"layout":"three_equal","widthMode":"wide"},"content":[{"type":"column","attrs":{"width":2},"content":[{"type":"paragraph","content":[{"type":"text","text":"a"}]}]},{"type":"column","attrs":{"width":"1.5"},"content":[{"type":"paragraph","content":[{"type":"text","text":"b"}]}]},{"type":"column","attrs":{"width":0},"content":[{"type":"paragraph","content":[{"type":"text","text":"c"}]}]}]},
      ],
      markdown: [
        "left",
        "",
        "right",
        "",
        "more",
        "",
        "a",
        "",
        "b",
        "",
        "c",
      ],
      html: "<div data-type=\"columns\" data-layout=\"two_equal\"><div data-type=\"column\"><p>left</p></div><div data-type=\"column\"><p>right</p><p>more</p></div></div><div data-type=\"columns\" data-layout=\"three_equal\" data-width-mode=\"wide\"><div data-type=\"column\" data-width=\"2\" style=\"flex: 2\"><p>a</p></div><div data-type=\"column\" data-width=\"1.5\" style=\"flex: 1.5\"><p>b</p></div><div data-type=\"column\" data-width=\"0\"><p>c</p></div></div>",
    },
    {
      name: "columns with odd attributes, and a column on its own",
      doc: [
        {"type":"columns","content":[{"type":"column","content":[{"type":"paragraph","content":[{"type":"text","text":"no attrs"}]}]}]},
        {"type":"columns","attrs":{"layout":5,"widthMode":"WIDE"},"content":[{"type":"column","attrs":{"width":"x"},"content":[{"type":"paragraph","content":[{"type":"text","text":"word"}]}]},{"type":"column","attrs":{"width":-1},"content":[{"type":"paragraph","content":[{"type":"text","text":"negative"}]}]},{"type":"column","attrs":{"width":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"true"}]}]}]},
        {"type":"columns"},
        {"type":"column","attrs":{"width":3},"content":[{"type":"paragraph","content":[{"type":"text","text":"stray column"}]}]},
      ],
      markdown: [
        "no attrs",
        "",
        "word",
        "",
        "negative",
        "",
        "true",
        "",
        "stray column",
      ],
      html: "<div data-type=\"columns\"><div data-type=\"column\"><p>no attrs</p></div></div><div data-type=\"columns\" data-layout=\"5\"><div data-type=\"column\" data-width=\"x\"><p>word</p></div><div data-type=\"column\" data-width=\"-1\"><p>negative</p></div><div data-type=\"column\" data-width=\"true\" style=\"flex: 1\"><p>true</p></div></div><div data-type=\"columns\"></div><div data-type=\"column\" data-width=\"3\" style=\"flex: 3\"><p>stray column</p></div>",
    },
    {
      name: "a synced block and a reference to one",
      doc: [
        {"type":"transclusionSource","attrs":{"id":"block-1"},"content":[{"type":"paragraph","content":[{"type":"text","text":"Shared text."}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"shared item"}]}]}]}]},
        {"type":"transclusionReference","attrs":{"sourcePageId":"5b0e7c1e-3f1a-4c57-9a52-0d7f6a3d0004","transclusionId":"block-1"}},
        {"type":"transclusionSource","content":[{"type":"paragraph","content":[{"type":"text","text":"no id"}]}]},
        {"type":"transclusionReference"},
        {"type":"transclusionSource"},
      ],
      markdown: [
        "Shared text.",
        "",
        "- shared item",
        "",
        "no id",
      ],
      html: "<div data-type=\"transclusionSource\" data-id=\"block-1\"><p>Shared text.</p><ul><li><p>shared item</p></li></ul></div><div data-type=\"transclusionReference\" data-source-page-id=\"5b0e7c1e-3f1a-4c57-9a52-0d7f6a3d0004\" data-transclusion-id=\"block-1\"></div><div data-type=\"transclusionSource\"><p>no id</p></div><div data-type=\"transclusionReference\"></div><div data-type=\"transclusionSource\"></div>",
    },
    {
      name: "a list of subpages and an embedded base leave nothing in Markdown",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"before"}]},
        {"type":"subpages"},
        {"type":"base","attrs":{"pageId":"5b0e7c1e-3f1a-4c57-9a52-0d7f6a3d0005"}},
        {"type":"base"},
        {"type":"base","attrs":{"pageId":"a\"b"}},
        {"type":"paragraph","content":[{"type":"text","text":"after"}]},
      ],
      markdown: [
        "before",
        "",
        "after",
      ],
      html: "<p>before</p><div data-type=\"subpages\"></div><div data-type=\"base-embed\" data-page-id=\"5b0e7c1e-3f1a-4c57-9a52-0d7f6a3d0005\"></div><div data-type=\"base-embed\" data-page-id=\"\"></div><div data-type=\"base-embed\" data-page-id=\"a&quot;b\"></div><p>after</p>",
    },
    {
      name: "footnotes",
      doc: [
        {"type":"paragraph","content":[{"type":"text","text":"First"},{"type":"footnoteReference","attrs":{"data-id":"a","referenceNumber":"1"}},{"type":"text","text":" and second"},{"type":"footnoteReference","attrs":{"data-id":"b","referenceNumber":"2"}},{"type":"text","text":"."}]},
        {"type":"footnotes","attrs":{"class":"footnotes"},"content":[{"type":"footnote","attrs":{"id":"fn:1","data-id":"a"},"content":[{"type":"paragraph","content":[{"type":"text","text":"The first note."}]}]},{"type":"footnote","attrs":{"id":"fn:2","data-id":"b"},"content":[{"type":"paragraph","content":[{"type":"text","text":"The second note,"}]},{"type":"paragraph","content":[{"type":"text","text":"in two paragraphs with "},{"type":"text","text":"bold","marks":[{"type":"bold"}]},{"type":"text","text":"."}]}]}]},
      ],
      markdown: [
        "First[^1] and second[^2].",
        "",
        "[^1]: The first note.",
        "[^2]: The second note,",
        "",
        "    in two paragraphs with **bold**.",
      ],
      html: "<p>First<sup id=\"fnref:1\"><a class=\"footnote-ref\" data-id=\"a\" data-reference-number=\"1\" href=\"#fn:1\">1</a></sup> and second<sup id=\"fnref:2\"><a class=\"footnote-ref\" data-id=\"b\" data-reference-number=\"2\" href=\"#fn:2\">2</a></sup>.</p><ol class=\"footnotes\"><li id=\"fn:1\" data-id=\"a\"><p>The first note.</p></li><li id=\"fn:2\" data-id=\"b\"><p>The second note,</p><p>in two paragraphs with <strong>bold</strong>.</p></li></ol>",
    },
    {
      name: "footnotes with parts missing, and a footnote on its own",
      doc: [
        {"type":"footnotes","content":[{"type":"footnote","content":[{"type":"paragraph","content":[{"type":"text","text":"no attrs"}]}]},{"type":"footnote","attrs":{"id":3,"data-id":true},"content":[]},{"type":"footnote"}]},
        {"type":"footnotes"},
        {"type":"footnote","attrs":{"id":"fn:9"},"content":[{"type":"paragraph","content":[{"type":"text","text":"stray note"}]}]},
      ],
      markdown: [
        "[^1]: no attrs",
        "[^2]: ",
        "[^3]: ",
        "",
        "stray note",
      ],
      html: "<ol class=\"footnotes\"><li><p>no attrs</p></li><li id=\"3\" data-id=\"true\"></li><li></li></ol><ol class=\"footnotes\"></ol><li id=\"fn:9\"><p>stray note</p></li>",
    },
  ],
  "documents": [
    {
      name: "a document inside a document, and text directly in the document",
      doc: [
        {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"inner document"}]}]},
        {"type":"text","text":"stray text","marks":[{"type":"bold"}]},
        {"type":"hardBreak"},
        {"type":"mathInline","attrs":{"text":"x"}},
        {"type":"paragraph","content":[{"type":"text","text":"end"}]},
      ],
      markdown: [
        "inner document",
        "",
        "end",
      ],
      html: "<p>inner document</p><strong>stray text</strong><br><span data-type=\"mathInline\" data-katex=\"true\">x</span><p>end</p>",
    },
    {
      name: "everything nested: a quote in a callout in a list in columns",
      doc: [
        {"type":"columns","attrs":{"layout":"two_equal"},"content":[{"type":"column","content":[{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"item"}]},{"type":"callout","attrs":{"type":"info"},"content":[{"type":"blockquote","content":[{"type":"paragraph","content":[{"type":"text","text":"deep "},{"type":"text","text":"quote","marks":[{"type":"italic"}]}]},{"type":"codeBlock","attrs":{"language":"sql"},"content":[{"type":"text","text":"SELECT 1;\n\nSELECT 2;"}]}]}]}]}]}]},{"type":"column","content":[{"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"done"}]},{"type":"orderedList","attrs":{"start":3},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"three"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"four"}]}]}]}]}]}]}]},
      ],
      markdown: [
        "- item",
        "",
        "  :::info",
        "  > deep *quote*",
        "  >",
        "  > ```sql",
        "  > SELECT 1;",
        "  >",
        "  > SELECT 2;",
        "  > ```",
        "  :::",
        "",
        "- [x] done",
        "  3. three",
        "  4. four",
      ],
      html: "<div data-type=\"columns\" data-layout=\"two_equal\"><div data-type=\"column\"><ul><li><p>item</p><div data-type=\"callout\" data-callout-type=\"info\"><blockquote><p>deep <em>quote</em></p><pre><code class=\"language-sql\">SELECT 1;\n\nSELECT 2;</code></pre></blockquote></div></li></ul></div><div data-type=\"column\"><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"true\"><p>done</p><ol start=\"3\"><li><p>three</p></li><li><p>four</p></li></ol></li></ul></div></div>",
    },
    {
      name: "leading and trailing empty blocks are trimmed from Markdown",
      doc: [
        {"type":"paragraph","content":[]},
        {"type":"subpages"},
        {"type":"paragraph","content":[{"type":"text","text":"middle"}]},
        {"type":"paragraph","content":[]},
        {"type":"transclusionReference"},
        {"type":"paragraph","content":[]},
      ],
      markdown: [
        "middle",
      ],
      html: "<p></p><div data-type=\"subpages\"></div><p>middle</p><p></p><div data-type=\"transclusionReference\"></div><p></p>",
    },
    {
      name: "right-to-left text, emoji sequences and astral characters in text and attributes",
      doc: [
        {"type":"heading","attrs":{"level":2,"id":"כותרת"},"content":[{"type":"text","text":"שלום עולם"}]},
        {"type":"paragraph","content":[{"type":"text","text":"مرحبا بالعالم","marks":[{"type":"bold"}]},{"type":"text","text":" 👨‍👩‍👧‍👦 🇯🇵 𝒳 𐌰"}]},
        {"type":"image","attrs":{"src":"https://example.com/图片.png","alt":"图片 😀"}},
        {"type":"status","attrs":{"text":"完了","color":"緑"}},
      ],
      markdown: [
        "## שלום עולם",
        "",
        "**مرحبا بالعالم** 👨‍👩‍👧‍👦 🇯🇵 𝒳 𐌰",
        "",
        "![图片 😀](https://example.com/图片.png)",
      ],
      html: "<h2 id=\"כותרת\">שלום עולם</h2><p><strong>مرحبا بالعالم</strong> 👨‍👩‍👧‍👦 🇯🇵 𝒳 𐌰</p><img src=\"https://example.com/图片.png\" alt=\"图片 😀\"><span data-type=\"status\" data-color=\"緑\">完了</span>",
    },
    {
      name: "unknown attributes on nodes are ignored",
      doc: [
        {"type":"paragraph","attrs":{"class":"x","style":"color:red","onclick":"alert(1)","data-foo":"bar"},"content":[{"type":"text","text":"p"}]},
        {"type":"heading","attrs":{"level":2,"class":"h"},"content":[{"type":"text","text":"h"}]},
        {"type":"image","attrs":{"src":"https://example.com/i.png","onerror":"alert(1)","caption":"ignored"}},
        {"type":"horizontalRule","attrs":{"class":"thick"}},
      ],
      markdown: [
        "p",
        "",
        "## h",
        "",
        "![](https://example.com/i.png)",
        "",
        "---",
      ],
      html: "<p>p</p><h2>h</h2><img src=\"https://example.com/i.png\"><hr>",
    },
  ],
};

for (const [group, cases] of Object.entries(CASES)) {
  describe(`export of ${group}`, () => {
    test.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
      const out = await exported(c.doc);
      expect(out.markdown.status).toBe(200);
      expect(out.markdown.text).toBe(`# T\n\n${c.markdown.join("\n")}\n`);
      expect(out.html.status).toBe(200);
      expect(out.html.text).toBe(HTML_HEAD + c.html + HTML_TAIL);
    });
  });
}

describe("export of documents the serializers cannot write", () => {
  test("a table without rows fails the Markdown export and is an empty table in HTML", async () => {
    const out = await exported([{ type: "paragraph", content: [{ type: "text", text: "before" }] }, { type: "table", content: [] }]);
    // Accident: the Markdown table writer takes the first row as the header without checking there is one.
    expect(out.markdown.status).toBe(500);
    expect(JSON.parse(out.markdown.text)).toEqual(apiError("internal_error", "Something went wrong"));
    expect(out.html.status).toBe(200);
    expect(out.html.text).toBe(`${HTML_HEAD}<p>before</p><div class="tableWrapper"><table><tbody></tbody></table></div>${HTML_TAIL}`);
    const noContent = await exported([{ type: "table" }]);
    expect(noContent.markdown.status).toBe(500);
    expect(noContent.html.text).toBe(`${HTML_HEAD}<div class="tableWrapper"><table><tbody></tbody></table></div>${HTML_TAIL}`);
  });

  test("a document of nothing exports as nothing", async () => {
    const out = await exported([]);
    expect(out.markdown.text).toBe("# T\n\n\n");
    expect(out.html.text).toBe(HTML_HEAD + HTML_TAIL);
  });

  test("the case table names every node and mark type of the schema", () => {
    const seen = { nodes: new Set<string>(), marks: new Set<string>() };
    const visit = (node: any) => {
      seen.nodes.add(node.type);
      for (const mark of node.marks ?? []) seen.marks.add(mark.type);
      for (const child of node.content ?? []) visit(child);
    };
    for (const c of Object.values(CASES).flat()) for (const node of c.doc) visit(node);
    expect([...seen.nodes].sort()).toEqual(
      [
        "attachment", "audio", "base", "blockquote", "bulletList", "callout", "codeBlock", "column", "columns", "details", "detailsContent",
        "detailsSummary", "doc", "drawio", "embed", "excalidraw", "footnote", "footnoteReference", "footnotes", "hardBreak", "heading",
        "horizontalRule", "image", "listItem", "mathBlock", "mathInline", "mention", "orderedList", "pageBreak", "paragraph", "pdf", "status",
        "subpages", "table", "tableCell", "tableHeader", "tableRow", "taskItem", "taskList", "text", "transclusionReference",
        "transclusionSource", "video", "youtube",
      ].sort(),
    );
    expect([...seen.marks].sort()).toEqual(["bold", "code", "comment", "highlight", "italic", "link", "strike", "subscript", "superscript", "textStyle", "underline"]);
  });
});

describe("POST /pages: what a document may contain", () => {
  // The cases above rely on this: unknown types are refused, unsafe addresses removed, everything else stored as sent.
  const create = (content: unknown) => owner.post("/pages", { spaceId, title: "T", content });
  const invalid = (message: string) => apiError("invalid_input", message);

  test("node and mark types outside the schema are refused", async () => {
    const unknownNode = await create({ type: "doc", content: [{ type: "marquee", content: [] }] });
    expect([unknownNode.status, unknownNode.body]).toEqual([400, invalid("content has an unknown node type")]);
    const unknownMark = await create({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "blink" }] }] }] });
    expect([unknownMark.status, unknownMark.body]).toEqual([400, invalid("content has an unknown mark")]);
    const notADoc = await create({ type: "paragraph", content: [] });
    expect([notADoc.status, notADoc.body]).toEqual([400, invalid("content must be a doc node")]);
  });

  test("unsafe addresses are emptied when the document is stored", async () => {
    const res = await create({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
        { type: "image", attrs: { src: "data:text/html;base64,PGI+", alt: "kept" } },
        { type: "image", attrs: { src: "data:image/png;base64,iVBORw0KGgo=" } },
        { type: "embed", attrs: { src: "vbscript:x" } },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.page.content).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "" } }] }] },
        { type: "image", attrs: { src: "", alt: "kept" } },
        { type: "image", attrs: { src: "data:image/png;base64,iVBORw0KGgo=" } },
        { type: "embed", attrs: { src: "" } },
      ],
    });
  });
});

describe("the plain text kept for search (pages.text_content)", () => {
  const p = (...content: unknown[]) => ({ type: "paragraph", content });
  const t_ = (text: string) => ({ type: "text", text });

  const textOf = async (doc: unknown[]) => {
    const created = await owner.post("/pages", { spaceId, title: "T", content: { type: "doc", content: doc } });
    expect(created.status).toBe(200);
    const [row] = await t.sql`SELECT text_content FROM pages WHERE id = ${created.body.data.page.id}`;
    return row.text_content as string;
  };

  test("is one line per block of text, with inline nodes as their text", async () => {
    const text = await textOf([
      { type: "heading", attrs: { level: 2 }, content: [t_("Title *x*")] },
      p(
        t_("Hello "),
        { type: "mention", attrs: { label: "Ada", entityType: "user" } },
        t_(" "),
        { type: "mathInline", attrs: { text: "x^2" } },
        { type: "status", attrs: { text: "DONE" } },
        { type: "footnoteReference", attrs: { referenceNumber: "1" } },
        { type: "hardBreak" },
        { type: "text", text: "next", marks: [{ type: "bold" }] },
      ),
      p(),
      p(t_("   ")),
      { type: "codeBlock", attrs: { language: "js" }, content: [t_("a\n  b")] },
      { type: "codeBlock", content: [] },
      { type: "bulletList", content: [{ type: "listItem", content: [p(t_("item")), { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p(t_("task"))] }] }] }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [p(t_("H1"))] }, { type: "tableCell", content: [p(t_("C1"))] }] }] },
      { type: "mathBlock", attrs: { text: "E=mc^2" } },
      { type: "mathBlock", attrs: { text: "" } },
      { type: "attachment", attrs: { url: "https://example.com/r.pdf", name: "report.pdf" } },
      { type: "attachment", attrs: { url: "https://example.com/unnamed" } },
      { type: "pdf", attrs: { src: "https://example.com/p.pdf", name: "paper.pdf" } },
      { type: "image", attrs: { src: "https://example.com/i.png", alt: "alt text is not kept" } },
      { type: "callout", attrs: { type: "info" }, content: [p(t_("note"))] },
      { type: "details", content: [{ type: "detailsSummary", content: [t_("Summary")] }, { type: "detailsContent", content: [p(t_("Inside"))] }] },
      { type: "blockquote", content: [p(t_("quoted"))] },
      { type: "columns", content: [{ type: "column", content: [p(t_("left"))] }, { type: "column", content: [p(t_("right"))] }] },
      { type: "transclusionSource", attrs: { id: "b1" }, content: [p(t_("synced"))] },
      { type: "footnotes", content: [{ type: "footnote", content: [p(t_("Note text"))] }] },
    ]);
    expect(text).toBe(
      ["Title *x*", "Hello Ada x^2DONE\nnext", "a\n  b", "item", "task", "H1", "C1", "E=mc^2", "report.pdf", "paper.pdf", "note", "Summary", "Inside", "quoted", "left", "right", "synced", "Note text"].join("\n"),
    );
  });

  test("is empty for an empty document, and misses text that sits beside a block inside a paragraph", async () => {
    expect(await textOf([p()])).toBe("");
    expect(await textOf([])).toBe("");
    // Accident: a paragraph that (against the schema) holds a block is walked as a container, and its own text is lost.
    expect(await textOf([p(t_("lost "), { type: "image", attrs: { src: "https://example.com/i.png" } }, t_(" too"))])).toBe("");
  });
});
