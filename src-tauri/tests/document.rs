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

// 缓存命中、正文变化和关闭持久缓存走同一只读文件路径，不允许陈旧正文覆盖新内容。
#[test]
fn document_cache_is_content_addressed_and_can_be_disabled() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    md_reader::storage::initialize_root(&root).unwrap();
    let path = temp.path().join("note.md");
    fs::write(&path, "# 第一篇").unwrap();
    let request = AtomicU64::new(1);
    let first =
        md_reader::document::read_document(&path, &request, 1, Some((&root, 1024 * 1024))).unwrap();
    assert!(!first.cache_hit);
    let second =
        md_reader::document::read_document(&path, &request, 1, Some((&root, 1024 * 1024))).unwrap();
    assert!(second.cache_hit);
    fs::write(&path, "# 新的正文").unwrap();
    let changed =
        md_reader::document::read_document(&path, &request, 1, Some((&root, 1024 * 1024))).unwrap();
    assert!(!changed.cache_hit);
    assert_eq!(changed.content.headings[0].title, "新的正文");
    md_reader::storage::clear_managed_child(&root, "cache").unwrap();
    md_reader::document::read_document(&path, &request, 1, None).unwrap();
    assert_eq!(fs::read_dir(root.join("cache")).unwrap().count(), 0);
}

// 段前插入新内容会改变目录编号，但原段的源块标识必须稳定以恢复阅读位置。
#[test]
fn block_identity_survives_preceding_insertions() {
    let request = AtomicU64::new(1);
    let before = parse_document("# 原标题\n\n目标段落。", &request, 1).unwrap();
    let after = parse_document("# 新增标题\n\n# 原标题\n\n目标段落。", &request, 1).unwrap();
    assert_eq!(before.block_hashes.len(), before.blocks.len());
    assert_eq!(after.block_hashes.len(), after.blocks.len());
    assert_eq!(before.block_hashes[1], after.block_hashes[2]);
}
