use percent_encoding::percent_decode_str;
use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};

/// 正文目录使用受控标识，忽略原始 HTML 及用户自定义事件属性。
#[derive(Debug, Clone, Serialize)]
pub struct Heading {
    pub id: String,
    pub title: String,
    pub level: u8,
    pub block: usize,
}

/// 图片先作为惰性资源返回；远程地址默认不会转换成浏览器请求。
#[derive(Debug, Clone, Serialize)]
pub struct Image {
    pub url: String,
    pub remote: bool,
}

/// 全文解析的结果按合法顶层块传输，不按固定行数破坏跨块引用。
#[derive(Debug, Clone, Serialize)]
pub struct ParsedDocument {
    pub blocks: Vec<String>,
    pub headings: Vec<Heading>,
    pub images: Vec<Image>,
    pub links: Vec<String>,
}

/// 打开文件的可观测结果，分别记录读盘和解析耗时，供性能验收使用。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub path: String,
    pub title: String,
    pub bytes: u64,
    pub revision: u64,
    pub read_ms: f64,
    pub parse_ms: f64,
    #[serde(flatten)]
    pub content: ParsedDocument,
}

/// 生成内部 HTML 属性和文本时统一转义，不能把文章内容拼接为活动标记。
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// 仅一次解析和一次 HTML 渲染；块标记由程序生成，原文 HTML 一律转义。
pub fn parse_document(
    source: &str,
    request: &AtomicU64,
    revision: u64,
) -> Result<ParsedDocument, String> {
    const BOUNDARY: &str = "<md-block-boundary></md-block-boundary>";
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_MATH
        | Options::ENABLE_GFM;
    let parser = Parser::new_ext(source.trim_start_matches('\u{feff}'), options);
    let mut events = Vec::new();
    let mut headings: Vec<Heading> = Vec::new();
    let mut images = Vec::new();
    let mut links = Vec::new();
    let mut depth = 0usize;
    let mut block = 0;
    let mut started = false;
    let mut heading: Option<usize> = None;
    for (index, event) in parser.enumerate() {
        if index % 256 == 0 && request.load(Ordering::Relaxed) != revision {
            return Err("打开请求已被更新的文档取代。".into());
        }
        if depth == 0 && started {
            events.push(Event::Html(BOUNDARY.into()));
            block += 1;
        }
        started = true;
        match &event {
            Event::Start(_) => depth += 1,
            Event::End(_) => depth = depth.saturating_sub(1),
            _ => {}
        }
        if let Some(active) = heading {
            match &event {
                Event::Text(text) | Event::Code(text) | Event::InlineMath(text) => {
                    headings[active].title.push_str(text)
                }
                Event::SoftBreak | Event::HardBreak => headings[active].title.push(' '),
                _ => {}
            }
        }
        let safe = match event {
            Event::Html(text) | Event::InlineHtml(text) => Event::Text(text),
            Event::Start(Tag::Heading { level, .. }) => {
                let id = format!("md-h-{}", headings.len());
                heading = Some(headings.len());
                headings.push(Heading { id: id.clone(), title: String::new(), level: level as u8, block });
                Event::Html(format!("<h{} id=\"{id}\">", level as u8).into())
            }
            Event::End(TagEnd::Heading(level)) => {
                heading = None;
                Event::Html(format!("</h{}>\n", level as u8).into())
            }
            Event::Start(Tag::Link { dest_url, .. }) => {
                let index = links.len();
                links.push(dest_url.to_string());
                Event::Html(format!("<a href=\"#md-link\" data-link=\"{index}\">" ).into())
            }
            Event::End(TagEnd::Link) => Event::Html("</a>".into()),
            Event::Start(Tag::Image { dest_url, .. }) => {
                let index = images.len();
                let remote = dest_url.starts_with("https://") || dest_url.starts_with("http://");
                images.push(Image { url: dest_url.into_string(), remote });
                Event::Html(format!("<span class=\"image-slot\" data-image=\"{index}\">" ).into())
            }
            Event::End(TagEnd::Image) => Event::Html("</span>".into()),
            Event::InlineMath(text) => Event::Html(CowStr::from(format!("<span class=\"math\" data-math=\"{}\" data-display=\"false\">{}</span>", escape(&text), escape(&text)))),
            Event::DisplayMath(text) => Event::Html(CowStr::from(format!("<span class=\"math display-math\" data-math=\"{}\" data-display=\"true\">{}</span>", escape(&text), escape(&text)))),
            other => other,
        };
        events.push(safe);
    }
    if request.load(Ordering::Relaxed) != revision {
        return Err("打开请求已取消。".into());
    }
    let mut output = String::with_capacity(source.len());
    html::push_html(&mut output, events.into_iter());
    Ok(ParsedDocument {
        blocks: output
            .split(BOUNDARY)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
        headings,
        images,
        links,
    })
}

pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| ["md", "markdown", "mdown"].contains(&s.to_ascii_lowercase().as_str()))
}

/// 分块读盘可取消，正文只接受 UTF-8；128MiB 上限避免意外打开二进制或超大文件耗尽内存。
pub fn read_document(path: &Path, request: &AtomicU64, revision: u64) -> Result<Document, String> {
    if !is_markdown(path) {
        return Err("请选择 .md、.markdown 或 .mdown 文件。".into());
    }
    let start = Instant::now();
    let mut file = fs::File::open(path).map_err(|e| format!("无法打开文章：{e}"))?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if size > 128 * 1024 * 1024 {
        return Err("当前版本支持最大 128MiB 的 Markdown 文件。".into());
    }
    let mut data = Vec::with_capacity(size as usize);
    let mut buffer = [0; 64 * 1024];
    loop {
        if request.load(Ordering::Relaxed) != revision {
            return Err("打开请求已取消。".into());
        }
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        data.extend_from_slice(&buffer[..count]);
        if data.len() > 128 * 1024 * 1024 {
            return Err("文件在读取期间超过 128MiB。".into());
        }
    }
    let source = String::from_utf8(data).map_err(|_| "文章不是有效 UTF-8，请先转换文件编码。")?;
    let read_ms = start.elapsed().as_secs_f64() * 1000.0;
    let parse_start = Instant::now();
    let content = parse_document(&source, request, revision)?;
    Ok(Document {
        path: path.to_string_lossy().into_owned(),
        title: path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        bytes: size,
        revision,
        read_ms,
        parse_ms: parse_start.elapsed().as_secs_f64() * 1000.0,
        content,
    })
}

/// 解码并规范化本地附件，拒绝网络地址、活动格式和文档目录之外的路径。
pub fn resolve_local_image(directory: &Path, url: &str) -> Result<PathBuf, String> {
    let decoded = percent_decode_str(url)
        .decode_utf8()
        .map_err(|_| "图片路径编码无效。")?;
    if decoded.contains(':') || decoded.starts_with('/') || decoded.starts_with('\\') {
        return Err("本地图片必须使用文档目录内的相对路径。".into());
    }
    let root = fs::canonicalize(directory).map_err(|e| e.to_string())?;
    let image =
        fs::canonicalize(root.join(decoded.as_ref())).map_err(|e| format!("图片不存在：{e}"))?;
    let extension = image
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !image.starts_with(&root)
        || !image.is_file()
        || !["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"].contains(&extension.as_str())
    {
        return Err("图片超出文章目录，或格式不受支持（不执行 SVG/HTML）。".into());
    }
    Ok(image)
}
