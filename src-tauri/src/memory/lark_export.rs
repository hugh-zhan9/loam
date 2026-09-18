//! Extract document text before the upstream plain-text chunker sees a Lark
//! CLI response. Ordinary JSON and literal escapes in document code stay intact.

use std::ops::Range;

use serde::Deserialize;
use serde_json::{value::RawValue, Value};

/// The raw offsets let the maintenance tool repair an existing chunk without
/// bringing back text from a neighbouring chunk the user already deleted.
pub struct LarkDocument {
    text: String,
    offsets: Vec<(usize, usize)>,
}

impl LarkDocument {
    pub fn parse(source: &str) -> Result<Option<Self>, String> {
        let Ok(value) = serde_json::from_str::<Value>(source) else {
            return Ok(None);
        };
        let Some(data) = value.get("data") else {
            return Ok(None);
        };
        if !data.get("doc_id").is_some_and(Value::is_string)
            || !value.get("ok").is_some_and(Value::is_boolean)
        {
            return Ok(None);
        }
        if value["ok"] != true {
            return Err("the Lark document export did not succeed".into());
        }
        if !data.get("markdown").is_some_and(Value::is_string) {
            return Err("the Lark document export has no markdown text".into());
        }
        #[derive(Deserialize)]
        struct Envelope<'a> {
            #[serde(borrow)]
            data: Body<'a>,
        }
        #[derive(Deserialize)]
        struct Body<'a> {
            #[serde(borrow)]
            markdown: &'a RawValue,
        }
        let envelope: Envelope<'_> = serde_json::from_str(source).map_err(|e| e.to_string())?;
        let raw = envelope.data.markdown.get();
        let base = raw.as_ptr() as usize - source.as_ptr() as usize;
        let mut text = String::new();
        let mut offsets = Vec::new();
        let mut i = 1; // Opening JSON string quote.
        while i < raw.len() - 1 {
            let start = i;
            let decoded = if raw.as_bytes()[i] == b'\\' {
                let mut end = i + if raw.as_bytes()[i + 1] == b'u' { 6 } else { 2 };
                if raw.as_bytes()[i + 1] == b'u' {
                    let code =
                        u16::from_str_radix(&raw[i + 2..end], 16).map_err(|e| e.to_string())?;
                    if (0xd800..=0xdbff).contains(&code) {
                        end += 6; // The complete JSON parser already validated the pair.
                    }
                }
                let decoded: String = serde_json::from_str(&format!("\"{}\"", &raw[i..end]))
                    .map_err(|e| e.to_string())?;
                i = end;
                decoded
            } else {
                let ch = raw[i..].chars().next().expect("validated JSON string");
                i += ch.len_utf8();
                ch.to_string()
            };
            // An entry per UTF-8 byte makes later Markdown slices inexpensive.
            offsets.extend(std::iter::repeat_n((base + start, base + i), decoded.len()));
            text.push_str(&decoded);
        }
        Ok(Some(Self { text, offsets }))
    }

    pub fn readable(&self) -> String {
        self.readable_range(0..usize::MAX)
    }

    pub fn readable_range(&self, range: Range<usize>) -> String {
        let mut output = String::new();
        let mut i = 0;
        let mut table = false;
        let mut fence: Option<(char, usize)> = None;
        let mut inline_ticks = 0;
        let mut line_start = true;
        let mut indent = 0;
        while i < self.text.len() {
            let rest = &self.text[i..];
            let ch = rest.chars().next().expect("text remaining");
            let mut end = i + ch.len_utf8();
            let mut replacement = ch.to_string();
            let fence_run = if line_start && matches!(ch, '`' | '~') {
                rest.chars().take_while(|c| *c == ch).count()
            } else {
                0
            };
            if fence_run >= 3 {
                let count = fence_run;
                match fence {
                    None => fence = Some((ch, count)),
                    Some((marker, width))
                        if marker == ch
                            && count >= width
                            && rest[count..]
                                .split('\n')
                                .next()
                                .unwrap_or("")
                                .trim()
                                .is_empty() =>
                    {
                        fence = None
                    }
                    _ => {}
                }
                end = i + count;
                replacement = self.text[i..end].into();
            } else if fence.is_none() && ch == '`' {
                let count = rest.chars().take_while(|c| *c == '`').count();
                if inline_ticks == 0 {
                    inline_ticks = count;
                } else if inline_ticks == count {
                    inline_ticks = 0;
                }
                end = i + count;
                replacement = self.text[i..end].into();
            } else if fence.is_none() && inline_ticks == 0 && ch == '<' {
                if let Some(close) = rest.find('>') {
                    let tag = &rest[1..close];
                    let name = tag.split_whitespace().next().unwrap_or("");
                    let converted = match name {
                        "lark-table" => {
                            table = true;
                            Some("\n")
                        }
                        "/lark-table" => {
                            table = false;
                            Some("\n")
                        }
                        "lark-tr" => Some("\n| "),
                        "/lark-tr" => Some("\n"),
                        "lark-td" => Some(""),
                        "/lark-td" => Some(" | "),
                        "quote-container" | "/quote-container" => Some("\n"),
                        "mark" | "/mark" => Some(""),
                        _ => None,
                    };
                    if let Some(value) = converted {
                        end = i + close + 1;
                        replacement = value.into();
                    }
                }
            } else if table && fence.is_none() && inline_ticks == 0 && ch.is_whitespace() {
                replacement = " ".into();
            }
            // Whole escape sequences and tags are atomic, even at old chunk boundaries.
            if self.offsets[i].0 < range.end && self.offsets[end - 1].1 > range.start {
                let replacement =
                    if table && fence.is_none() && inline_ticks == 0 && output.ends_with(' ') {
                        replacement.trim_start_matches(' ')
                    } else {
                        &replacement
                    };
                output.push_str(replacement);
            }
            if ch == '\n' {
                line_start = true;
                indent = 0;
            } else if line_start && ch == ' ' && indent < 3 {
                indent += 1;
            } else {
                line_start = false;
            }
            i = end;
        }
        output.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn export(markdown: &str) -> String {
        serde_json::json!({"ok":true,"data":{"doc_id":"doc-1","markdown":markdown}}).to_string()
    }

    #[test]
    fn decodes_json_once_and_converts_table_markup() {
        let raw = r#"{"ok":true,"data":{"doc_id":"doc-1","markdown":"标题\n\u003clark-table rows=\"1\"\u003e\n<lark-tr>\n<lark-td>\n字段\n</lark-td><lark-td>值 ✅</lark-td></lark-tr></lark-table>\n`C:\\new`"}}"#;
        let text = LarkDocument::parse(raw).unwrap().unwrap().readable();
        assert!(text.contains("| 字段 | 值 ✅ |"), "{text}");
        assert!(
            text.ends_with(r"`C:\new`"),
            "literal code escapes must survive: {text}"
        );
        assert!(!text.contains("lark-"));
        assert!(!text.contains("doc-1"));
    }

    #[test]
    fn leaves_other_json_and_plain_text_alone_and_rejects_failed_exports() {
        for raw in [
            r#"{"path":"C:\\new","markdown":"text"}"#,
            r"literal \n",
            "{bad",
        ] {
            assert!(LarkDocument::parse(raw).unwrap().is_none());
        }
        assert!(
            LarkDocument::parse(r#"{"ok":false,"data":{"doc_id":"d","markdown":"bad"}}"#).is_err()
        );
        assert!(LarkDocument::parse(r#"{"ok":true,"data":{"doc_id":"d"}}"#).is_err());
        assert_eq!(
            LarkDocument::parse(&export(""))
                .unwrap()
                .unwrap()
                .readable(),
            ""
        );
    }

    #[test]
    fn preserves_code_examples_and_unknown_html_as_text() {
        let code = "```xml\n<lark-td>literal</lark-td>\n```\n`<lark-tr>`\n<script>text</script>";
        assert_eq!(
            LarkDocument::parse(&export(code))
                .unwrap()
                .unwrap()
                .readable(),
            code
        );
    }

    #[test]
    fn preserves_nonclosing_fences_and_spaces_in_table_code() {
        let code = "```text\n```not-a-closing-fence\n<lark-td>literal</lark-td>\n```";
        assert_eq!(
            LarkDocument::parse(&export(code))
                .unwrap()
                .unwrap()
                .readable(),
            code
        );
        for indentation in ["    ", "\t"] {
            let code = format!("```markdown\n{indentation}```\n<lark-td>literal</lark-td>\n```");
            assert_eq!(
                LarkDocument::parse(&export(&code))
                    .unwrap()
                    .unwrap()
                    .readable(),
                code
            );
        }
        let table = "<lark-table><lark-tr><lark-td>`a  b`</lark-td></lark-tr></lark-table>";
        assert!(LarkDocument::parse(&export(table))
            .unwrap()
            .unwrap()
            .readable()
            .contains("`a  b`"));
    }

    #[test]
    fn old_ranges_do_not_leak_json_envelopes_or_partial_escapes_and_tags() {
        let raw = r#"{"ok":true,"data":{"doc_id":"d","markdown":"A\n\u003clark-td\u003e中\ud83d\ude00</lark-td>B"}}"#;
        let document = LarkDocument::parse(raw).unwrap().unwrap();
        let start = raw.find("lark-td").unwrap() + 2;
        let end = raw.find("</lark-td>").unwrap() + 4;
        assert_eq!(document.readable_range(start..end), "中😀 |");
        assert_eq!(
            document.readable_range(0..raw.find("markdown").unwrap()),
            ""
        );
    }
}
