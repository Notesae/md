use md_reader::document::{parse_document, resolve_local_image};
use std::{fs, sync::atomic::AtomicU64};

// 全文仅解析一次，跨段引用、扩展语法和重复标题必须保持语义。
#[test]
fn renders_full_document_references_tables_tasks_and_math() {
    let input = "# 标题\n\n[跨段引用][ref]\n\n# 标题\n\n|列|值|\n|---|---|\n|甲|乙|\n\n- [x] 完成\n\n$x^2$\n\n[ref]: https://example.com\n";
    let document = parse_document(input, &AtomicU64::new(1), 1).unwrap();
    let html = document.blocks.join("");
    assert!(html.contains("<table>"));
    assert!(html.contains("checkbox"));
    assert!(html.contains("data-math"));
    assert!(html.contains("data-link=\"0\""));
    assert_eq!(document.links, ["https://example.com"]);
    assert_eq!(document.headings[0].title, "标题");
    assert_ne!(document.headings[0].id, document.headings[1].id);
    assert!(document.blocks.len() > 3);
}

// 文章 HTML 只能作为可读文本，不允许事件属性、脚本或自动发起网络请求。
#[test]
fn isolates_html_and_external_images() {
    let document = parse_document("<script>alert(1)</script>\n\n![图](https://example.com/pixel.png)\n\n[坏](javascript:alert%281%29)", &AtomicU64::new(1), 1).unwrap();
    let html = document.blocks.join("");
    assert!(!html.contains("<script>"));
    assert!(!html.contains("src="));
    assert!(!html.contains("href=\"javascript:"));
    assert!(document.images[0].remote);
}

#[test]
fn stale_parse_is_cancelled() {
    assert!(parse_document("# old", &AtomicU64::new(2), 1).is_err());
}

// 图片只能读取文档目录内的普通栅格文件；路径逃逸、SVG 与远程协议被拒绝。
#[test]
fn local_images_cannot_escape_the_document_folder() {
    let temp = tempfile::tempdir().unwrap();
    let article = temp.path().join("articles");
    fs::create_dir(&article).unwrap();
    fs::write(article.join("图.png"), b"png").unwrap();
    fs::write(temp.path().join("secret.png"), b"private").unwrap();
    assert!(resolve_local_image(&article, "%E5%9B%BE.png").is_ok());
    assert!(resolve_local_image(&article, "../secret.png").is_err());
    assert!(resolve_local_image(&article, "https://example.com/a.png").is_err());
    assert!(resolve_local_image(&article, "bad.svg").is_err());
}
