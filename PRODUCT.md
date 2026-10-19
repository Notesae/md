# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Windows 桌面应用中的 WebView2 界面；首版面向 Windows 11 x64，不作为托管网站发布。

## Stack

沿用 SPEC.md 的 Tauri 2 + Rust + TypeScript 路线；原生 TypeScript 界面，不引入完整编辑器或大型组件库。用户确认直接实现代码并运行验证。

## Users

在本地阅读 Markdown 的用户，尤其重视中文长文排版、启动速度与磁盘占用。

## Product Purpose

只读、快速、舒适地打开本地 Markdown；让用户控制包括 WebView 在内的应用数据位置。

## Operating Context

文件选择、拖放、命令行、文件关联打开文档；按需浏览目录。无需账号或网络。

## Capabilities and Constraints

功能和完整验收要求见 SPEC.md。首版包括阅读、搜索、目录、主题、阅读状态、文件变化刷新、存储管理及可恢复迁移；不做编辑、云同步或全文索引。

## Brand Commitments

产品暂称 MD / MdReader，正式名称未定。用户确认暖白纸面、墨绿点缀、安静三栏和深色模式。

## Evidence on Hand

SPEC.md 为需求与技术调查。不存在已验证的性能成绩，不宣传未测指标。

## Product Principles

- 阅读正文优先，昂贵增强按需执行。
- 数据位置由用户决定，不静默回退系统盘。
- 缓存可重建，状态独立保存，原文永不迁移或清理。
- 用实际桌面运行与性能样本验证质量。
